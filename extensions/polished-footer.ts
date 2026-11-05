import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const CODEX_PROVIDER = "openai-codex";
const CODEX_USAGE_STATUS = "openai-codex-usage";
const CODEX_POOL_STATUS = "codex-pool";
const DEEPSEEK_PROVIDER = "deepseek";
const DEEPSEEK_USAGE_STATUS = "deepseek-usage";
const COLUMN_GAP = 3;

/**
 * DeepSeek peak windows in UTC hours, Monday through Friday. Off-peak bills at
 * half the catalog price, and the catalog only carries the peak price. Chinese
 * public holidays are off-peak too; without a holiday calendar they read as peak.
 */
const DEEPSEEK_PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [[1, 4], [6, 10]];

type Theme = ExtensionContext["ui"]["theme"];
type UsageLike = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
};

function compactNumber(value: number): string {
	if (value < 1_000) return `${Math.round(value)}`;
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

function compactPath(cwd: string): string {
	const home = homedir();
	const resolvedCwd = resolve(cwd);
	const relativeToHome = relative(resolve(home), resolvedCwd);
	const insideHome = relativeToHome === ""
		|| (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!insideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function leafPath(cwd: string): string {
	const resolvedCwd = resolve(cwd);
	return resolvedCwd === resolve(homedir()) ? "~" : basename(resolvedCwd) || cwd;
}

function cleanStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function separator(theme: Theme): string {
	return theme.fg("dim", " · ");
}

function join(parts: Array<string | undefined>, theme: Theme): string {
	return parts.filter((part): part is string => Boolean(part)).join(separator(theme));
}

function usageColor(percent: number): "success" | "warning" | "error" {
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

function cacheHitColor(percent: number): "success" | "accent" | "warning" | "error" {
	if (percent >= 90) return "success";
	if (percent >= 70) return "accent";
	if (percent >= 40) return "warning";
	return "error";
}

function colorizePercentages(text: string, theme: Theme): string {
	return text.replace(/(\d+(?:\.\d+)?)%/g, (match, value: string) =>
		theme.fg(usageColor(Number(value)), match));
}

function rightAligned(text: string, width: number): string {
	const clamped = truncateToWidth(text, width, "…");
	return `${" ".repeat(Math.max(0, width - visibleWidth(clamped)))}${clamped}`;
}

function variants(...values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function fitVariant(values: string[], width: number): string {
	for (const value of values) {
		if (visibleWidth(value) <= width) return value;
	}
	return truncateToWidth(values.at(-1) ?? "", width, "…");
}

function responsiveColumns(left: string[], right: string[], width: number): string[] {
	if (right.length === 0) return [fitVariant(left, width)];

	// Prefer richer variants and degrade both sides evenly before hiding a field.
	const pairs: Array<{ leftIndex: number; rightIndex: number }> = [];
	for (let leftIndex = 0; leftIndex < left.length; leftIndex++) {
		for (let rightIndex = 0; rightIndex < right.length; rightIndex++) {
			pairs.push({ leftIndex, rightIndex });
		}
	}
	pairs.sort((first, second) => {
		const firstLoss = first.leftIndex + first.rightIndex;
		const secondLoss = second.leftIndex + second.rightIndex;
		return firstLoss - secondLoss
			|| Math.max(first.leftIndex, first.rightIndex) - Math.max(second.leftIndex, second.rightIndex)
			|| first.leftIndex - second.leftIndex;
	});

	for (const { leftIndex, rightIndex } of pairs) {
		const leftText = left[leftIndex];
		const rightText = right[rightIndex];
		const contentWidth = visibleWidth(leftText) + COLUMN_GAP + visibleWidth(rightText);
		if (contentWidth <= width) {
			return [`${leftText}${" ".repeat(width - visibleWidth(leftText) - visibleWidth(rightText))}${rightText}`];
		}
	}

	// When no meaningful single-line form fits, reflow instead of crushing a field.
	return [fitVariant(left, width), rightAligned(fitVariant(right, width), width)];
}

type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
type CostLike = { total?: number };

function addUsage(totals: Totals, usage: UsageLike | undefined): void {
	if (!usage) return;
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
}

function isDeepseekPeak(timestamp: number): boolean {
	const date = new Date(timestamp);
	const day = date.getUTCDay();
	if (day === 0 || day === 6) return false;
	const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
	return DEEPSEEK_PEAK_WINDOWS.some(([start, end]) => hour >= start && hour < end);
}

/** `usage.cost.total` is priced at catalog rates; DeepSeek's off-peak rate is half of that. */
function messageCost(cost: CostLike | undefined, provider: string, timestamp: number): number {
	const total = cost?.total ?? 0;
	if (total === 0) return 0;
	return provider === DEEPSEEK_PROVIDER && !isDeepseekPeak(timestamp) ? total / 2 : total;
}

function sessionUsage(ctx: ExtensionContext): Totals & { cacheHit?: number } {
	const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let cacheHit: number | undefined;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message;
			const usage = message.usage as UsageLike;
			addUsage(totals, usage);
			totals.cost += messageCost(message.usage?.cost, message.provider, message.timestamp);
			const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
			if (promptTokens > 0) cacheHit = ((usage.cacheRead ?? 0) / promptTokens) * 100;
			continue;
		}
		if (entry.type === "message" && entry.message.role === "toolResult") {
			const message = entry.message;
			addUsage(totals, message.usage);
			// Nested model calls report catalog price; they carry no provider to tier.
			totals.cost += messageCost(message.usage?.cost, "", message.timestamp);
			continue;
		}
		if (entry.type === "branch_summary" || entry.type === "compaction" || entry.type === "usage") {
			addUsage(totals, entry.usage as UsageLike | undefined);
			totals.cost += (entry.usage as { cost?: CostLike } | undefined)?.cost?.total ?? 0;
		}
	}

	return { ...totals, ...(cacheHit === undefined ? {} : { cacheHit }) };
}

function formatCost(value: number): string {
	if (value < 0.01) return value.toFixed(4);
	if (value < 1) return value.toFixed(3);
	return value.toFixed(2);
}

function thinkingColor(level: string | undefined):
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "thinkingMax" {
	switch (level) {
		case "minimal": return "thinkingMinimal";
		case "low": return "thinkingLow";
		case "medium": return "thinkingMedium";
		case "high": return "thinkingHigh";
		case "xhigh": return "thinkingXhigh";
		case "max": return "thinkingMax";
		default: return "thinkingOff";
	}
}

export default function polishedFooter(pi: ExtensionAPI): void {
	let cached: { leaf: string | null; usage: ReturnType<typeof sessionUsage>; name: string | undefined } | undefined;
	pi.on("session_tree", () => { cached = undefined; });
	pi.on("session_info_changed", () => { cached = undefined; });
	pi.on("session_shutdown", () => { cached = undefined; });
	pi.on("session_start", (_event, ctx) => {
		cached = undefined;
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					if (width <= 0) return [];

					const leaf = ctx.sessionManager.getLeafId();
					if (!cached || cached.leaf !== leaf) {
						cached = { leaf, usage: sessionUsage(ctx), name: pi.getSessionName() };
					}
					const branch = footerData.getGitBranch();
					const sessionName = cached.name;
					const workspace = variants(
						join([
							theme.fg("accent", compactPath(ctx.cwd)),
							branch ? theme.fg("success", branch) : undefined,
							sessionName ? theme.fg("muted", sessionName) : undefined,
						], theme),
						join([
							theme.fg("accent", leafPath(ctx.cwd)),
							branch ? theme.fg("success", branch) : undefined,
						], theme),
						theme.fg("accent", leafPath(ctx.cwd)),
					);

					const model = ctx.model;
					const modelProvider = model && model.provider !== CODEX_PROVIDER && model.provider !== CODEX_POOL_STATUS
						? theme.fg("dim", model.provider)
						: undefined;
					const thinking = model?.reasoning
						? theme.fg(thinkingColor(ctx.thinkingLevel), ctx.thinkingLevel ?? "off")
						: undefined;
					const modelInfo = model
						? variants(
							join([modelProvider, theme.fg("text", model.id), thinking], theme),
							join([theme.fg("text", model.id), thinking], theme),
							theme.fg("text", model.id),
						)
						: variants(theme.fg("dim", "no model"));

					const usage = cached.usage;
					const inputMetric = usage.input > 0
						? theme.fg("accent", `${compactNumber(usage.input)} in`)
						: undefined;
					const outputMetric = usage.output > 0
						? theme.fg("success", `${compactNumber(usage.output)} out`)
						: undefined;
					const hitMetric = usage.cacheHit === undefined
						? undefined
						: theme.fg(cacheHitColor(usage.cacheHit), `${usage.cacheHit.toFixed(1)}% cache hit`);
					const costMetric = usage.cost > 0
						? theme.fg("warning", `$${formatCost(usage.cost)}`)
						: undefined;
					const fullMetrics = join([inputMetric, outputMetric, hitMetric, costMetric], theme);
					const metrics = usage.input > 0 || usage.output > 0 || hitMetric
						? variants(
							// "tokens" labels the input count, so it stays glued to the value.
							inputMetric ? `${theme.fg("dim", "tokens ")}${fullMetrics}` : fullMetrics,
							fullMetrics,
							join([inputMetric, outputMetric, costMetric], theme),
							join([inputMetric, outputMetric], theme),
						)
						: variants(theme.fg("dim", "no usage yet"));

					const context = ctx.getContextUsage();
					const contextPercent = context?.percent;
					const contextPercentText = contextPercent == null ? "?" : `${contextPercent.toFixed(1)}%`;
					const contextColor = contextPercent == null ? "muted" : usageColor(contextPercent);
					const contextText = context
						? `${theme.fg("dim", "context ")}${theme.fg(contextColor, contextPercentText)}${theme.fg("dim", " used")}`
						: undefined;
					const compactContextText = context
						? `${theme.fg("dim", "ctx ")}${theme.fg(contextColor, contextPercentText)}${theme.fg("dim", " used")}`
						: undefined;

					const statuses = footerData.getExtensionStatuses();
					const poolStatus = model?.provider === CODEX_POOL_STATUS ? statuses.get(CODEX_POOL_STATUS) : undefined;
					const poolQuota = poolStatus ? theme.fg("dim", cleanStatus(poolStatus)).replace(
						/(\d+(?:\.\d+)?)%/g,
						(match, value: string) => theme.fg(usageColor(100 - Number(value)), match),
					) : undefined;
					const codexUsage = statuses.get(CODEX_USAGE_STATUS);
					const coloredCodexUsage = codexUsage ? colorizePercentages(cleanStatus(codexUsage), theme) : undefined;
					const quota = coloredCodexUsage
						? `${theme.fg("dim", "quota used ")}${coloredCodexUsage}`
						: undefined;
					const deepseekUsage = statuses.get(DEEPSEEK_USAGE_STATUS);
					// Label and value belong to one phrase, so no separator between them.
					const balance = deepseekUsage
						? `${theme.fg("dim", "balance ")}${cleanStatus(deepseekUsage)}`
						: undefined;
					const resourceInfo = variants(
						join([contextText, poolQuota ?? quota, balance], theme),
						join([compactContextText, poolQuota ?? quota, balance], theme),
						join([compactContextText, balance], theme),
						balance,
						compactContextText,
					);

					const lines = [
						...responsiveColumns(workspace, modelInfo, width),
						...responsiveColumns(metrics, resourceInfo, width),
					];

					for (const [key, text] of [...statuses.entries()].sort(([left], [right]) => left.localeCompare(right))) {
						if (key === CODEX_USAGE_STATUS || key === CODEX_POOL_STATUS || key === DEEPSEEK_USAGE_STATUS) continue;
						const statusText = cleanStatus(text);
						lines.push(fitVariant(variants(join([theme.fg("dim", key), statusText], theme), statusText), width));
					}
					return lines;
				},
			};
		});
	});
}

/**
 * DeepSeek balance in the footer.
 *
 * Publishes the prepaid balance of the active DeepSeek account through
 * ctx.ui.setStatus("deepseek-usage", "¥39.79"), so any footer renderer can show
 * it. polished-footer.ts folds it into the right column; without that renderer
 * the status still appears as its own footer line.
 *
 * Balance only changes on spend or top-up, so this refreshes on session start,
 * after each settled turn, and on a slow timer.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "deepseek";
const STATUS_KEY = "deepseek-usage";
const REFRESH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

type Balance = {
	currency: string;
	total: number;
	granted: number;
	toppedUp: number;
};

type Snapshot = {
	available: boolean;
	balances: Balance[];
	fetchedAt: number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asAmount(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function parseSnapshot(payload: unknown): Snapshot {
	const root = asRecord(payload);
	if (!root) throw new Error("DeepSeek balance response is not an object");

	const infos = root.balance_infos;
	if (!Array.isArray(infos)) throw new Error("DeepSeek balance response has no balance_infos");

	const balances: Balance[] = [];
	for (const raw of infos) {
		const info = asRecord(raw);
		if (!info) continue;
		const total = asAmount(info.total_balance);
		const currency = typeof info.currency === "string" ? info.currency : undefined;
		if (total === undefined || !currency) continue;
		balances.push({
			currency,
			total,
			granted: asAmount(info.granted_balance) ?? 0,
			toppedUp: asAmount(info.topped_up_balance) ?? 0,
		});
	}

	return { available: root.is_available !== false, balances, fetchedAt: Date.now() };
}

function currencySymbol(currency: string): string {
	switch (currency.toUpperCase()) {
		case "CNY": return "¥";
		case "USD": return "$";
		case "EUR": return "€";
		default: return `${currency} `;
	}
}

function formatAmount(value: number): string {
	return value >= 1000 ? value.toFixed(0) : value.toFixed(2);
}

/** Keep the line short: show the first balance (DeepSeek accounts are single-currency). */
function formatBalance(snapshot: Snapshot): string {
	const balance = snapshot.balances[0];
	if (!balance) return snapshot.available ? "no balance info" : "unavailable";
	const text = `${currencySymbol(balance.currency)}${formatAmount(balance.total)}`;
	if (!snapshot.available) return `${text} (unavailable)`;
	return balance.granted > 0 ? `${text} (grant ${formatAmount(balance.granted)})` : text;
}

function isDeepseekContext(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === PROVIDER_ID;
}

async function fetchBalance(ctx: ExtensionContext, signal: AbortSignal): Promise<Snapshot> {
	const model = ctx.model;
	if (!model || model.provider !== PROVIDER_ID) throw new Error("active model is not a DeepSeek model");

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error("no DeepSeek API key configured");

	const baseUrl = (auth.baseUrl ?? model.baseUrl).replace(/\/+$/, "");
	const response = await fetch(`${baseUrl}/user/balance`, {
		headers: { Authorization: `Bearer ${auth.apiKey}`, Accept: "application/json" },
		signal,
	});
	if (!response.ok) throw new Error(`DeepSeek balance request failed (HTTP ${response.status})`);

	const body = await response.text();
	if (body.length > MAX_RESPONSE_BYTES) throw new Error("DeepSeek balance response is too large");

	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		throw new Error("DeepSeek balance response is not valid JSON");
	}
	return parseSnapshot(payload);
}

export default function deepseekUsage(pi: ExtensionAPI): void {
	let activeContext: ExtensionContext | undefined;
	let lastSnapshot: Snapshot | undefined;
	let lastAttemptAt = 0;
	let refreshFailed = false;
	let generation = 0;
	let interval: ReturnType<typeof setInterval> | undefined;
	let inFlight: { generation: number; promise: Promise<Snapshot> } | undefined;
	const controllers = new Set<AbortController>();

	const publish = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (lastSnapshot) ctx.ui.setStatus(STATUS_KEY, formatBalance(lastSnapshot));
		else ctx.ui.setStatus(STATUS_KEY, refreshFailed ? "unavailable" : undefined);
	};

	const load = (ctx: ExtensionContext, current: number): Promise<Snapshot> => {
		if (inFlight?.generation === current) return inFlight.promise;

		lastAttemptAt = Date.now();
		const controller = new AbortController();
		controllers.add(controller);
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		const request = fetchBalance(ctx, controller.signal).finally(() => {
			clearTimeout(timeout);
			controllers.delete(controller);
			if (inFlight?.promise === request) inFlight = undefined;
		});
		inFlight = { generation: current, promise: request };
		return request;
	};

	const refresh = async (ctx: ExtensionContext, force = false): Promise<void> => {
		activeContext = ctx;
		if (!ctx.hasUI || !isDeepseekContext(ctx)) {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const current = generation;
		if (!force && inFlight?.generation !== current
			&& Date.now() - Math.max(lastSnapshot?.fetchedAt ?? 0, lastAttemptAt) < REFRESH_INTERVAL_MS) {
			publish(ctx);
			return;
		}

		try {
			const snapshot = await load(ctx, current);
			if (current !== generation) return;
			lastSnapshot = snapshot;
			refreshFailed = false;
			if (activeContext) publish(activeContext);
		} catch {
			if (current !== generation) return;
			refreshFailed = true;
			if (activeContext) publish(activeContext);
		}
	};

	const start = (ctx: ExtensionContext): void => {
		generation += 1;
		activeContext = ctx;
		lastSnapshot = undefined;
		lastAttemptAt = 0;
		refreshFailed = false;
		for (const controller of controllers) controller.abort();
		controllers.clear();
		if (interval) clearInterval(interval);
		interval = undefined;

		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		if (!ctx.hasUI || !isDeepseekContext(ctx)) return;

		void refresh(ctx);
		interval = setInterval(() => {
			if (activeContext) void refresh(activeContext);
		}, REFRESH_INTERVAL_MS);
		interval.unref?.();
	};

	pi.on("session_start", (_event, ctx) => {
		// Balance does not depend on the session, so a resumed session starts fresh.
		lastSnapshot = undefined;
		start(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		if (ctx.hasUI && isDeepseekContext(ctx) && interval) void refresh(ctx);
		else start(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.hasUI && isDeepseekContext(ctx)) void refresh(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		generation += 1;
		activeContext = undefined;
		for (const controller of controllers) controller.abort();
		controllers.clear();
		if (interval) clearInterval(interval);
		interval = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("deepseek-balance", {
		description: "Refresh the DeepSeek account balance shown in the footer",
		handler: async (_args, ctx) => {
			if (!isDeepseekContext(ctx)) {
				ctx.ui.notify("Active model is not a DeepSeek model", "warning");
				return;
			}
			lastAttemptAt = 0;
			await refresh(ctx, true);
			if (!lastSnapshot) {
				ctx.ui.notify("DeepSeek balance is unavailable", "warning");
				return;
			}
			ctx.ui.notify(`DeepSeek balance: ${formatBalance(lastSnapshot)}`, "info");
		},
	});
}

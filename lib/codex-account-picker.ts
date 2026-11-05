import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { limited, type AccountStatus, type PoolAccount } from "./codex-pool.ts";
import { resetCountdown, windowName } from "./codex-pool-display.ts";

export type AccountChoice = { action: "select"; id: string } | { action: "auto" } | { action: "refresh" };

export async function pickAccount(
	ctx: ExtensionContext,
	accounts: PoolAccount[],
	statuses: AccountStatus[],
	current?: string,
): Promise<AccountChoice | undefined> {
	return ctx.ui.custom<AccountChoice | undefined>((tui, theme, keys, done) => {
		let focus = Math.max(0, accounts.findIndex((a) => a.id === current));
		const dim = (s: string) => theme.fg("dim", s);
		return {
			invalidate() {},
			render(width: number): string[] {
				const now = Date.now();
				const periods = [...new Set(statuses.flatMap((s) => s.quota?.windows.map((w) => w.seconds) ?? []))].sort((a, b) => a - b);
				const cellWidth = 8;
				const nameWidth = Math.max(4, Math.min(24, width - 4 - periods.length * cellWidth));
				const pad = (text: string, columns: number) => {
					const clipped = truncateToWidth(text, columns);
					return clipped + " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
				};
				const rows = accounts.map((account, index) => {
					const quota = statuses.find((s) => s.id === account.id)?.quota;
					const name = `${index === focus ? "›" : " "}${account.id === current ? "*" : " "}${quota && limited(quota, ctx.model?.id) ? "!" : " "}${pad(account.label ?? account.id, nameWidth)} `;
					const label = index === focus ? theme.fg("accent", theme.bold(name)) : name;
					if (!quota) return label + theme.fg("warning", "查询失败");
					const cells = periods.map((seconds) => {
						const window = quota.windows.find((w) => w.seconds === seconds);
						if (!window) return dim(pad("—", cellWidth));
						const left = 100 - window.used;
						const percent = pad(`${Number(left.toFixed(1))}%`, cellWidth);
						return left <= 10 ? theme.fg("error", percent) : left <= 25 ? theme.fg("warning", percent) : percent;
					}).join("");
					return label + cells;
				});
				const selected = accounts[focus];
				const quota = statuses.find((s) => s.id === selected.id)?.quota;
				const details = quota
					? `重置 · ${quota.windows.map((w) => `${windowName(w.seconds)} ${resetCountdown(w, quota.sampledAt, now)}`).join(" · ")}${limited(quota, ctx.model?.id) ? " · 当前模型受限" : ""}`
					: "额度查询失败 · R 重试";
				const detailLines = wrapTextWithAnsi(dim(details), Math.max(1, width));
				// One row per account; only scroll when the terminal really cannot fit the list.
				const capacity = Math.max(1, tui.terminal.rows - 6 - detailLines.length);
				const start = Math.max(0, Math.min(focus - Math.floor(capacity / 2), accounts.length - capacity));
				const end = Math.min(accounts.length, start + capacity);
				return [
					theme.fg("accent", theme.bold("Codex")) + dim(` · 剩余额度 · * 当前${end - start < accounts.length ? ` · ${start + 1}–${end}/${accounts.length}` : ""}`),
					dim(`   ${pad("账号", nameWidth)} ${periods.map((seconds) => pad(windowName(seconds).replaceAll(" ", ""), cellWidth)).join("")}`),
					...rows.slice(start, end),
					...detailLines,
					dim("↑↓ 选择  Enter 切换  Esc 关闭"),
					dim("R 刷新  A 自动  ! 受限"),
				].map((line) => truncateToWidth(line, width));
			},
			handleInput(data: string) {
				if (keys.matches(data, "tui.select.cancel")) return done(undefined);
				if (data === "r" || data === "R") return done({ action: "refresh" });
				if (data === "a" || data === "A") return done({ action: "auto" });
				if (keys.matches(data, "tui.select.confirm")) return done({ action: "select", id: accounts[focus].id });
				if (keys.matches(data, "tui.select.up")) focus = (focus - 1 + accounts.length) % accounts.length;
				else if (keys.matches(data, "tui.select.down")) focus = (focus + 1) % accounts.length;
				else return;
				tui.requestRender();
			},
		};
	});
}

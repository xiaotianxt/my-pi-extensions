import { pace, rankAccounts, recoversAt, sameRank } from "./codex-pool.ts";
import type { AccountStatus, PoolAccount, Quota, UsageWindow } from "./codex-pool.ts";

export function windowName(seconds: number): string {
	if (seconds % 86400 === 0) return `${seconds / 86400} 天`;
	if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
	return `${Math.round(seconds / 60)} 分钟`;
}

function remaining(window: UsageWindow): string {
	return `${Number((100 - window.used).toFixed(1))}%`;
}

// The usage API reports an unstarted window as unused with a full window ahead.
function unstarted(window: UsageWindow, sampledAt: number): boolean {
	return window.used === 0 && (window.resetAt === undefined || window.resetAt * 1000 - sampledAt >= (window.seconds - 60) * 1000);
}

export function resetCountdown(window: UsageWindow, sampledAt: number, now: number): string {
	if (unstarted(window, sampledAt)) return "未开始";
	if (window.resetAt === undefined) return "—";
	return countdown(window.resetAt * 1000 - now);
}

function countdown(ms: number): string {
	const minutes = Math.ceil(ms / 60000);
	if (minutes <= 0) return "待刷新";
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	if (days > 0) return `${days}d${hours ? ` ${hours}h` : ""}`;
	if (hours > 0) return `${hours}h${mins ? ` ${mins}m` : ""}`;
	return `${minutes}m`;
}

export function exhaustedNotice(accounts: PoolAccount[], statuses: AccountStatus[], now = Date.now()): string {
	const next = accounts
		.flatMap((account) => {
			const quota = statuses.find((s) => s.id === account.id)?.quota;
			const at = quota && recoversAt(quota);
			return at === undefined ? [] : [{ account, at }];
		})
		.sort((a, b) => a.at - b.at)[0];
	if (!next) return "所有 Codex 账号额度已用尽，无法自动继续；/codex 查看各账号重置时间。";
	const clock = new Date(next.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
	return `所有 Codex 账号额度已用尽，无法自动继续。最早恢复：${next.account.label ?? next.account.id}，${clock}（${countdown(next.at - now)}）。`;
}

export function resetText(window: UsageWindow, sampledAt: number, now: number): string {
	if (unstarted(window, sampledAt)) return `未开始计时，首次使用后开始 ${windowName(window.seconds)}倒计时`;
	if (window.resetAt === undefined) return "未提供重置时间";
	const minutes = Math.ceil((window.resetAt * 1000 - now) / 60000);
	if (minutes <= 0) return "重置时间已到，待重新采样";
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	return `${days ? `${days} 天 ` : ""}${hours ? `${hours} 小时 ` : ""}${mins ? `${mins} 分钟` : ""}`.trim() + "后重置";
}

function paceText(window: UsageWindow, now: number): string {
	const value = pace(window, now);
	const label = value >= 1.1 ? "富余，重置前用不完" : value <= 0.9 ? "消耗偏快，需节省" : "与时间同步";
	return `${label}（进度比 ${value.toFixed(2)}）`;
}

export function accountList(
	accounts: PoolAccount[],
	statuses: AccountStatus[],
	selected?: string,
	now = Date.now(),
): string {
	const current = accounts.find((a) => a.id === selected);
	const ranked = rankAccounts(accounts, statuses, now);
	const order = ranked.map((c, i) => (i && sameRank(c, ranked[i - 1]) ? " = " : i ? " > " : "") + c.id).join("");
	const lines = [
		current ? `当前使用：${current.label ?? current.id}（${current.id}）` : "当前使用：尚未分配；启用账号池后自动选择",
		`自动分配优先级：${order || "无可用账号"}`,
		"",
	];
	for (const account of accounts) {
		const status = statuses.find((s) => s.id === account.id);
		lines.push(
			`${account.id === selected ? "▶ " : ""}${account.label ?? account.id}${account.label ? `（${account.id}）` : ""}`,
		);
		if (!status?.quota) {
			lines.push("  额度查询失败，自动分配暂不选择此账号", "");
			continue;
		}
		const quota = status.quota;
		for (const window of quota.windows)
			lines.push(
				`  ${windowName(window.seconds)}额度：剩余 ${remaining(window)} · ${resetText(window, quota.sampledAt, now)}`,
				`    ${unstarted(window, quota.sampledAt) ? "可用来启动倒计时" : paceText(window, now)}`,
			);
		if (quota.headroom === 0) lines.push("  当前不可自动分配：额度已用尽或服务端限制使用");
		else if (!ranked.some((c) => c.id === account.id)) lines.push("  当前不自动分配：剩余额度过低");
		lines.push("");
	}
	lines.push(
		"进度比 = 剩余额度 ÷ 距重置的剩余时间占比；大于 1 先用，小于 1 节省。按最紧的窗口排序。",
		"百分比相对于各账号自身额度，不同套餐不代表相同请求数。",
		"新任务开始时，若缓存已冷、上下文较小或当前账号额度不足，会按此顺序自动换号；进行中的任务不换号。",
		"切换账号：/codex 打开选择器；自动重选：/codex auto",
	);
	return lines.join("\n");
}

export function accountFooter(account: PoolAccount | undefined, quota?: Quota): string {
	if (!account) return "账号池 · 待自动分配";
	const windows = quota?.windows.map((w) => {
		const duration = w.seconds % 86400 === 0 ? `${w.seconds / 86400}d`
			: w.seconds % 3600 === 0 ? `${w.seconds / 3600}h` : `${Math.round(w.seconds / 60)}m`;
		return `${duration} ${remaining(w)}`;
	}).join(" · ");
	return `${account.label ?? account.id}${windows ? ` · quota left ${windows}` : " · quota unavailable"}${quota?.headroom === 0 ? " · limited" : ""}`;
}

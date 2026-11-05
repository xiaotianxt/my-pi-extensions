import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const jiti = createJiti(import.meta.url);
const { accountList, accountFooter, resetCountdown } = await jiti.import("../lib/codex-pool-display.ts");
const account = { id: "default", label: "原账号 · Pro", accountId: "fake", weight: 1 };
const quota = {
	windows: [
		{ seconds: 18000, used: 20, resetAt: 4600 },
		{ seconds: 604800, used: 67 },
	],
	headroom: 0.33,
	sampledAt: 1000000,
};
test("reset countdown is compact and keeps unknown, unstarted and expired distinct", () => {
	const now = 1000000;
	const countdown = (minutes) => resetCountdown({ seconds: 604800, used: 20, resetAt: now / 1000 + minutes * 60 }, now, now);
	assert.equal(countdown(17), "17m");
	assert.equal(countdown(60), "1h");
	assert.equal(countdown(65), "1h 5m");
	assert.equal(countdown(3240), "2d 6h");
	assert.equal(countdown(2880), "2d");
	assert.equal(countdown(0), "待刷新");
	assert.equal(resetCountdown({ seconds: 18000, used: 10 }, now, now), "—");
	assert.equal(resetCountdown({ seconds: 18000, used: 0 }, now, now), "未开始");
});

test("shows identity, active account, separate remaining windows and reset semantics", () => {
	const text = accountList([account], [{ id: "default", quota }], "default", 1000000);
	assert.match(text, /当前使用：原账号 · Pro（default）/);
	assert.match(text, /▶ 原账号/);
	assert.match(text, /5 小时额度：剩余 80% · 1 小时后重置/);
	assert.match(text, /7 天额度：剩余 33% · 未提供重置时间/);
	assert.doesNotMatch(text, /limiting-window/);
	assert.match(accountFooter(account, quota), /quota left 5h 80% · 7d 33%/);
});
test("unknown and restricted quota are not presented as available capacity", () => {
	assert.match(accountList([account], [{ id: "default", error: "SECRET" }]), /额度查询失败/);
	assert.doesNotMatch(accountList([account], [{ id: "default", error: "SECRET" }]), /SECRET/);
	assert.match(accountList([account], [{ id: "default", quota: { ...quota, headroom: 0 } }]), /不可自动分配/);
	assert.match(accountList([account], [{ id: "default", quota }], undefined, 5000000), /重置时间已到/);
	assert.equal(accountFooter(undefined), "账号池 · 待自动分配");
});
test("explains unstarted windows, pace and assignment order", () => {
	const idle = {
		windows: [
			{ seconds: 18000, used: 0, resetAt: 1000 + 18000 },
			{ seconds: 604800, used: 0, resetAt: 1000 + 604800 },
		],
		headroom: 1,
		sampledAt: 1000000,
	};
	const second = { id: "cmu", label: "CMU · Edu", accountId: "fake-2", weight: 1 };
	const text = accountList([account, second], [{ id: "default", quota }, { id: "cmu", quota: idle }], "default", 1000000);
	assert.match(text, /5 小时额度：剩余 100% · 未开始计时，首次使用后开始 5 小时倒计时/);
	assert.match(text, /可用来启动倒计时/);
	assert.match(text, /7 天额度：剩余 33% · 未提供重置时间\n    消耗偏快，需节省（进度比 0\.33）/);
	assert.match(text, /自动分配优先级：cmu > default/);
});
test("an exhausted pool names the account that recovers first", async () => {
	const { exhaustedNotice } = await jiti.import("../lib/codex-pool-display.ts");
	const now = Date.parse("2026-10-30T23:08:00Z");
	const at = (minutes) => (now + minutes * 60000) / 1000;
	const pro = { id: "default", label: "原账号 · Pro", accountId: "p", weight: 1 };
	const team = { id: "team1", label: "team1 · Team", accountId: "t", weight: 1 };
	const statuses = [
		{ id: "default", quota: { windows: [{ seconds: 604800, used: 100, resetAt: at(5 * 1440) }], headroom: 0, unavailableModels: [], sampledAt: now } },
		{
			id: "team1",
			quota: {
				windows: [
					{ seconds: 18000, used: 100, resetAt: at(160) },
					{ seconds: 604800, used: 45, resetAt: at(7000) },
				],
				headroom: 0,
				unavailableModels: [],
				sampledAt: now,
			},
		},
	];
	assert.match(exhaustedNotice([pro, team], statuses, now), /最早恢复：team1 · Team，\d\d:\d\d（2h 40m）/);
	assert.match(exhaustedNotice([pro], [{ id: "default", error: "x" }], now), /\/codex 查看/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const ai = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
const jiti = createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-tui": fileURLToPath(import.meta.resolve('@earendil-works/pi-tui')), "@earendil-works/pi-ai/providers/all": `${ai}/providers/all.js`, "@earendil-works/pi-ai": `${ai}/index.js` },
});
const {
	AccountPool,
	parseConfig,
	parseToken,
	parseQuota,
	pace,
	rankAccounts,
	chooseAccount,
	rebalance,
	limited,
	restoredAccount,
	ACCOUNT_ENTRY,
	POOL_PROVIDER,
} = await jiti.import("../lib/codex-pool.ts");
const { installPool } = await jiti.import("../extensions/codex-pool.ts");
const { ModelRuntime } = await import(`${root}/dist/core/model-runtime.js`);
const { AuthStorage } = await import(`${root}/dist/core/auth-storage.js`);
const { InMemoryCodingAgentModelsStore } = await import(`${root}/dist/core/models-store.js`);
const { builtinProviders, getBuiltinModelDataGeneratedAt } = await import(`${ai}/providers/all.js`);
const builtin = builtinProviders().find((p) => p.id === "openai-codex");
const now = Date.now();
const config = () =>
	parseConfig({
		endpoint: "https://refresh.example.test/oauth/token",
		accounts: [
			{ id: "a", accountId: "account-a" },
			{ id: "b", accountId: "account-b" },
		],
	});
const jwt = (id) =>
	`e30.${Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: `account-${id}` } })).toString("base64url")}.sig`;
const usage = (used = 20, weekly = 40) => ({
	rate_limit: {
		allowed: true,
		primary_window: { used_percent: used, limit_window_seconds: 18000, reset_at: now / 1000 + 1000 },
		secondary_window: { used_percent: weekly, limit_window_seconds: 604800 },
	},
});
const signal = () => new AbortController().signal;
function fakeDependencies() {
	const requests = [];
	const used = { a: 20, b: 40 };
	return {
		requests,
		used,
		now: () => now,
		secret: async (id) => `internal-${id}`,
		fetch: async (url, options) => {
			requests.push({ url, options });
			if (url === config().endpoint) {
				assert.equal(options.redirect, "error");
				const id = JSON.parse(options.body).refresh_token.replace("internal-", "");
				return Response.json({ access_token: jwt(id) });
			}
			assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
			const id = options.headers["chatgpt-account-id"].replace("account-", "");
			assert.equal(options.headers.Authorization, `Bearer ${jwt(id)}`);
			return Response.json(usage(used[id], used[id]));
		},
	};
}

test("config rejects ambiguous identities and unsafe endpoints", () => {
	assert.throws(() => parseConfig({ ...config(), endpoint: "http://remote.test/oauth/token" }), /HTTPS/);
	assert.throws(
		() => parseConfig({ ...config(), accounts: [config().accounts[0], config().accounts[0]] }),
		/Duplicate/,
	);
	assert.throws(() => parseConfig({ ...config(), accounts: [{ id: "a", accountId: "a", weight: 0 }] }), /weight/);
});

const win = (used, seconds, resetIn) => ({
	used_percent: used,
	limit_window_seconds: seconds,
	...(resetIn === undefined ? {} : { reset_at: now / 1000 + resetIn }),
});
const quotaOf = (primary, secondary = null) =>
	parseQuota({ rate_limit: { allowed: true, primary_window: primary, secondary_window: secondary } }, now);
const H5 = 18000;
const WEEK = 604800;

test("pace compares remaining quota with remaining time in each window", () => {
	assert.equal(pace(quotaOf(win(0, H5, H5)).windows[0], now), 1, "unstarted window");
	assert.equal(pace(quotaOf(win(60, WEEK, WEEK / 2)).windows[0], now), 0.8, "ahead of time: conserve");
	assert(pace(quotaOf(win(30, WEEK, 3600)).windows[0], now) > 100, "expiring surplus: use first");
	assert.equal(pace(quotaOf(win(50, H5, 60)).windows[0], now), 0.5 / (900 / H5), "imminent reset counts as 15 minutes");
	assert.equal(pace(quotaOf(win(50, H5, -10)).windows[0], now), 1, "stale sample: window already reset");
	assert.equal(pace(quotaOf(win(40, H5)).windows[0], now), 0.6, "unknown reset: assume a full window ahead");
});

test("ranking uses expiring quota first, then unstarted windows, and conserves the tightest window", () => {
	const accounts = ["expiring", "idle", "starved", "weekly-surplus", "pro"].map((id) => ({ id, accountId: id, weight: 1 }));
	const statuses = [
		// Short window plentiful, but the weekly window must last six more days.
		{ id: "starved", quota: quotaOf(win(20, H5, 1200), win(97, WEEK, 6 * 86400)) },
		// Weekly quota resets in 30 minutes with 70% unused.
		{ id: "expiring", quota: quotaOf(win(40, H5, 7200), win(30, WEEK, 1800)) },
		{ id: "idle", quota: quotaOf(win(0, H5, H5), win(0, WEEK, WEEK)) },
		// Same unstarted short window as idle; its weekly surplus breaks the tie.
		{ id: "weekly-surplus", quota: quotaOf(win(0, H5, H5), win(10, WEEK, 86400)) },
		// A single weekly window, behind its time.
		{ id: "pro", quota: quotaOf(win(67, WEEK, 5.5 * 86400)) },
	];
	assert.deepEqual(
		rankAccounts(accounts, statuses, now).map((c) => c.id),
		["expiring", "weekly-surplus", "idle", "pro", "starved"],
	);
	assert.equal(chooseAccount(accounts, statuses, now, 0.99), "expiring", "randomness never overrides rank");
	const heavy = accounts.map((a) => (a.id === "pro" ? { ...a, weight: 20 } : a));
	assert.equal(chooseAccount(heavy, statuses, now, 0), "pro", "explicit capacity weight scales pace");
});

test("equal ranks spread randomly; exhausted and near-empty accounts are never assigned", () => {
	const idle = { quota: quotaOf(win(0, H5, H5), win(0, WEEK, WEEK)) };
	const statuses = [
		{ id: "a", ...idle },
		{ id: "b", ...idle },
	];
	assert.equal(chooseAccount(config().accounts, statuses, now, 0), "a");
	assert.equal(chooseAccount(config().accounts, statuses, now, 0.99), "b");
	assert.equal(parseQuota({ ...usage(), rate_limit: { ...usage().rate_limit, allowed: false } }, now).headroom, 0);
	assert.equal(
		chooseAccount(config().accounts, [{ id: "a", quota: quotaOf(win(99, H5, 100)) }, { id: "b", ...idle }], now, 0),
		"b",
	);
	assert.throws(
		() =>
			chooseAccount(
				config().accounts,
				[
					{ id: "a", quota: parseQuota(usage(100), now) },
					{ id: "b", error: "unavailable" },
				],
				now,
				0,
			),
		/No account/,
	);
});

test("rebalance moves only to a strictly better account or away from a near-empty one", () => {
	const idle = quotaOf(win(0, H5, H5), win(0, WEEK, WEEK));
	const conserve = quotaOf(win(10, H5, H5 - 600), win(80, WEEK, WEEK / 2));
	const accounts = config().accounts;
	assert.equal(rebalance(accounts, [{ id: "a", quota: idle }, { id: "b", quota: idle }], "a", now, 0.99), undefined);
	assert.equal(rebalance(accounts, [{ id: "a", quota: conserve }, { id: "b", quota: idle }], "a", now, 0), "b");
	assert.equal(rebalance(accounts, [{ id: "a", quota: conserve }, { id: "b", quota: idle }], "b", now, 0), undefined);
	const empty = quotaOf(win(99, H5, 100));
	assert.equal(rebalance(accounts, [{ id: "a", quota: empty }, { id: "b", quota: conserve }], "a", now, 0), "b");
	assert.equal(rebalance(accounts, [{ id: "a", quota: empty }, { id: "b", error: "x" }], "a", now, 0), undefined);
});

test("token responses cannot cross identities or expose upstream refresh tokens", () => {
	assert.equal(parseToken({ access_token: jwt("a") }, config().accounts[0], now).accountId, "account-a");
	assert.throws(() => parseToken({ access_token: jwt("b") }, config().accounts[0], now), /identity mismatch/);
	assert.throws(
		() => parseToken({ access_token: jwt("a"), refresh_token: "SECRET" }, config().accounts[0], now),
		(error) => !error.message.includes("SECRET"),
	);
});

test("per-account requests coalesce; cancelling one waiter leaves other consumers intact", async () => {
	const dep = fakeDependencies();
	let release;
	const gate = new Promise((r) => (release = r));
	const originalFetch = dep.fetch;
	dep.fetch = async (...args) => {
		await gate;
		return originalFetch(...args);
	};
	const pool = new AccountPool(config(), dep);
	const cancelled = new AbortController();
	const one = pool.token("a", cancelled.signal);
	const two = pool.token("a", signal());
	cancelled.abort();
	await assert.rejects(one);
	release();
	assert.equal((await two).access, jwt("a"));
	assert.equal(dep.requests.length, 1);
	await Promise.all([pool.sample("a", signal()), pool.sample("a", signal()), pool.sample("b", signal())]);
	assert.equal(dep.requests.filter((r) => r.url === config().endpoint).length, 2);
	assert.equal(dep.requests.filter((r) => r.url.includes("wham")).length, 2);
	pool.close();
	await assert.rejects(pool.token("a", signal()));
});

test("selection restores active branch only and failures expose no secrets", async () => {
	const entry = (id) => ({ type: "custom", customType: ACCOUNT_ENTRY, data: { id } });
	assert.equal(restoredAccount([entry("a"), entry("b")]), "b");
	assert.equal(restoredAccount([entry("a")]), "a");
	assert.equal(restoredAccount([]), undefined);
	const dep = fakeDependencies();
	dep.secret = async () => {
		throw new Error("SECRET");
	};
	const statuses = await new AccountPool(config(), dep).statuses(signal());
	assert(!JSON.stringify(statuses).includes("SECRET"));
	assert(statuses.every((s) => s.error && !s.quota));
});

async function harness(entries = [], { store = new InMemoryCodingAgentModelsStore(), start = true } = {}) {
	const original = {
		type: "oauth",
		access: "original-access",
		refresh: "original-internal",
		expires: now + 3600000,
		accountId: "original",
	};
	const credentials = AuthStorage.inMemory({ "openai-codex": original });
	const cached = { ...builtin.getModels()[0], id: "cached-only-model" };
	await store.write("openai-codex", {
		models: [cached],
		lastModified: getBuiltinModelDataGeneratedAt() + 60000,
		checkedAt: now,
	});
	const runtime = await ModelRuntime.create({ modelsPath: null, modelsStore: store, credentials });
	const handlers = new Map();
	const commands = new Map();
	const messages = [];
	const dep = fakeDependencies();
	let branch = [...entries];
	const ctx = {
		model: runtime.models.getModel("openai-codex", cached.id),
		hasUI: true,
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 100_000, contextWindow: 272_000, percent: 37 }),
		modelRegistry: {
			getProvider: (id) => runtime.getProvider(id),
			find: (p, id) => runtime.models.getModel(p, id),
			refresh: (options) => runtime.refresh(options),
		},
		sessionManager: { getBranch: () => branch },
		ui: { setStatus() {}, notify: (message) => messages.push(message) },
	};
	const pi = {
		registerProvider: (p) => runtime.registerNativeProvider(p),
		on: (event, fn) => handlers.set(event, fn),
		registerCommand: (name, def) => commands.set(name, def),
		appendEntry: (customType, data) => branch.push({ type: "custom", customType, data }),
		setModel: async (model) => {
			ctx.model = model;
			return true;
		},
	};
	installPool(pi, config(), () => new AccountPool(config(), dep));
	if (start) await handlers.get("session_start")({}, ctx);
	return {
		store,
		pi,
		runtime,
		credentials,
		original,
		ctx,
		handlers,
		commands,
		messages,
		dep,
		get branch() {
			return branch;
		},
		set branch(value) {
			branch = value;
		},
	};
}

test("account picker renders compact quota rows and handles select, refresh, cancel and busy state", async () => {
	const h = await harness();
	h.ctx.mode = "tui";
	assert.equal(h.commands.has("codex-account"), false);
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	let visits = 0;
	let input = ["r"];
	const theme = { fg: (_color, value) => value, bold: (value) => value };
	const keys = { matches: (data, action) => data === action.split(".").at(-1) };
	h.ctx.ui.custom = async (factory, options) => {
		assert.notEqual(options?.overlay, true, "opens inline under the editor like /settings, not as a centered overlay");
		let result;
		const component = factory({ terminal: { rows: 32 }, requestRender() {} }, theme, keys, (value) => { result = value; });
		for (const width of [40, 92]) {
			const lines = component.render(width);
			assert(lines.every((line) => visibleWidth(line) <= width));
			assert(lines.some((line) => line.includes("80%")));
			assert(!lines.some((line) => line.includes("━")));
			assert(lines.some((line) => line.includes("重置 · 5 小时 17m")));
			const meter = lines.find((line) => line.includes("80%"));
			assert.match(meter, /80%\s+80%/);
			const heading = lines.find((line) => line.includes("5小时"));
			assert.equal(visibleWidth(meter.slice(0, meter.indexOf("80%"))), visibleWidth(heading.slice(0, heading.indexOf("5小时"))));
			assert(!lines.some((line) => /后重置|未提供重置|首次使用后/.test(line)));
			assert(lines.length <= 32);
			if (process.env.PICKER_PREVIEW && visits === 0) console.log(lines.join("\n"));
		}
		for (const key of input) component.handleInput(key);
		visits++;
		input = ["down", "confirm"];
		return result;
	};
	await h.commands.get("codex").handler("", h.ctx);
	assert.equal(visits, 2);
	assert.equal(restoredAccount(h.branch), "b");
	assert.equal(h.messages.length, 1, "only the switch confirmation is printed");
	input = ["cancel"];
	await h.commands.get("codex").handler("", h.ctx);
	assert.equal(restoredAccount(h.branch), "b");
	assert.equal(h.messages.length, 1);
	h.ctx.ui.custom = async () => {
		h.ctx.isIdle = () => false;
		return { action: "select", id: "a" };
	};
	await h.commands.get("codex").handler("", h.ctx);
	assert.equal(restoredAccount(h.branch), "b", "a run starting during the picker prevents switching");
});

test("five accounts fit a short terminal, keep distinct quota columns and scroll only when needed", async () => {
	const { pickAccount } = await jiti.import("../lib/codex-account-picker.ts");
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	const accounts = ["原账号 · Pro", "CMU · Edu", "charlesbrown · Team", "team1 · Team", "Stanford · Edu"].map((label, i) => ({ id: `a${i}`, label }));
	const statuses = accounts.map((a) => ({ id: a.id, quota: quotaOf(win(20, H5, 1000), win(40, WEEK, 86400)) }));
	statuses[0].quota = quotaOf(win(30, WEEK, 86400));
	statuses[2].quota = undefined;
	statuses[3].quota = quotaOf(win(100, H5, 1000), win(40, WEEK, 86400));
	const terminal = { rows: 16 };
	const ctx = { ui: { custom: async (factory) => {
		const component = factory({ terminal, requestRender() {} }, { fg: (_c, s) => s, bold: (s) => s }, { matches: (data, action) => data === action.split(".").at(-1) }, () => {});
		for (const width of [40, 80]) {
			const lines = component.render(width);
			assert(lines.length <= 11, "five accounts no longer consume twenty-plus lines");
			assert(!lines.join("\n").includes("1–"));
			for (const name of ["原账号", "CMU", "charlesbrown", "team1", "Stanford"]) assert(lines.some((l) => l.includes(name)));
			assert.match(lines.find((l) => l.includes("原账号")), /—\s+70%/);
			assert.match(lines.find((l) => l.includes("charlesbrown")), /查询失败/);
			assert.match(lines.find((l) => l.includes("team1")), /!team1/);
			assert(lines.every((l) => visibleWidth(l) <= width));
			if (process.env.PICKER_PREVIEW) console.log(lines.join("\n"));
		}
		for (let i = 0; i < 4; i++) component.handleInput("down");
		assert(component.render(40).some((l) => l.startsWith("›") && l.includes("Stanford")));
		terminal.rows = 10;
		const short = component.render(40);
		assert(short.length <= terminal.rows);
		assert(short.some((l) => l.startsWith("›") && l.includes("Stanford")));
		for (const width of [20, 32]) assert(component.render(width).every((l) => visibleWidth(l) <= width));
	} } };
	await pickAccount(ctx, accounts, statuses, "a0");
});

test("native auth uses session selection, keeps the original credential and live catalog", async () => {
	const h = await harness();
	assert.equal(h.ctx.model.provider, POOL_PROVIDER);
	assert(h.runtime.models.getModel(POOL_PROVIDER, "cached-only-model"));
	await h.commands.get("codex").handler("a", h.ctx);
	assert.equal((await h.runtime.getAuth(POOL_PROVIDER)).auth.apiKey, jwt("a"));
	await h.commands.get("codex").handler("b", h.ctx);
	assert.equal((await h.runtime.getAuth(POOL_PROVIDER)).auth.apiKey, jwt("b"));
	assert.deepEqual(await h.credentials.read("openai-codex"), h.original);
	assert.equal(await h.credentials.read(POOL_PROVIDER), undefined);
	assert(h.branch.every((e) => Object.keys(e.data).join(",") === "id"));
	h.branch = h.branch.slice(0, 1);
	await h.handlers.get("session_tree")({}, h.ctx);
	assert.equal((await h.runtime.getAuth(POOL_PROVIDER)).auth.apiKey, jwt("a"));
	await h.handlers.get("session_shutdown")({}, h.ctx);
	await h.handlers.get("session_start")({}, h.ctx);
	assert.equal((await h.runtime.getAuth(POOL_PROVIDER)).auth.apiKey, jwt("a"));
	await assert.rejects(h.commands.get("codex").handler("typo", h.ctx), /Unknown/);
	assert.equal((await h.runtime.getAuth(POOL_PROVIDER)).auth.apiKey, jwt("a"));
});

test("automatic assignment is sticky; independent sessions and restored missing accounts fail safely", async () => {
	const h = await harness();
	h.dep.used.a = 100;
	assert.equal((await h.runtime.getAuth(POOL_PROVIDER)).auth.apiKey, jwt("b"));
	h.dep.used.a = 0;
	h.dep.used.b = 100;
	assert.equal((await h.runtime.getAuth(POOL_PROVIDER)).auth.apiKey, jwt("b"));
	const other = await harness([{ type: "custom", customType: ACCOUNT_ENTRY, data: { id: "a" } }]);
	assert.equal((await other.runtime.getAuth(POOL_PROVIDER)).auth.apiKey, jwt("a"));
	const removed = await harness([{ type: "custom", customType: ACCOUNT_ENTRY, data: { id: "removed" } }]);
	await assert.rejects(removed.runtime.getAuth(POOL_PROVIDER), /Unknown/);
});

test("pooled cached-only models restore before session_start and resume lookup", async () => {
	const first = await harness();
	assert((await first.store.read(POOL_PROVIDER)).models.some((m) => m.id === "cached-only-model"));
	const resumed = await harness([], { store: first.store, start: false });
	await resumed.runtime.refresh({ providers: [POOL_PROVIDER], allowNetwork: false });
	assert(resumed.runtime.models.getModel(POOL_PROVIDER, "cached-only-model"));
	assert.equal(resumed.dep.requests.length, 0, "catalog restore must not resolve credentials");
});

test("a pending manual switch cannot change accounts after a run starts or accept overlapping switches", async () => {
	const h = await harness([{ type: "custom", customType: ACCOUNT_ENTRY, data: { id: "a" } }]);
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	h.dep.secret = async (id) => {
		if (id === "b") await gate;
		return `internal-${id}`;
	};
	const pending = h.commands.get("codex").handler("b", h.ctx);
	await h.commands.get("codex").handler("a", h.ctx);
	assert(h.messages.some((message) => message.includes("already pending")));
	h.ctx.isIdle = () => false;
	release();
	await pending;
	assert.equal((await h.runtime.getAuth(POOL_PROVIDER)).auth.apiKey, jwt("a"));
});

test("a session change while setModel is pending cannot commit a stale account switch", async () => {
	const h = await harness([{ type: "custom", customType: ACCOUNT_ENTRY, data: { id: "a" } }]);
	h.ctx.model = h.runtime.models.getModel("openai-codex", "cached-only-model");
	let entered, release;
	const inside = new Promise((resolve) => {
		entered = resolve;
	});
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	h.pi.setModel = async () => {
		entered();
		await gate;
		return true;
	};
	const pending = h.commands.get("codex").handler("b", h.ctx);
	await inside;
	await h.handlers.get("session_tree")({}, h.ctx);
	release();
	await assert.rejects(pending);
	assert.equal(restoredAccount(h.branch), "a");
});

test("background model refresh is credential-free before attachment and while another provider is selected", async () => {
	const h = await harness([], { start: false });
	let result = await h.runtime.refresh({ providers: [POOL_PROVIDER], allowNetwork: true });
	assert.equal(result.errors.size, 0);
	assert.equal(h.dep.requests.length, 0);
	await h.handlers.get("session_start")({}, h.ctx);
	h.ctx.model = h.runtime.models.getModel("openai-codex", "cached-only-model");
	await h.handlers.get("model_select")({}, h.ctx);
	result = await h.runtime.refresh({ providers: [POOL_PROVIDER], allowNetwork: true });
	assert.equal(result.errors.size, 0);
	assert.equal(h.dep.requests.length, 0);
	assert.equal(restoredAccount(h.branch), undefined);
});

test("built-in inference transport receives the matching access token and account ID", async (t) => {
	const h = await harness([{ type: "custom", customType: ACCOUNT_ENTRY, data: { id: "b" } }]);
	let seen = 0;
	t.mock.method(globalThis, "fetch", async (url, options) => {
		assert.equal(new URL(url).origin, "https://chatgpt.com");
		const headers = new Headers(options.headers);
		assert.equal(headers.get("authorization"), `Bearer ${jwt("b")}`);
		assert.equal(headers.get("chatgpt-account-id"), "account-b");
		seen++;
		return new Response(
			'event: response.completed\ndata: {"type":"response.completed","response":{"id":"offline","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n',
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	});
	const stream = h.runtime.streamSimple(
		h.ctx.model,
		{ messages: [{ role: "user", content: "offline test", timestamp: now }] },
		{ transport: "sse" },
	);
	const message = await stream.result();
	assert.equal(message.stopReason, "stop", message.errorMessage);
	assert.equal(seen, 1);
});

test("run boundaries move a session only when its cache is cheap to lose or its account is nearly empty", async () => {
	const h = await harness([{ type: "custom", customType: ACCOUNT_ENTRY, data: { id: "a" } }]);
	const start = () => h.handlers.get("before_agent_start")({ type: "before_agent_start", messageType: "user" }, h.ctx);
	const settle = () => h.handlers.get("agent_settled")({ aborted: false }, h.ctx);
	const auth = async () => (await h.runtime.getAuth(POOL_PROVIDER)).auth.apiKey;
	h.dep.used.a = 90;
	await settle();
	await start();
	assert.equal(await auth(), jwt("a"), "a warm, large session keeps its account despite a better one");
	h.ctx.getContextUsage = () => ({ tokens: 2_000, contextWindow: 272_000, percent: 1 });
	await start();
	assert.equal(await auth(), jwt("b"), "a small context moves to the better account");
	assert.equal(restoredAccount(h.branch), "b");
	assert(h.messages.some((m) => m.includes("a → b")));
	h.ctx.getContextUsage = () => ({ tokens: 100_000, contextWindow: 272_000, percent: 37 });
	h.dep.used.b = 99;
	await settle();
	await start();
	assert.equal(await auth(), jwt("a"), "a nearly empty account moves even with a warm cache");
	assert(h.messages.some((m) => m.includes("b → a") && m.includes("额度不足")));
});

test("an account whose server reports the model unavailable is limited for that model only", () => {
	const quota = parseQuota(
		{
			...usage(10, 10),
			model_usage: { "gpt-x": { available: false, available_at: "later" }, "gpt-y": { available: true } },
		},
		now,
	);
	assert.deepEqual(quota.unavailableModels, ["gpt-x"]);
	assert(limited(quota, "gpt-x"));
	assert(!limited(quota, "gpt-y"));
	assert(!limited(quota));
	const statuses = [
		{ id: "a", quota },
		{ id: "b", quota: parseQuota(usage(60, 60), now) },
	];
	assert.equal(chooseAccount(config().accounts, statuses, now, 0, "gpt-x"), "b");
	assert.equal(chooseAccount(config().accounts, statuses, now, 0, "gpt-y"), "a");
});

test("a quota-refused request moves to another account and continues the same run", async () => {
	const h = await harness([{ type: "custom", customType: ACCOUNT_ENTRY, data: { id: "a" } }]);
	const failure = (content = []) => ({
		sourceEntry: { id: "failed-1" },
		messages: [{ role: "assistant", stopReason: "error", content, errorMessage: "Codex error: The usage limit has been reached" }],
	});
	const beforeSettle = (entry, outcome = "error") =>
		h.handlers.get("agent_before_settle")(
			{ type: "agent_before_settle", outcome, entries: [], continue: false, context: { contextEntries: [entry] } },
			h.ctx,
		);
	const auth = async () => (await h.runtime.getAuth(POOL_PROVIDER)).auth.apiKey;
	assert.equal(await beforeSettle(failure()), undefined, "an error on an account with quota settles normally");
	assert.equal(await beforeSettle(failure(), "completed"), undefined);
	h.dep.used.a = 100;
	assert.deepEqual(await beforeSettle(failure()), {
		entries: [{ type: "context_edit", targetId: "failed-1", replacement: null }],
		continue: true,
	});
	assert.equal(await auth(), jwt("b"));
	assert.equal(restoredAccount(h.branch), "b");
	assert(h.messages.some((m) => m.includes("a 额度用尽") && m.includes("b")));
	h.dep.used.b = 100;
	const toolCall = [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }];
	assert.equal(await beforeSettle(failure(toolCall)), undefined, "a failure carrying tool calls is never continued");
	assert.equal(await beforeSettle(failure()), undefined, "no account left: the error stands");
	assert.match(h.messages.at(-1), /所有 Codex 账号额度已用尽/);
	assert.equal(await auth(), jwt("b"));
});

test("a session resumed on a stale pooled model adopts the live catalog metadata", async () => {
	const h = await harness();
	const live = h.runtime.models.getModel(POOL_PROVIDER, "cached-only-model");
	h.ctx.model = { ...live, contextWindow: 1234 };
	await h.handlers.get("session_shutdown")({}, h.ctx);
	await h.handlers.get("session_start")({}, h.ctx);
	assert.equal(h.ctx.model.contextWindow, live.contextWindow);
	let calls = 0;
	h.pi.setModel = async () => ++calls > 0;
	await h.handlers.get("model_select")({}, h.ctx);
	assert.equal(calls, 0, "an up-to-date model is not reselected");
});

test("in a real session, a quota-refused request continues on another account without user input", async (t) => {
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(`${root}/dist/index.js`);
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = await mkdtemp(join(tmpdir(), "codex-pool-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		credentials: AuthStorage.inMemory({}),
	});
	const dep = fakeDependencies();
	const sessionManager = SessionManager.inMemory(dir);
	sessionManager.appendCustomEntry(ACCOUNT_ENTRY, { id: "a" });
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [(pi) => installPool(pi, config(), () => new AccountPool(config(), dep))],
	});
	await resourceLoader.reload();
	const settingsManager = SettingsManager.inMemory({ transport: "sse" });
	const inference = [];
	const realFetch = globalThis.fetch;
	t.mock.method(globalThis, "fetch", async (url, options) => {
		if (!String(url).startsWith("https://chatgpt.com/backend-api/codex")) return realFetch(url, options);
		const account = new Headers(options.headers).get("chatgpt-account-id");
		const raw = options.body;
		const body = JSON.parse(
			typeof raw === "string" ? raw : (await import("node:zlib")).zstdDecompressSync(Buffer.from(raw)).toString("utf8"),
		);
		inference.push({ account, last: body.input.at(-1) });
		// The account runs out mid-run, as the server-side usage then reports.
		if (account === "account-a") dep.used.a = 100;
		const events =
			account === "account-a"
				? [{ type: "error", code: "usage_limit_reached", message: "The usage limit has been reached" }]
				: [
						{
							type: "response.output_item.done",
							item: { type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] },
						},
						{
							type: "response.completed",
							response: { id: "r1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
						},
					];
		return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
			headers: { "Content-Type": "text/event-stream" },
		});
	});
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		modelRuntime: runtime,
		model: builtin.getModels().find((m) => new URL(m.baseUrl).origin === "https://chatgpt.com"),
		resourceLoader,
		sessionManager,
		settingsManager,
		noTools: "all",
	});
	await session.bindExtensions({});
	assert.equal(session.model.provider, POOL_PROVIDER);
	await session.prompt("hello");
	assert.deepEqual(
		inference.map((r) => r.account),
		["account-a", "account-b"],
	);
	assert.equal(inference[1].last.role, "user", "the refused attempt is not sent back to the model");
	const last = session.messages.at(-1);
	assert.equal(last.role, "assistant");
	assert.equal(last.stopReason, "stop", last.errorMessage);
	assert.equal(restoredAccount(sessionManager.getBranch()), "b");
	session.dispose();
});

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const POOL_PROVIDER = "codex-pool";
export const ACCOUNT_ENTRY = "codex-pool-account";
export const KEYCHAIN_SERVICE = "pi-codex-pool";
const AUTH_CLAIM = "https://api.openai.com/auth";
const execFileAsync = promisify(execFile);

export interface PoolAccount {
	id: string;
	label?: string;
	accountId: string;
	weight: number;
}
export interface PoolConfig {
	endpoint: string;
	autoEnable: boolean;
	accounts: PoolAccount[];
}
export interface Token {
	access: string;
	expires: number;
	accountId: string;
}
export interface UsageWindow {
	used: number;
	seconds: number;
	resetAt?: number;
}
export interface Quota {
	windows: UsageWindow[];
	headroom: number;
	/** Models the server reports as currently unavailable on this account. */
	unavailableModels: string[];
	sampledAt: number;
}
export interface AccountStatus {
	id: string;
	quota?: Quota;
	error?: string;
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseConfig(value: unknown): PoolConfig {
	if (!object(value) || !Array.isArray(value.accounts) || !value.accounts.length)
		throw new Error("Codex pool requires accounts");
	if (typeof value.endpoint !== "string") throw new Error("Codex pool requires an HTTPS refresh endpoint");
	const url = new URL(value.endpoint);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
		throw new Error("Codex pool endpoint must be HTTPS without credentials/query/fragment");
	if (value.autoEnable !== undefined && typeof value.autoEnable !== "boolean")
		throw new Error("autoEnable must be boolean");
	const ids = new Set<string>();
	const accounts = new Set<string>();
	const parsed = value.accounts.map((account: unknown): PoolAccount => {
		if (
			!object(account) ||
			typeof account.id !== "string" ||
			!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(account.id) ||
			typeof account.accountId !== "string" ||
			!account.accountId.trim()
		)
			throw new Error("Invalid Codex pool account identity");
		if (
			account.label !== undefined &&
			(typeof account.label !== "string" || !account.label.trim() || /[\x00-\x1f\x7f]/.test(account.label))
		)
			throw new Error("Account label must be nonempty printable text");
		const weight = account.weight ?? 1;
		if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0)
			throw new Error("Account weight must be positive and finite");
		if (ids.has(account.id) || accounts.has(account.accountId)) throw new Error("Duplicate Codex pool account");
		ids.add(account.id);
		accounts.add(account.accountId);
		return {
			id: account.id,
			accountId: account.accountId,
			weight,
			...(typeof account.label === "string" ? { label: account.label } : {}),
		};
	});
	return { endpoint: url.href, autoEnable: value.autoEnable !== false, accounts: parsed };
}

export function loadConfig(): PoolConfig | undefined {
	const path = process.env.CODEX_POOL_CONFIG ?? join(homedir(), ".pi/agent/codex-pool.json");
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Invalid JSON in Codex pool configuration");
	}
	return parseConfig(value);
}

export function parseToken(value: unknown, account: PoolAccount, now: number): Token {
	if (!object(value) || typeof value.access_token !== "string" || "refresh_token" in value)
		throw new Error("Invalid pool token response (must contain access token only, never refresh token)");
	let claims: unknown;
	try {
		claims = JSON.parse(Buffer.from(value.access_token.split(".")[1], "base64url").toString("utf8"));
	} catch {
		throw new Error("Pool returned an invalid access token");
	}
	if (!object(claims) || typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now)
		throw new Error("Pool returned an expired or invalid access token");
	const auth = claims[AUTH_CLAIM];
	if (!object(auth) || auth.chatgpt_account_id !== account.accountId)
		throw new Error(`Account identity mismatch for ${account.id}`);
	return { access: value.access_token, expires: claims.exp * 1000, accountId: account.accountId };
}

export function parseQuota(value: unknown, now: number): Quota {
	if (!object(value) || !object(value.rate_limit)) throw new Error("Usage response has no rate_limit");
	const rate = value.rate_limit;
	const windows: UsageWindow[] = [];
	for (const raw of [rate.primary_window, rate.secondary_window]) {
		if (raw === null || raw === undefined) continue;
		if (
			!object(raw) ||
			typeof raw.used_percent !== "number" ||
			!Number.isFinite(raw.used_percent) ||
			typeof raw.limit_window_seconds !== "number" ||
			!Number.isFinite(raw.limit_window_seconds) ||
			raw.limit_window_seconds <= 0
		)
			throw new Error("Invalid usage window");
		windows.push({
			used: Math.max(0, Math.min(100, raw.used_percent)),
			seconds: raw.limit_window_seconds,
			...(typeof raw.reset_at === "number" && Number.isFinite(raw.reset_at) ? { resetAt: raw.reset_at } : {}),
		});
	}
	if (!windows.length) throw new Error("Usage response has no quota windows");
	const headroom =
		rate.allowed === false || rate.limit_reached === true ? 0 : Math.min(...windows.map((w) => 1 - w.used / 100));
	const unavailableModels = object(value.model_usage)
		? Object.entries(value.model_usage).flatMap(([model, usage]) =>
				object(usage) && usage.available === false ? [model] : [],
			)
		: [];
	return { windows, headroom, unavailableModels, sampledAt: now };
}

// Below this headroom an account is never auto-assigned: the next run would
// likely hit the limit mid-run, and a partial run is never replayed elsewhere.
export const RESERVE = 0.02;
// A window resetting sooner than this still only absorbs about this much work.
const MIN_HORIZON_SECONDS = 15 * 60;
// Paces within ~10% rank equal, so tiny sampling differences do not cause switches.
const BUCKET = Math.log(1.1);

/** Whether the next request on this account would likely hit a limit. */
export function limited(quota: Quota, model?: string): boolean {
	return quota.headroom < RESERVE || (model !== undefined && quota.unavailableModels.includes(model));
}

/** When an exhausted account's limiting windows reset, if the usage API reports it. */
export function recoversAt(quota: Quota): number | undefined {
	const exhausted = quota.windows.filter((w) => 1 - w.used / 100 < RESERVE);
	if (!exhausted.length || exhausted.some((w) => w.resetAt === undefined)) return undefined;
	return Math.max(...exhausted.map((w) => w.resetAt as number)) * 1000;
}

// Pace = remaining quota fraction ÷ remaining time fraction of the window.
// > 1: at the window's nominal rate quota expires unused, so use it first.
// < 1: consumption is ahead of time, so conserve. An unstarted window is ~1:
// work there starts its countdown without spending anything that is scarce.
export function pace(window: UsageWindow, now: number): number {
	const remaining = 1 - window.used / 100;
	if (window.resetAt === undefined) return remaining;
	const left = window.resetAt - now / 1000;
	if (left <= 0) return 1; // The window has reset since sampling.
	const horizon = Math.min(window.seconds, Math.max(left, Math.min(MIN_HORIZON_SECONDS, window.seconds)));
	return remaining / (horizon / window.seconds);
}

// Every reported window limits the same work, so accounts compare by their
// tightest window first (leximin); later windows break ties, and a window an
// account does not have never constrains it.
function rankKey(account: PoolAccount, quota: Quota, now: number): number[] {
	return quota.windows
		.map((w) => Math.round(Math.log(account.weight * pace(w, now)) / BUCKET))
		.sort((a, b) => a - b);
}

// Positive when `a` is preferred.
function compareKeys(a: number[], b: number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i] ?? Infinity;
		const y = b[i] ?? Infinity;
		if (x !== y) return x > y ? 1 : -1;
	}
	return 0;
}

export interface RankedAccount {
	id: string;
	key: number[];
}

/** Assignable accounts, most preferred first. */
export function rankAccounts(
	accounts: PoolAccount[],
	statuses: AccountStatus[],
	now: number,
	model?: string,
): RankedAccount[] {
	return accounts
		.flatMap((account) => {
			const quota = statuses.find((s) => s.id === account.id)?.quota;
			return quota && !limited(quota, model) ? [{ id: account.id, key: rankKey(account, quota, now) }] : [];
		})
		.sort((a, b) => compareKeys(b.key, a.key));
}

export function sameRank(a: RankedAccount, b: RankedAccount): boolean {
	return compareKeys(a.key, b.key) === 0;
}

// Random only among equally ranked accounts, so concurrent processes with the
// same samples spread over equivalent accounts instead of herding.
function pick(ranked: RankedAccount[], random: number): string {
	const best = ranked.filter((c) => sameRank(c, ranked[0]));
	return best[Math.min(best.length - 1, Math.floor(random * best.length))].id;
}

export function chooseAccount(
	accounts: PoolAccount[],
	statuses: AccountStatus[],
	now: number,
	random: number,
	model?: string,
): string {
	const ranked = rankAccounts(accounts, statuses, now, model);
	if (!ranked.length) throw new Error("No account with verified available quota; use /codex");
	return pick(ranked, random);
}

/** The account to move to at a run boundary, or undefined to stay on `current`. */
export function rebalance(
	accounts: PoolAccount[],
	statuses: AccountStatus[],
	current: string,
	now: number,
	random: number,
	model?: string,
): string | undefined {
	const ranked = rankAccounts(accounts, statuses, now, model);
	if (!ranked.length) return undefined;
	const mine = ranked.find((c) => c.id === current);
	if (mine && compareKeys(ranked[0].key, mine.key) <= 0) return undefined;
	return pick(ranked, random);
}

export function restoredAccount(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
): string | undefined {
	let selected: string | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ACCOUNT_ENTRY) continue;
		if (!object(entry.data) || typeof entry.data.id !== "string") throw new Error("Invalid saved Codex pool selection");
		selected = entry.data.id;
	}
	return selected;
}

async function readKeychain(id: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("keychain-secret", ["get", KEYCHAIN_SERVICE, id], { maxBuffer: 4096 });
		const secret = stdout.trim();
		if (!secret || secret.length > 512 || /\s/.test(secret)) throw new Error("Invalid internal credential");
		return secret;
	} catch {
		throw new Error(`Internal credential unavailable in Keychain for ${id}`);
	}
}

// One cancelled consumer must not cancel another consumer of an in-flight cache fill.
export async function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			cleanup();
			reject(signal.reason);
		};
		const cleanup = () => signal.removeEventListener("abort", abort);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
}

export class AccountPool {
	private tokens = new Map<string, Token>();
	private tokenRequests = new Map<string, Promise<Token>>();
	private quotas = new Map<string, Quota>();
	private quotaRequests = new Map<string, Promise<Quota>>();
	private controller = new AbortController();
	constructor(
		readonly config: PoolConfig,
		private dependencies: {
			fetch: typeof fetch;
			secret: (id: string) => Promise<string>;
			now: () => number;
		} = { fetch, secret: readKeychain, now: Date.now },
	) {}

	close(): void {
		this.controller.abort();
		this.tokens.clear();
		this.quotas.clear();
	}
	account(id: string): PoolAccount {
		const account = this.config.accounts.find((a) => a.id === id);
		if (!account) throw new Error(`Unknown Codex pool account: ${id}`);
		return account;
	}
	quota(id: string): Quota | undefined {
		return this.quotas.get(id);
	}

	async token(id: string, signal: AbortSignal): Promise<Token> {
		const account = this.account(id);
		const cached = this.tokens.get(id);
		signal.throwIfAborted();
		this.controller.signal.throwIfAborted();
		if (cached && cached.expires - this.dependencies.now() > 60_000) return cached;
		let pending = this.tokenRequests.get(id);
		if (!pending) {
			pending = (async () => {
				const secret = await this.dependencies.secret(id);
				const response = await this.dependencies.fetch(this.config.endpoint, {
					method: "POST",
					headers: { "Content-Type": "application/json", originator: "pi" },
					redirect: "error",
					body: JSON.stringify({
						client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
						grant_type: "refresh_token",
						refresh_token: secret,
					}),
					signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]),
				});
				if (!response.ok) throw new Error(`${id}: refresh HTTP ${response.status}`);
				let raw: unknown;
				try {
					raw = await response.json();
				} catch {
					throw new Error(`${id}: invalid refresh JSON`);
				}
				const token = parseToken(raw, account, this.dependencies.now());
				this.controller.signal.throwIfAborted();
				this.tokens.set(id, token);
				return token;
			})().finally(() => this.tokenRequests.delete(id));
			this.tokenRequests.set(id, pending);
		}
		return waitFor(pending, signal);
	}

	async sample(id: string, signal: AbortSignal, force = false): Promise<Quota> {
		this.account(id);
		signal.throwIfAborted();
		this.controller.signal.throwIfAborted();
		const cached = this.quotas.get(id);
		if (!force && cached && this.dependencies.now() - cached.sampledAt < 60_000) return cached;
		let pending = this.quotaRequests.get(id);
		if (!pending) {
			pending = (async () => {
				const token = await this.token(id, this.controller.signal);
				const response = await this.dependencies.fetch("https://chatgpt.com/backend-api/wham/usage", {
					headers: { Authorization: `Bearer ${token.access}`, "chatgpt-account-id": token.accountId, originator: "pi" },
					redirect: "error",
					signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]),
				});
				if (!response.ok) throw new Error(`${id}: usage HTTP ${response.status}`);
				let raw: unknown;
				try {
					raw = await response.json();
				} catch {
					throw new Error(`${id}: invalid usage JSON`);
				}
				const quota = parseQuota(raw, this.dependencies.now());
				this.controller.signal.throwIfAborted();
				this.quotas.set(id, quota);
				return quota;
			})().finally(() => this.quotaRequests.delete(id));
			this.quotaRequests.set(id, pending);
		}
		return waitFor(pending, signal);
	}

	async statuses(signal: AbortSignal, force = false): Promise<AccountStatus[]> {
		const statuses = await Promise.all(
			this.config.accounts.map(async (account) => {
				try {
					return { id: account.id, quota: await this.sample(account.id, signal, force) };
				} catch (error) {
					// No raw exception, response body, headers or token is sent to the UI/transcript.
					return {
						id: account.id,
						error:
							error instanceof Error && /^[-a-z0-9]+: (usage|refresh) HTTP \d+$/.test(error.message)
								? error.message
								: "unavailable (credential, network, or response validation)",
					};
				}
			}),
		);
		signal.throwIfAborted();
		return statuses;
	}
}

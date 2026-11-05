import type { OAuthCredential } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "openai-codex";
const REFRESH_URL_ENV = "CODEX_REFRESH_TOKEN_URL_OVERRIDE";
const CLIENT_ID_ENV = "CODEX_APP_SERVER_LOGIN_CLIENT_ID";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_STATUS_KEY = "openai-codex-usage";
const USAGE_REFRESH_INTERVAL_MS = 60_000;
const USAGE_REQUEST_TIMEOUT_MS = 15_000;
const USAGE_MAX_RESPONSE_BYTES = 128 * 1024;

const MINUTES = 60;
const HOURS = 60 * MINUTES;
const DAYS = 24 * HOURS;

const KNOWN_USAGE_WINDOWS: ReadonlyArray<{ seconds: number; label: string }> = [
	{ seconds: 5 * HOURS, label: "5h" },
	{ seconds: DAYS, label: "1d" },
	{ seconds: 7 * DAYS, label: "7d" },
	{ seconds: 30 * DAYS, label: "30d" },
];

type JsonObject = Record<string, unknown>;

type UsageWindow = {
	usedPercent: number;
	windowSeconds: number;
	resetAt?: number;
};

type UsageSnapshot = {
	windows: UsageWindow[];
	fetchedAt: number;
};

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function refreshEndpointOverride(): URL | undefined {
	const raw = process.env[REFRESH_URL_ENV]?.trim();
	if (!raw) return undefined;

	let endpoint: URL;
	try {
		endpoint = new URL(raw);
	} catch {
		throw new Error(`${REFRESH_URL_ENV} must be an absolute URL`);
	}

	if (endpoint.username || endpoint.password) {
		throw new Error(`${REFRESH_URL_ENV} must not contain URL credentials`);
	}
	if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && isLoopbackHostname(endpoint.hostname))) {
		throw new Error(`${REFRESH_URL_ENV} must use HTTPS (HTTP is allowed only for loopback testing)`);
	}

	return endpoint;
}

function oauthClientId(): string {
	return process.env[CLIENT_ID_ENV]?.trim() || DEFAULT_CLIENT_ID;
}

function decodeJwtPayload(token: string): JsonObject | undefined {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return undefined;

	try {
		const parsed: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		return isJsonObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function tokenExpiry(token: string, response: JsonObject): number {
	const expiresIn = response.expires_in;
	if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
		return Date.now() + expiresIn * 1000;
	}

	const exp = decodeJwtPayload(token)?.exp;
	if (typeof exp === "number" && Number.isFinite(exp)) {
		return exp * 1000;
	}

	throw new Error("OpenAI Codex token refresh response has no usable expiry");
}

function tokenAccountId(token: string): string | undefined {
	const auth = decodeJwtPayload(token)?.[JWT_AUTH_CLAIM];
	if (!isJsonObject(auth)) return undefined;
	const accountId = auth.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}

function safeErrorCode(value: unknown): string | undefined {
	if (!isJsonObject(value)) return undefined;
	const error = value.error;
	const candidate =
		typeof error === "string"
			? error
			: isJsonObject(error) && typeof error.code === "string"
				? error.code
				: typeof value.code === "string"
					? value.code
					: undefined;
	return candidate && /^[A-Za-z0-9._-]{1,80}$/.test(candidate) ? candidate : undefined;
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

async function refreshThroughOverride(
	credential: OAuthCredential,
	endpoint: URL,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	if (!credential.refresh) {
		throw new Error("OpenAI Codex OAuth credential has no refresh token");
	}

	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				originator: "pi",
			},
			body: JSON.stringify({
				client_id: oauthClientId(),
				grant_type: "refresh_token",
				refresh_token: credential.refresh,
			}),
			signal,
		});
	} catch (error) {
		if (signal.aborted) throw error;
		throw new Error(
			`OpenAI Codex token refresh request failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const raw: unknown = await readJson(response);
	if (!response.ok) {
		const code = safeErrorCode(raw);
		throw new Error(`OpenAI Codex token refresh failed (${response.status}${code ? `, ${code}` : ""})`);
	}
	if (!isJsonObject(raw)) {
		throw new Error("OpenAI Codex token refresh returned invalid JSON");
	}

	const access = raw.access_token;
	if (typeof access !== "string" || access.length === 0) {
		throw new Error("OpenAI Codex token refresh response is missing access_token");
	}
	const rotatedRefresh = raw.refresh_token;
	if (rotatedRefresh !== undefined && (typeof rotatedRefresh !== "string" || rotatedRefresh.length === 0)) {
		throw new Error("OpenAI Codex token refresh response contains an invalid refresh_token");
	}

	const expires = tokenExpiry(access, raw);
	if (expires <= Date.now()) {
		throw new Error("OpenAI Codex token refresh returned an expired access token");
	}

	const previousAccountId =
		typeof credential.accountId === "string" && credential.accountId.length > 0 ? credential.accountId : undefined;
	const refreshedAccountId = tokenAccountId(access);
	if (previousAccountId && refreshedAccountId && previousAccountId !== refreshedAccountId) {
		throw new Error("OpenAI Codex token refresh returned a token for a different account");
	}
	const accountId = refreshedAccountId ?? previousAccountId;
	if (!accountId) {
		throw new Error("OpenAI Codex token refresh response has no account id");
	}

	return {
		...credential,
		type: "oauth",
		access,
		refresh: typeof rotatedRefresh === "string" ? rotatedRefresh : credential.refresh,
		expires,
		accountId,
	};
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseUsageWindow(value: unknown): UsageWindow | undefined {
	if (!isJsonObject(value)) return undefined;
	const usedPercent = numberValue(value.used_percent);
	const windowSeconds = numberValue(value.limit_window_seconds);
	if (usedPercent === undefined || windowSeconds === undefined || windowSeconds <= 0) return undefined;
	const resetAt = numberValue(value.reset_at);
	return {
		usedPercent: Math.min(100, Math.max(0, usedPercent)),
		windowSeconds,
		...(resetAt !== undefined && resetAt > 0 ? { resetAt } : {}),
	};
}

function parseUsageSnapshot(value: unknown): UsageSnapshot {
	if (!isJsonObject(value) || !isJsonObject(value.rate_limit)) {
		throw new Error("OpenAI Codex usage response has no rate-limit data");
	}

	const windows = [
		parseUsageWindow(value.rate_limit.primary_window),
		parseUsageWindow(value.rate_limit.secondary_window),
	]
		.filter((window): window is UsageWindow => window !== undefined)
		.sort((left, right) => left.windowSeconds - right.windowSeconds);

	if (windows.length === 0) {
		throw new Error("OpenAI Codex usage response has no usage windows");
	}
	return { windows, fetchedAt: Date.now() };
}

function approximately(value: number, expected: number): boolean {
	return value >= expected * 0.95 && value <= expected * 1.05;
}

function usageWindowLabel(seconds: number): string {
	const known = KNOWN_USAGE_WINDOWS.find((window) => approximately(seconds, window.seconds));
	if (known) return known.label;
	if (seconds >= DAYS) return `${Math.max(1, Math.round(seconds / DAYS))}d`;
	if (seconds >= HOURS) return `${Math.max(1, Math.round(seconds / HOURS))}h`;
	return `${Math.max(1, Math.round(seconds / MINUTES))}m`;
}

function formatPercent(value: number): string {
	return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function formatUsageStatus(snapshot: UsageSnapshot, failed = false): string {
	const stale = failed || Date.now() - snapshot.fetchedAt >= USAGE_REFRESH_INTERVAL_MS;
	const windows = snapshot.windows
		.map((window) => {
			const reset = formatReset(window.resetAt);
			return `${usageWindowLabel(window.windowSeconds)} ${formatPercent(window.usedPercent)}%${reset ? ` ↻ ${reset}` : ""}`;
		})
		.join(" · ");
	return `${stale ? "stale · " : ""}${windows} · sampled ${new Date(snapshot.fetchedAt).toLocaleTimeString()}`;
}

function formatReset(resetAt: number | undefined): string | undefined {
	if (resetAt === undefined) return undefined;
	const totalMinutes = Math.max(0, Math.ceil((resetAt * 1000 - Date.now()) / 60_000));
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : ""}`;
	if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
	return `${minutes}m`;
}

function isOfficialCodexContext(ctx: ExtensionContext): boolean {
	if (ctx.model?.provider !== PROVIDER_ID) return false;
	const rawBaseUrl = ctx.model.baseUrl || ctx.modelRegistry.getProvider(PROVIDER_ID)?.baseUrl;
	if (!rawBaseUrl) return false;
	try {
		return new URL(rawBaseUrl).origin === "https://chatgpt.com";
	} catch {
		return false;
	}
}

async function fetchUsageSnapshot(ctx: ExtensionContext, signal: AbortSignal): Promise<UsageSnapshot> {
	if (!ctx.model || !isOfficialCodexContext(ctx)) {
		throw new Error("OpenAI Codex usage is available only for the official openai-codex provider");
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	signal.throwIfAborted();
	if (!auth.ok) throw new Error("OpenAI Codex authentication is unavailable");
	if (auth.baseUrl) {
		let origin: string;
		try {
			origin = new URL(auth.baseUrl).origin;
		} catch {
			throw new Error("OpenAI Codex resolved an invalid provider URL");
		}
		if (origin !== "https://chatgpt.com") {
			throw new Error("Refusing to send OpenAI Codex credentials from a custom provider URL");
		}
	}

	const access = auth.apiKey;
	if (!access) throw new Error("OpenAI Codex authentication returned no access token");
	const accountId = tokenAccountId(access);
	if (!accountId) throw new Error("OpenAI Codex access token has no account id");

	const response = await fetch(USAGE_URL, {
		method: "GET",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${access}`,
			"chatgpt-account-id": accountId,
			originator: "pi",
		},
		redirect: "error",
		signal,
	});
	if (!response.ok) {
		throw new Error(`OpenAI Codex usage request failed (${response.status})`);
	}

	const body = await response.text();
	if (Buffer.byteLength(body, "utf8") > USAGE_MAX_RESPONSE_BYTES) {
		throw new Error("OpenAI Codex usage response was unexpectedly large");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("OpenAI Codex usage response was not valid JSON");
	}
	return parseUsageSnapshot(parsed);
}

export default function openAICodexExtension(pi: ExtensionAPI): void {
	const provider = builtinProviders().find((candidate) => candidate.id === PROVIDER_ID);
	if (!provider) {
		throw new Error("Pi's built-in openai-codex provider is unavailable");
	}
	const builtInOAuth = provider.auth.oauth;
	if (!builtInOAuth) {
		throw new Error("Pi's built-in openai-codex provider does not expose OAuth");
	}

	// A native Provider registration replaces Pi's remote-catalog wrapper too.
	// Override only OAuth so Pi retains ownership of models and catalog refreshes.
	pi.registerProvider(PROVIDER_ID, {
		oauth: {
			name: builtInOAuth.name,
			isSubscription: builtInOAuth.isSubscription,
			async login(callbacks) {
				return builtInOAuth.login({
					signal: callbacks.signal ?? new AbortController().signal,
					notify(event) {
						switch (event.type) {
							case "auth_url": callbacks.onAuth(event); break;
							case "device_code": callbacks.onDeviceCode(event); break;
							case "progress": callbacks.onProgress?.(event.message); break;
							case "info": callbacks.onProgress?.(event.message); break;
						}
					},
					async prompt(prompt) {
						if (prompt.type === "select") {
							const selection = await callbacks.onSelect({ message: prompt.message, options: [...prompt.options] });
							if (selection === undefined) throw new Error("OpenAI Codex login cancelled");
							return selection;
						}
						return callbacks.onPrompt(prompt);
					},
				});
			},
			async refreshToken(credential, signal) {
				const nativeCredential: OAuthCredential = { ...credential, type: "oauth" };
				const endpoint = refreshEndpointOverride();
				return endpoint
					? refreshThroughOverride(nativeCredential, endpoint, signal)
					: builtInOAuth.refresh(nativeCredential, signal);
			},
			getApiKey: (credential) => credential.access,
		},
	});

	let activeContext: ExtensionContext | undefined;
	let sessionGeneration = 0;
	let lastSnapshot: UsageSnapshot | undefined;
	let lastAttemptAt = -Infinity;
	let refreshFailed = false;
	let interval: ReturnType<typeof setInterval> | undefined;
	let inFlight: { generation: number; promise: Promise<UsageSnapshot> } | undefined;
	const controllers = new Set<AbortController>();

	const clearUsageStatus = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
	};

	const abortUsageRequests = () => {
		for (const controller of controllers) controller.abort();
		controllers.clear();
	};

	const loadUsage = (ctx: ExtensionContext, generation: number): Promise<UsageSnapshot> => {
		if (inFlight?.generation === generation) return inFlight.promise;

		lastAttemptAt = Date.now();
		const controller = new AbortController();
		controllers.add(controller);
		const timeout = setTimeout(() => controller.abort(), USAGE_REQUEST_TIMEOUT_MS);
		const request = fetchUsageSnapshot(ctx, controller.signal).finally(() => {
			clearTimeout(timeout);
			controllers.delete(controller);
			if (inFlight?.promise === request) inFlight = undefined;
		});
		inFlight = { generation, promise: request };
		return request;
	};

	const refreshUsage = async (ctx: ExtensionContext, notifyOnError = false, force = false): Promise<UsageSnapshot | undefined> => {
		activeContext = ctx;
		if (!ctx.hasUI || !isOfficialCodexContext(ctx)) {
			clearUsageStatus(ctx);
			return undefined;
		}

		const generation = sessionGeneration;
		const publishCached = () => activeContext?.ui.setStatus(USAGE_STATUS_KEY,
			lastSnapshot ? formatUsageStatus(lastSnapshot, refreshFailed) : "unavailable");
		if (!force && inFlight?.generation !== generation && (
			(lastSnapshot && Date.now() - lastSnapshot.fetchedAt < USAGE_REFRESH_INTERVAL_MS)
			|| Date.now() - lastAttemptAt < USAGE_REFRESH_INTERVAL_MS
		)) {
			publishCached();
			return lastSnapshot;
		}
		if (lastSnapshot) publishCached();
		try {
			const snapshot = await loadUsage(ctx, generation);
			if (generation !== sessionGeneration || !activeContext || !isOfficialCodexContext(activeContext)) {
				return undefined;
			}
			lastSnapshot = snapshot;
			refreshFailed = false;
			activeContext.ui.setStatus(USAGE_STATUS_KEY, formatUsageStatus(snapshot));
			return snapshot;
		} catch (error) {
			if (generation !== sessionGeneration || !activeContext || !isOfficialCodexContext(activeContext)) return undefined;
			refreshFailed = true;
			publishCached();
			if (notifyOnError) {
				ctx.ui.notify(error instanceof Error ? error.message : "OpenAI Codex usage refresh failed", "warning");
			}
			return undefined;
		}
	};

	const startUsage = (ctx: ExtensionContext) => {
		sessionGeneration += 1;
		activeContext = ctx;
		lastSnapshot = undefined;
		lastAttemptAt = -Infinity;
		refreshFailed = false;
		abortUsageRequests();
		if (interval) clearInterval(interval);
		interval = undefined;

		clearUsageStatus(ctx);
		if (!ctx.hasUI || !isOfficialCodexContext(ctx)) return;

		void refreshUsage(ctx);
		interval = setInterval(() => {
			if (activeContext) void refreshUsage(activeContext);
		}, USAGE_REFRESH_INTERVAL_MS);
		interval.unref?.();
	};

	pi.on("session_start", (_event, ctx) => startUsage(ctx));
	pi.on("model_select", (_event, ctx) => {
		if (interval && ctx.hasUI && isOfficialCodexContext(ctx)) void refreshUsage(ctx);
		else startUsage(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => void refreshUsage(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		sessionGeneration += 1;
		activeContext = undefined;
		abortUsageRequests();
		if (interval) clearInterval(interval);
		interval = undefined;
		clearUsageStatus(ctx);
	});

	pi.registerCommand("codex-provider-usage", {
		description: "Refresh usage for Pi's active OpenAI Codex provider account",
		handler: async (_args, ctx) => {
			const snapshot = await refreshUsage(ctx, true, true);
			if (!snapshot) return;
			const lines = snapshot.windows.map((window) => {
				const reset = formatReset(window.resetAt);
				return `${usageWindowLabel(window.windowSeconds)}: ${formatPercent(window.usedPercent)}% used${reset ? `, resets in ${reset}` : ""}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

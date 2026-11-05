import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";
import {
	ACCOUNT_ENTRY,
	AccountPool,
	chooseAccount,
	limited,
	loadConfig,
	POOL_PROVIDER,
	rebalance,
	restoredAccount,
	waitFor,
	type PoolConfig,
} from "../lib/codex-pool.ts";

import { accountList, accountFooter, exhaustedNotice } from "../lib/codex-pool-display.ts";

const ORIGINAL = "openai-codex";
const STATUS = "codex-pool";
// Switching accounts forfeits the prompt cache, so a running session only
// re-evaluates when that cost is negligible: the cache has expired after idling,
// or the context is still small. A limited account moves regardless.
const COLD_AFTER_MS = 60 * 60_000;
const SMALL_CONTEXT_TOKENS = 24_000;

function official(model: { baseUrl?: string }): boolean {
	try {
		return new URL(model.baseUrl ?? "").origin === "https://chatgpt.com";
	} catch {
		return false;
	}
}

export function installPool(pi: ExtensionAPI, config: PoolConfig, makePool = () => new AccountPool(config)): void {
	let pool = makePool();
	let closed = false;
	const builtin = builtinProviders().find((p) => p.id === ORIGINAL);
	if (!builtin) throw new Error("Pi's built-in Codex provider is unavailable");
	let cachedModels = builtin
		.getModels()
		.filter(official)
		.map((m) => ({ ...m, provider: POOL_PROVIDER }));
	let context: ExtensionContext | undefined;
	const models = () =>
		context
			? (context.modelRegistry.getProvider(ORIGINAL) ?? builtin)
					.getModels()
					.filter(official)
					.map((m) => ({ ...m, provider: POOL_PROVIDER }))
			: cachedModels;
	let selected: string | undefined;
	let selectionError: Error | undefined;
	let generation = 0;
	let selection: Promise<string> | undefined;
	let switching: Promise<unknown> | undefined;
	let operation = new AbortController();
	let lastActivity = 0;

	const publish = () => {
		if (!context?.hasUI) return;
		if (context.model?.provider !== POOL_PROVIDER) {
			context.ui.setStatus(STATUS, undefined);
			return;
		}
		const quota = selected ? pool.quota(selected) : undefined;
		context.ui.setStatus(
			STATUS,
			selectionError
				? "账号不可用 · /codex 查看"
				: accountFooter(
						config.accounts.find((a) => a.id === selected),
						quota,
					),
		);
	};

	const remember = (id: string) => {
		pool.account(id);
		pi.appendEntry(ACCOUNT_ENTRY, { id });
		selected = id;
		selectionError = undefined;
		publish();
	};

	const selectAutomatically = async (signal: AbortSignal): Promise<string> => {
		if (selectionError) throw selectionError;
		if (selected) return selected;
		if (!context) throw new Error("Codex account pool is not attached to a session yet");
		if (!selection) {
			const currentGeneration = generation;
			const currentSignal = operation.signal;
			const pending = (async () => {
				const statuses = await pool.statuses(currentSignal);
				const id = chooseAccount(config.accounts, statuses, Date.now(), Math.random(), context?.model?.id);
				currentSignal.throwIfAborted();
				if (currentGeneration !== generation) throw new Error("Codex account selection superseded");
				remember(id);
				return id;
			})();
			selection = pending;
			void pending
				.finally(() => {
					if (selection === pending) selection = undefined;
				})
				.catch(() => {});
		}
		return waitFor(selection, signal);
	};

	// Separate credential namespace: never refresh/overwrite the user's original
	// provider credential. Streaming remains Pi's built-in Codex implementation.
	pi.registerProvider({
		...builtin,
		id: POOL_PROVIDER,
		name: "Codex account pool",
		getModels: models,
		getAllModels: models,
		// Restore our mirror before SDK startup/resume selects a model. Once the
		// session is attached, the original composed catalog remains authoritative.
		refreshModels: async (refresh) => {
			if (!context) {
				const restored = refresh.stored?.models.filter(
					(m): m is Model<Api> =>
						m.provider === POOL_PROVIDER && (m.type === undefined || m.type === "chat") && official(m),
				);
				if (restored?.length)
					await refresh.publish({
						update: () => {
							cachedModels = restored;
						},
					});
				return;
			}
			const snapshot = models();
			await refresh.publish({
				persist: { models: snapshot, checkedAt: Date.now() },
				update: () => {
					cachedModels = snapshot;
				},
			});
		},
		auth: {
			apiKey: {
				name: "RackNerd internal account credentials (Keychain)",
				check: async () => ({ type: "api_key", source: "Codex account pool" }),
				resolve: async ({ signal }) => {
					// Pi also resolves auth for background catalog refreshes. A pool
					// that is not attached/selected must remain credential-free.
					if (!context || context.model?.provider !== POOL_PROVIDER) return undefined;
					// A pending command is a barrier, not a request replay. Its failure
					// is reported by the command; requests retain the previous selection.
					if (switching)
						await waitFor(
							switching.catch(() => {}),
							signal,
						);
					const id = await selectAutomatically(signal);
					const currentGeneration = generation;
					const token = await pool.token(id, signal);
					if (currentGeneration !== generation)
						throw new Error("Codex account selection changed during authentication");
					return { auth: { apiKey: token.access }, source: `Codex pool: ${id}` };
				},
			},
		},
	});

	const restore = (ctx: ExtensionContext) => {
		if (closed) {
			pool = makePool();
			closed = false;
		}
		generation++;
		operation.abort();
		operation = new AbortController();
		selection = undefined;
		context = ctx;
		selectionError = undefined;
		const branch = ctx.sessionManager.getBranch();
		lastActivity = Math.max(0, ...branch.map((e) => Date.parse(e.timestamp)).filter(Number.isFinite));
		try {
			selected = restoredAccount(branch);
			if (selected) pool.account(selected);
		} catch (error) {
			selected = undefined;
			selectionError = error instanceof Error ? error : new Error("Saved account is unavailable");
		}
		publish();
	};

	const enablePool = async (ctx: ExtensionContext) => {
		if (ctx.model?.provider === POOL_PROVIDER) return;
		if (ctx.model?.provider !== ORIGINAL || !official(ctx.model))
			throw new Error("Select an official OpenAI Codex model first");
		const model = ctx.modelRegistry.find(POOL_PROVIDER, ctx.model.id);
		if (!model || !(await pi.setModel(model))) throw new Error("Could not select the pooled Codex model");
	};

	const syncCatalog = async (ctx: ExtensionContext) => {
		const result = await ctx.modelRegistry.refresh({ providers: [POOL_PROVIDER], allowNetwork: false });
		const error = result.errors.get(POOL_PROVIDER);
		if (error) throw new Error("Could not save the Codex pool catalog for session resume", { cause: error });
	};

	// Pi replaces the session's model object when a provider registers, not when a
	// catalog refresh publishes new metadata. A session resumed on the pool keeps the
	// pre-attach copy (e.g. the built-in 272k window without models.json overrides),
	// which sizes compaction and the context meter, until the live entry is adopted.
	const adoptLiveModel = async (ctx: ExtensionContext) => {
		if (ctx.model?.provider !== POOL_PROVIDER) return;
		const live = ctx.modelRegistry.find(POOL_PROVIDER, ctx.model.id);
		if (live && !isDeepStrictEqual(live, ctx.model) && !(await pi.setModel(live)))
			throw new Error("Could not adopt the current Codex pool model metadata");
	};

	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
		await syncCatalog(ctx);
		await adoptLiveModel(ctx);
		if (config.autoEnable && ctx.model?.provider === ORIGINAL && official(ctx.model)) await enablePool(ctx);
		publish();
	});
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("model_select", async (_event, ctx) => {
		context = ctx;
		if (ctx.model?.provider === POOL_PROVIDER) {
			await syncCatalog(ctx);
			await adoptLiveModel(ctx);
		}
		publish();
	});
	// Runs before the run's first auth resolution, so a move here never splits a run.
	pi.on("before_agent_start", async (_event, ctx) => {
		if (ctx.model?.provider !== POOL_PROVIDER || !selected || switching) return;
		const current = selected;
		const model = ctx.model.id;
		const quota = pool.quota(current);
		const exhausted = quota !== undefined && limited(quota, model);
		const tokens = ctx.getContextUsage()?.tokens;
		const cheap = Date.now() - lastActivity >= COLD_AFTER_MS || (tokens != null && tokens < SMALL_CONTEXT_TOKENS);
		if (!exhausted && !cheap) return;
		const currentGeneration = generation;
		const signal = ctx.signal ? AbortSignal.any([operation.signal, ctx.signal]) : operation.signal;
		switching = (async () => {
			const statuses = await pool.statuses(signal);
			const next = rebalance(config.accounts, statuses, current, Date.now(), Math.random(), model);
			if (!next || currentGeneration !== generation || selected !== current) return;
			generation++;
			selection = undefined;
			remember(next);
			if (ctx.hasUI)
				ctx.ui.notify(
					`Codex 账号：${current} → ${next}（${exhausted ? "原账号额度不足" : "缓存已冷或上下文较小，按额度进度重新分配"}）。未重放任何请求。`,
					"info",
				);
		})();
		try {
			await switching;
		} catch (error) {
			// Rebalancing is an optimization; the run keeps the current account.
			if (!signal.aborted) throw error;
		} finally {
			switching = undefined;
		}
	});
	// A request refused for quota produced no tool call, so nothing has run that a
	// continuation could repeat. Omitting the failed attempt (as Pi's own retry does)
	// and continuing on another account resumes the same run; the usage API, not the
	// error text, decides whether the account is actually limited.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "error" || ctx.model?.provider !== POOL_PROVIDER || !selected || switching) return;
		const failedEntry = event.context.contextEntries.at(-1);
		const failed = failedEntry?.messages.at(-1);
		if (
			!failedEntry ||
			failed?.role !== "assistant" ||
			failed.stopReason !== "error" ||
			failed.content.some((block) => block.type === "toolCall")
		)
			return;
		const current = selected;
		const model = ctx.model.id;
		const currentGeneration = generation;
		const signal = operation.signal;
		const pending = (async () => {
			if (!limited(await pool.sample(current, signal, true), model)) return undefined;
			const statuses = await pool.statuses(signal);
			const next = rebalance(config.accounts, statuses, current, Date.now(), Math.random(), model);
			if (currentGeneration !== generation || selected !== current) return undefined;
			// The current account is limited, so no target means none is assignable.
			if (!next) {
				if (ctx.hasUI) ctx.ui.notify(exhaustedNotice(config.accounts, statuses), "warning");
				return undefined;
			}
			generation++;
			selection = undefined;
			remember(next);
			if (ctx.hasUI) ctx.ui.notify(`Codex 账号 ${current} 额度用尽，已切换到 ${next} 并继续当前任务。`, "info");
			return next;
		})();
		switching = pending;
		try {
			if (!(await pending)) return;
		} catch (error) {
			if (signal.aborted) return;
			throw error;
		} finally {
			switching = undefined;
		}
		return {
			entries: [...event.entries, { type: "context_edit", targetId: failedEntry.sourceEntry.id, replacement: null }],
			continue: true,
		};
	});
	pi.on("agent_settled", async (_event, ctx) => {
		lastActivity = Date.now();
		if (ctx.model?.provider !== POOL_PROVIDER || !selected) return;
		const id = selected;
		const currentGeneration = generation;
		try {
			// Forced: this sample is what a run-boundary rebalance judges the run by.
			await pool.sample(id, operation.signal, true);
		} catch {
			if (currentGeneration === generation && ctx.hasUI) ctx.ui.setStatus(STATUS, `${id} · usage unavailable`);
			return;
		}
		if (currentGeneration === generation) publish();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		generation++;
		operation.abort();
		pool.close();
		closed = true;
		context = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS, undefined);
	});

	const accountCommand = {
		description: "Interactive Codex account picker; list | auto | <account id>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			let command = args.trim() || "list";
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait until the current run finishes before changing or inspecting accounts", "warning");
				return;
			}
			if (command === "list") {
				const pickerGeneration = generation;
				while (true) {
					const statuses = await pool.statuses(operation.signal, true);
					publish();
					if (ctx.mode !== "tui") {
						ctx.ui.notify(accountList(config.accounts, statuses, selected), "info");
						return;
					}
					const { pickAccount } = await import("../lib/codex-account-picker.ts");
					const choice = await pickAccount(ctx, config.accounts, statuses, selected);
					if (choice === undefined || pickerGeneration !== generation) return;
					if (!ctx.isIdle()) {
						ctx.ui.notify("Wait until the current run finishes before changing accounts", "warning");
						return;
					}
					if (choice.action === "refresh") continue;
					command = choice.action === "auto" ? "auto" : choice.id;
					if (command === selected) return;
					break;
				}
			}
			// Validate first; a typo must not alter the previous selection or model.
			if (command !== "auto") pool.account(command);
			if (ctx.model?.provider !== POOL_PROVIDER && (ctx.model?.provider !== ORIGINAL || !official(ctx.model))) {
				ctx.ui.notify("Select an official OpenAI Codex model first", "warning");
				return;
			}
			if (switching) {
				ctx.ui.notify("An account switch is already pending", "warning");
				return;
			}
			const currentGeneration = generation;
			const signal = operation.signal;
			switching = (async () => {
				const id =
					command === "auto"
						? chooseAccount(
								config.accounts,
								await pool.statuses(signal, true),
								Date.now(),
								Math.random(),
								ctx.model?.id,
							)
						: command;
				await pool.token(id, signal);
				signal.throwIfAborted();
				if (currentGeneration !== generation || !ctx.isIdle()) return;
				await enablePool(ctx);
				signal.throwIfAborted();
				if (currentGeneration !== generation || !ctx.isIdle()) return;
				generation++;
				selection = undefined;
				remember(id);
				ctx.ui.notify(`Codex account: ${id}. Future requests use this account; no request was replayed.`, "info");
			})();
			try {
				await switching;
			} finally {
				switching = undefined;
			}
		},
	};
	pi.registerCommand("codex", accountCommand);
}

export default function codexPoolExtension(pi: ExtensionAPI): void {
	const config = loadConfig();
	if (config) installPool(pi, config);
}

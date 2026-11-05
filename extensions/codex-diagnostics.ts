import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const MAX_BYTES = 1024 * 1024;
const RESPONSE_HEADERS = new Set(["x-request-id", "request-id", "x-openai-request-id", "cf-ray"]);

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}
function identifier(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value) ? value : undefined;
}
// Never persist arbitrary error prose: it can contain echoed prompts or credentials.
function errorMetadata(value: unknown): ObjectValue {
	const error = object(value);
	const message = typeof error.message === "string" ? error.message : "";
	return {
		code: identifier(error.code),
		classification: /Unable to verify Daybreak Blue access\. Please try again\./.test(message)
			? "daybreak_blue_access_verification_failed" : message ? "other_error_message_omitted" : undefined,
	};
}

/** Metadata only for Pi's main agent requests; direct nested provider calls may bypass these hooks. */
export default function codexDiagnostics(
	pi: ExtensionAPI,
	logDirectory = join(getAgentDir(), "logs", "codex-diagnostics"),
): void {
	// Separate files avoid cross-process rotation races. Each process keeps at most two 1 MiB files.
	const logFile = join(logDirectory, `${process.pid}.jsonl`);
	let ready = false;
	let warned = false;
	let request: { id: string; started: number; sawHttpResponse: boolean; sawStream: boolean } | undefined;
	const write = (event: string, fields: ObjectValue = {}) => {
		try {
			if (!ready) {
				mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
				chmodSync(logDirectory, 0o700);
				for (const name of readdirSync(logDirectory)) {
					if (!/^\d+\.jsonl(?:\.1)?$/.test(name)) continue;
					try {
						const path = join(logDirectory, name);
						if (Date.now() - statSync(path).mtimeMs > 7 * 86400_000) unlinkSync(path);
					} catch { /* Another process may have rotated or removed an old log. */ }
				}
				ready = true;
			}
			const line = JSON.stringify({ time: new Date().toISOString(), pid: process.pid,
				request: request?.id, event, ...fields }) + "\n";
			if (existsSync(logFile) && statSync(logFile).size + Buffer.byteLength(line) > MAX_BYTES) {
				renameSync(logFile, `${logFile}.1`);
			}
			appendFileSync(logFile, line, { mode: 0o600 });
			chmodSync(logFile, 0o600);
		} catch {
			// Diagnostics must not turn an otherwise successful provider request into a failure.
			if (!warned) {
				warned = true;
				console.error("[codex-diagnostics] Unable to write metadata log; provider requests are unchanged.");
			}
		}
	};

	pi.on("session_start", () => { request = undefined; });
	pi.on("session_shutdown", () => { request = undefined; });
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER) { request = undefined; return; }
		request = { id: randomUUID(), started: Date.now(), sawHttpResponse: false, sawStream: false };
		const payload = object(event.payload);
		let endpointOrigin: string | undefined;
		try { endpointOrigin = new URL(ctx.model.baseUrl).origin; } catch { /* no URL available */ }
		write("request", {
			session: identifier(ctx.sessionManager.getSessionId()),
			selected_model: identifier(ctx.model.id),
			payload_model: identifier(payload.model),
			endpoint_origin: endpointOrigin,
		});
		// Notification only: never return a payload replacement.
	});
	pi.on("after_provider_response", (event, ctx) => {
		if (!request || ctx.model?.provider !== PROVIDER) return;
		request.sawHttpResponse = true;
		const headers: ObjectValue = {};
		for (const [key, value] of Object.entries(event.headers)) {
			if (RESPONSE_HEADERS.has(key.toLowerCase())) headers[key.toLowerCase()] = identifier(value);
		}
		// The built-in Codex implementation calls onResponse only on the HTTP/SSE path.
		write("http_response", { status: event.status, transport: "sse", headers });
	});
	pi.on("provider_stream_event", event => {
		if (!request || event.provider !== PROVIDER) return;
		const data = object(event.data);
		const response = object(data.response);
		if (!request.sawStream) {
			request.sawStream = true;
			write("stream_start", { model: identifier(event.model),
				transport: request.sawHttpResponse ? "sse" : "websocket_inferred" });
		}
		if (data.type === "response.created") {
			write("response_created", { response_id: identifier(response.id), model: identifier(response.model) });
		} else if (data.type === "error" || data.type === "response.failed") {
			const nested = object(data.error);
			const error = data.type === "response.failed" ? response.error : {
				code: data.code ?? nested.code, message: data.message ?? nested.message,
			};
			write("provider_error", { type: data.type, model: identifier(event.model),
				request_id: identifier(data.request_id ?? object(error).request_id),
				response_id: identifier(response.id), ...errorMetadata(error) });
		}
		// Deliberately ignore deltas, output items, tool arguments, and all other response content.
	});
	pi.on("message_end", event => {
		const message = event.message;
		if (!request || message.role !== "assistant" || message.provider !== PROVIDER) return;
		write("request_end", { model: identifier(message.model), stop_reason: message.stopReason,
			duration_ms: Date.now() - request.started,
			...errorMetadata({ message: message.errorMessage }) });
		request = undefined;
	});
}

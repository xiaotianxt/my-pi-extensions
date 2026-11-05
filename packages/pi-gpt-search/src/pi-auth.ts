import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexAuthCredentials } from "./codex-provider.js";

export async function resolvePiCodexAuth(ctx: ExtensionContext): Promise<CodexAuthCredentials> {
  const model = ctx.model;
  if (!model || (model.provider !== "openai-codex" && model.provider !== "codex-pool")) {
    throw new Error("Codex search requires an active openai-codex or codex-pool model in Pi.");
  }
  if (new URL(model.baseUrl).origin !== "https://chatgpt.com") {
    throw new Error("Codex search requires the official ChatGPT provider endpoint.");
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error("Pi could not resolve the active Codex credential.");
  if (auth.baseUrl && new URL(auth.baseUrl).origin !== "https://chatgpt.com") {
    throw new Error("Refusing to send custom-provider credentials to Codex search.");
  }
  const payload = JSON.parse(Buffer.from(auth.apiKey.split(".")[1], "base64url").toString("utf8"));
  const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (typeof accountId !== "string" || !accountId) {
    throw new Error("Pi's Codex access token has no account ID.");
  }
  return { accessToken: auth.apiKey, accountId };
}

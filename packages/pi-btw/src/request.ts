import { randomUUID } from "node:crypto";
import { normalizeContext, type Api, type Context, type Model, type Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

type Registry = Pick<ModelRegistry, "getProvider" | "getApiKeyAndHeaders">;

export async function answerQuestion(options: {
  registry: Registry;
  model: Model<Api>;
  context: Context;
  signal: AbortSignal;
  onText: (text: string) => void;
}): Promise<{ usage: Usage; limited: boolean }> {
  const { registry, model, context, signal, onText } = options;
  signal.throwIfAborted();
  const provider = registry.getProvider(model.provider);
  if (!provider) throw new Error(`Provider not available: ${model.provider}`);
  const auth = await registry.getApiKeyAndHeaders(model);
  // The facade has no cancellable auth method. Dismissal during OAuth refresh
  // must still prevent a late model request once that refresh resolves.
  signal.throwIfAborted();
  if (!auth.ok) throw new Error(auth.error);
  const controller = new AbortController();
  let text = "";
  try {
    const stream = provider.streamSimple(
      auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
      normalizeContext({ ...context, tools: [] }),
      {
        apiKey: auth.apiKey, headers: auth.headers, env: auth.env,
        signal: AbortSignal.any([signal, controller.signal]),
        reasoning: "low", maxTokens: Math.min(2048, model.maxTokens),
        cacheRetention: "none", sessionId: randomUUID(),
      },
    );
    for await (const event of stream) {
      signal.throwIfAborted();
      if (event.type === "text_delta") {
        text += event.delta;
        onText(text);
      } else if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
        throw new Error("The model requested a tool. Nothing was executed; /btw is read-only.");
      } else if (event.type === "error") {
        throw new Error(event.error.errorMessage || `Provider stopped: ${event.reason}`);
      } else if (event.type === "done") {
        if (event.message.content.some((block) => block.type === "toolCall")) {
          throw new Error("The model requested a tool. Nothing was executed; /btw is read-only.");
        }
        text = event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
        if (!text.trim()) throw new Error("The model returned no text answer.");
        onText(text);
        return { usage: event.message.usage, limited: event.reason === "length" };
      }
    }
    throw new Error("The provider stream ended without a final response.");
  } finally {
    controller.abort();
  }
}

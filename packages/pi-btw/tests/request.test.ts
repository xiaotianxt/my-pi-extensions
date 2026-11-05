import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentSystemPrompt, getCurrentTools, createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type Provider, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { answerQuestion } from "../src/request.ts";

const model: Model<"openai-responses"> = {
  id: "test", name: "Test", provider: "test", api: "openai-responses", baseUrl: "http://unused.invalid",
  reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const response: AssistantMessage = {
  role: "assistant", api: model.api, provider: "test", model: "test", timestamp: 0,
  content: [{ type: "text", text: '{"command":"this is an example, not a tool call"}' }], stopReason: "stop",
  usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
const context: Context = { systemPrompt: "Answer only the side question.", messages: [{ role: "user", content: "question", timestamp: 0 }] };

function provider(streamSimple: Provider["streamSimple"]): Provider {
  return { id: "test", name: "Test", auth: {}, getModels: () => [model], streamSimple, stream: () => { throw new Error("Unexpected stream API"); } };
}

test("dispatch uses registered provider and resolved endpoint, preserves JSON answers, and has no tools", async () => {
  let requestOptions: SimpleStreamOptions | undefined;
  let answer = "";
  const registered = provider((sentModel, sentContext, options) => {
    requestOptions = options;
    assert.equal(sentModel.baseUrl, "http://resolved.invalid");
    assert.deepEqual(getCurrentTools(sentContext.messages), []);
    assert.equal(getCurrentSystemPrompt(sentContext.messages), context.systemPrompt);
    assert.equal(sentContext.messages[0].role, "system");
    assert.deepEqual(options?.headers, { "x-test": "test" });
    assert.deepEqual(options?.env, { TEST_ENV: "test" });
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "text_delta", contentIndex: 0, delta: "{", partial: response });
    stream.push({ type: "done", reason: "stop", message: response });
    return stream;
  });
  const result = await answerQuestion({
    registry: { getProvider: () => registered, getApiKeyAndHeaders: async () => ({ ok: true, baseUrl: "http://resolved.invalid", headers: { "x-test": "test" }, env: { TEST_ENV: "test" } }) },
    model, context, signal: new AbortController().signal, onText: (text) => { answer = text; },
  });
  assert.equal(answer, response.content[0].type === "text" ? response.content[0].text : "");
  assert.equal(result.limited, false);
  assert.ok(requestOptions?.sessionId);
  assert.equal(requestOptions?.cacheRetention, "none");
  assert.equal(requestOptions?.signal?.aborted, true); // request scope disposed
});

test("dismissal during auth cannot start a late model request", async () => {
  const controller = new AbortController();
  const auth = Promise.withResolvers<{ ok: true }>();
  let calls = 0;
  const registered = provider(() => { calls++; return createAssistantMessageEventStream(); });
  const request = answerQuestion({
    registry: { getProvider: () => registered, getApiKeyAndHeaders: () => auth.promise },
    model, context, signal: controller.signal, onText: () => assert.fail("late UI update"),
  });
  controller.abort();
  auth.resolve({ ok: true });
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(calls, 0);
});

test("structured tool output is rejected and its request is cancelled, with no execution loop", async () => {
  let signal: AbortSignal | undefined;
  const registered = provider((_model, _context, options) => {
    signal = options?.signal;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: { ...response, content: [{ type: "toolCall", id: "x", name: "bash", arguments: {} }] } });
    return stream;
  });
  await assert.rejects(answerQuestion({
    registry: { getProvider: () => registered, getApiKeyAndHeaders: async () => ({ ok: true }) },
    model, context, signal: new AbortController().signal, onText: () => assert.fail("unexpected text"),
  }), /Nothing was executed/);
  assert.equal(signal?.aborted, true);
});

test("provider errors remain errors instead of a success with an empty answer", async () => {
  const registered = provider(() => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "error", reason: "error", error: { ...response, stopReason: "error", errorMessage: "Rate limited" } });
    return stream;
  });
  await assert.rejects(answerQuestion({
    registry: { getProvider: () => registered, getApiKeyAndHeaders: async () => ({ ok: true }) },
    model, context, signal: new AbortController().signal, onText: () => {},
  }), /Rate limited/);
});

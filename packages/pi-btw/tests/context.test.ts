import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildSnapshot, describeHistory } from "../src/context.ts";

const assistant: AssistantMessage = {
  role: "assistant", api: "openai-responses", provider: "test", model: "test",
  timestamp: 0, stopReason: "toolUse",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  content: [
    { type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
    { type: "toolCall", id: "b", name: "read", arguments: { path: "b" } },
  ],
};
const result: Message = { role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "A completed" }], isError: false, timestamp: 1 };

function snapshot(sm: SessionManager, question = "现在呢？", window = 128000) {
  return buildSnapshot(sm.getEntries(), sm.getLeafId(), question, window);
}

test("partially completed parallel batch is usable and never becomes live tool protocol", () => {
  const sm = SessionManager.inMemory();
  sm.appendMessage(assistant);
  sm.appendMessage(result);
  const before = structuredClone(sm.getEntries());
  const value = snapshot(sm);
  assert.deepEqual(sm.getEntries(), before);
  assert.deepEqual(value.context.tools, []);
  assert.ok(value.context.messages.every((m) => m.role === "user" && typeof m.content === "string"));
  assert.match(String(value.context.messages[0].content), /A completed/);
  assert.match(String(value.context.messages[0].content), /no matching result recorded in snapshot/);
  assert.match(value.notice, /1 tool call/);
  sm.appendMessage({ ...result, toolCallId: "b", content: [{ type: "text", text: "B later completed" }] });
  assert.doesNotMatch(JSON.stringify(value), /B later completed/);
  assert.doesNotMatch(snapshot(sm).notice, /without an unambiguous/);
});

test("aborted history and orphan results preserve evidence without rejecting the question", () => {
  const history = describeHistory([{ ...assistant, stopReason: "aborted" }, { role: "user", content: "new request", timestamp: 2 }, result]);
  assert.match(history.text, /"completion":"aborted"/);
  assert.match(history.text, /new request/);
  assert.match(history.text, /A completed/);
  assert.match(history.text, /no matching call in this snapshot batch/);
  assert.equal(history.missing, 2);
});

test("branch selection, legacy compaction, and empty leaf follow SessionManager", () => {
  const sm = SessionManager.inMemory();
  const root = sm.appendMessage({ role: "user", content: "old root", timestamp: 0 });
  sm.appendMessage({ role: "user", content: "abandoned branch", timestamp: 1 });
  sm.branch(root);
  const kept = sm.appendMessage({ role: "user", content: "current branch", timestamp: 2 });
  sm.appendCompaction("summary checkpoint", kept, 1000);
  const text = JSON.stringify(snapshot(sm));
  assert.match(text, /summary checkpoint/);
  assert.match(text, /current branch/);
  assert.doesNotMatch(text, /abandoned branch|old root/);
  sm.resetLeaf();
  assert.match(JSON.stringify(snapshot(sm)), /empty conversation/);
});

test("images and signed reasoning never leak into text snapshots", () => {
  const history = describeHistory([
    { role: "user", content: [{ type: "image", data: "PRIVATE_IMAGE", mimeType: "image/png" }], timestamp: 0 },
    { ...assistant, content: [{ type: "thinking", thinking: "PRIVATE_REASONING", thinkingSignature: "SIGNATURE" }, { type: "text", text: "visible answer" }] },
  ]);
  assert.equal(history.images, 1);
  assert.match(history.text, /visible answer/);
  assert.doesNotMatch(history.text, /PRIVATE|SIGNATURE/);
});

test("byte budgeting marks omissions, retains recent Chinese text, and rejects oversized questions", () => {
  const sm = SessionManager.inMemory();
  sm.appendMessage({ role: "user", content: "旧内容".repeat(20000) + "最新进展", timestamp: 0 });
  const value = snapshot(sm, "现在呢？", 16384);
  assert.match(value.notice, /Older history omitted/);
  assert.match(JSON.stringify(value), /最新进展/);
  assert.doesNotMatch(JSON.stringify(value), /\uFFFD/);
  assert.ok(Buffer.byteLength(JSON.stringify(value.context)) < 16384);
  assert.throws(() => snapshot(sm, "太长".repeat(20000), 16384), /too large/);
});

test("system declarations are excluded without orphaning intervening tool results", () => {
  const system: Message = { role: "system", content: "PRIVATE_SYSTEM", sections: { rules: "PRIVATE_RULES" }, toolsAdded: [{ name: "PRIVATE_TOOL", description: "secret", parameters: { type: "object" } }], timestamp: 0 };
  const history = describeHistory([system, { ...assistant, content: [assistant.content[0]] }, system, result]);
  assert.doesNotMatch(history.text, /PRIVATE_/);
  assert.equal(history.missing, 0);
  const sm = SessionManager.inMemory();
  sm.appendMessage(system);
  const user = sm.appendMessage({ role: "user", content: "OMITTED_ORIGINAL", timestamp: 1 });
  sm.appendContextEdit(user, { content: "replacement" });
  assert.match(JSON.stringify(snapshot(sm)), /replacement/);
  assert.doesNotMatch(JSON.stringify(snapshot(sm)), /PRIVATE_|OMITTED_ORIGINAL/);
});

test("duplicate call IDs are not falsely marked completed", () => {
  const call = assistant.content[0];
  const history = describeHistory([{ ...assistant, content: [call, call] }, result]);
  assert.equal(history.missing, 2);
  assert.match(history.text, /duplicate call ID/);
});

import assert from "node:assert/strict";
import { normalizeContext, type Model, type Tool } from "@earendil-works/pi-ai";
import { buildRequest } from "../src/stream/stream.ts";

const tool = (name: string, description = name): Tool => ({ name, description, parameters: { type: "object", properties: {} } });
const context = normalizeContext({ messages: [
  { role: "system", content: "base instruction", sections: { rules: "OLD_RULES", obsolete: "REMOVED_SECTION" }, toolsAdded: [tool("removed"), tool("kept", "old")], timestamp: 0 },
  { role: "user", content: "task", timestamp: 1 },
  { role: "system", content: "later instruction", sections: { rules: "NEW_RULES", obsolete: null }, toolsRemoved: [{ name: "removed" }], toolsAdded: [tool("kept", "new"), tool("added")], timestamp: 2 },
] });
const before = structuredClone(context);
for (const id of ["gemini-3.5-flash-lite", "claude-sonnet-4-6"]) {
  const model = { id, api: "antigravity", provider: "antigravity", maxTokens: 4096 } as Model<any>;
  const result = buildRequest(model, context, "offline", {}, id).request;
  const system = JSON.stringify(result.systemInstruction);
  assert.match(system, /base instruction/);
  assert.match(system, /later instruction/);
  assert.match(system, /NEW_RULES/);
  assert.doesNotMatch(system, /OLD_RULES|REMOVED_SECTION/);
  assert.deepEqual(result.tools?.[0].functionDeclarations.map(t => [t.name, t.description]), [["kept", "new"], ["added", "added"]]);
  assert.doesNotMatch(JSON.stringify(result.contents), /instruction|RULES|SECTION/);
  const removed = normalizeContext({ messages: [...context.messages, { role: "system", content: "", toolsRemoved: [{ name: "kept" }, { name: "added" }], timestamp: 3 }] });
  assert.equal(buildRequest(model, removed, "offline", {}, id).request.tools, undefined);
  const systemOnly = buildRequest(model, normalizeContext({ systemPrompt: "Only system", messages: [] }), "offline", {}, id).request;
  assert.match(JSON.stringify(systemOnly.contents), /Apply the active system instructions/);
}
assert.deepEqual(context, before);
console.log("Transcript request regression passed: system sections, tool deltas, conversation isolation, system-only and immutability (Gemini + Claude).");

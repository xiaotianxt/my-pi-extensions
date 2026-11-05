import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from "jiti";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-tui': fileURLToPath(import.meta.resolve('@earendil-works/pi-tui')),
} });
const { default: extension } = await jiti.import('../src/index.ts');
const { resolvePiCodexAuth } = await jiti.import('../src/pi-auth.ts');
const token = id => `header.${Buffer.from(JSON.stringify({'https://api.openai.com/auth': {chatgpt_account_id: id}})).toString('base64url')}.signature`;
function context(provider = 'codex-pool') {
  const ctx = { model: {provider, baseUrl:'https://chatgpt.com/backend-api'},
    modelRegistry: { getApiKeyAndHeaders: async model => {
      assert.equal(model, ctx.model);
      return {ok:true, apiKey:token(ctx.account)};
    } }, account:'first' };
  return ctx;
}
test('all search entry points use current Pi auth, preserve research session, and follow account changes', async t => {
  const tools = new Map(), commands = new Map(), requests = [];
  extension({registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, cmd) => commands.set(name, cmd), registerEntryRenderer() {}, appendEntry() {}});
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({url, headers:init.headers, body:JSON.parse(init.body)});
    return Response.json({output:'ok', results:[]});
  });
  const ctx = context();
  for (const name of ['codex-search','codex-research','web']) {
    const params = name === 'codex-search' ? {query:'test'} : {search_query:[{q:'test'}]};
    const result = await tools.get(name).execute('test', params, undefined, undefined, ctx);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const req = requests.at(-1);
    assert.equal(req.headers.Authorization, `Bearer ${token(ctx.account)}`);
    assert.equal(req.headers['ChatGPT-Account-ID'], ctx.account);
    ctx.account += '-next';
  }
  ctx.ui = {setStatus(){}, notify(message, kind){assert.notEqual(kind, 'error', message);}};
  await commands.get('gpt-search').handler('test', ctx);
  assert.equal(requests.length, 4);
  assert.equal(requests.at(-1).headers.Authorization, `Bearer ${token(ctx.account)}`);
  assert.equal(typeof requests[0].body.id, 'string');
  assert.equal(new Set(requests.map(r => r.body.id)).size, 1);
});
test('original Codex provider uses the registry too', async () => {
  assert.equal((await resolvePiCodexAuth(context('openai-codex'))).accountId, 'first');
});
test('rejects non-Codex/custom providers and propagates refresh failure without CLI fallback', async () => {
  await assert.rejects(resolvePiCodexAuth(context('anthropic')), /active/);
  const ctx = context();
  ctx.model.baseUrl = 'https://example.com';
  await assert.rejects(resolvePiCodexAuth(ctx), /official/);
  ctx.model.baseUrl = 'https://chatgpt.com';
  ctx.modelRegistry.getApiKeyAndHeaders = async () => {throw new Error('refresh failed');};
  await assert.rejects(resolvePiCodexAuth(ctx), /refresh failed/);
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ok:true, apiKey:token('first'), baseUrl:'https://example.com'});
  await assert.rejects(resolvePiCodexAuth(ctx), /custom-provider/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from "jiti";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const ai = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-ai/providers/all': `${ai}/providers/all.js`,
  '@earendil-works/pi-ai': `${ai}/compat.js`,
  '@earendil-works/pi-tui': fileURLToPath(import.meta.resolve('@earendil-works/pi-tui')),
  '@earendil-works/pi-coding-agent': `${root}/dist/index.js`,
} });
const { default: titleExtension } = await jiti.import('../extensions/herdr-tab-title.ts');
const { default: quotaExtension } = await jiti.import('../extensions/openai-codex.ts');
const { default: footerExtension } = await jiti.import('../extensions/polished-footer.ts');
const { default: uiStateExtension } = await jiti.import('../extensions/herdr-ui-state.ts');
const { SessionManager } = await import(`${root}/dist/index.js`);
const { getCurrentSystemPrompt } = await import(`${ai}/index.js`);
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function titleHarness(sm = SessionManager.inMemory()) {
  const handlers = {}, commands = {}, calls = [], renames = [], warnings = [];
  let output = '任务 A', pending, delayedNames = false;
  const nameEvents = [];
  const model = { provider: 'openai-codex', id: 'gpt-6-luna' };
  const ctx = { mode: 'tui', model, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: sm, ui: { notify: text => warnings.push(text) },
    modelRegistry: { getAvailable: () => [model], getApiKeyAndHeaders: async () => ({ ok: true }),
      getProvider: () => ({ streamSimple: (_model, context) => {
        calls.push(context);
        const result = { stopReason: 'stop', content: [{ type: 'text', text: output }] };
        return { result: () => pending ? new Promise(resolve => { pending.resolve = () => resolve(result); }) : Promise.resolve(result) };
      } }) },
  };
  const emit = async (event, payload = {}) => { await handlers[event]?.(payload, ctx); await flush(); };
  const pi = { on: (event, fn) => { handlers[event] = fn; }, registerCommand: (name, command) => { commands[name] = command; },
    getSessionName: () => sm.getSessionName(), setSessionName: name => {
      sm.appendSessionInfo(name);
      const event = { name: sm.getSessionName() };
      if (delayedNames) nameEvents.push(event); else void emit('session_info_changed', event);
    },
    appendEntry: (type, data) => sm.appendCustomEntry(type, data),
    exec: async (_bin, args) => { renames.push(args.at(-1)); return { code: 0 }; },
  };
  titleExtension(pi);
  return { ctx, pi, sm, emit, calls, renames, warnings,
    output: value => { output = value; }, defer: () => { pending = {}; return pending; },
    retry: () => commands['herdr-title'].handler('retry', ctx),
    delayNames: () => { delayedNames = true; },
    deliverNames: async () => { delayedNames = false; for (const event of nameEvents.splice(0)) await emit('session_info_changed', event); },
    user: text => sm.appendMessage({ role: 'user', content: text, timestamp: 0 }),
  };
}
function titleEnv(t) {
  for (const [key, value] of Object.entries({ HERDR_ENV: '1', HERDR_TAB_ID: 'offline', HERDR_SOCKET_PATH: 'offline' })) {
    const original = process.env[key]; process.env[key] = value;
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
}

test('first title starts on committed user input and finishes while the agent is busy', async t => {
  titleEnv(t);
  const h = titleHarness();
  await h.emit('session_start'); t.mock.timers.tick(0); await flush();
  h.ctx.isIdle = () => false;
  h.ctx.hasPendingMessages = () => true;
  await h.emit('before_agent_start'); await h.emit('agent_start');
  const message = { role: 'user', content: '任务 A', timestamp: 0 };
  await h.emit('message_end', { message });
  assert.equal(h.calls.length, 0);
  h.sm.appendMessage(message); // Real Pi persists after the extension hook.
  const pending = h.defer();
  t.mock.timers.tick(0); await flush();
  assert.equal(h.calls.length, 1);
  h.sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Working...' }], timestamp: 1 });
  await h.emit('agent_start'); // Retry/start must not cancel the initial title.
  pending.resolve(); await flush();
  assert.equal(h.sm.getSessionName(), '任务 A');
  assert.equal(h.renames.at(-1), '任务 A');
  await h.emit('session_shutdown');
});

test('new user input invalidates an in-flight initial title without waiting for agent settle', async t => {
  titleEnv(t);
  const h = titleHarness(); h.user('A');
  const old = h.defer();
  await h.emit('session_start'); t.mock.timers.tick(0); await flush();
  h.ctx.isIdle = () => false;
  await h.emit('message_end', { message: { role: 'user', content: 'B' } });
  h.user('B'); h.output('任务 B');
  old.resolve(); await flush();
  const next = h.defer();
  t.mock.timers.tick(0); await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.sm.getSessionName(), undefined);
  next.resolve(); await flush();
  assert.equal(h.sm.getSessionName(), '任务 B');
  await h.emit('session_shutdown');
});

test('legacy pi-web automatic titles are taken over; manual names remain protected', async t => {
  titleEnv(t);
  for (const automatic of [true, false]) {
    const h = titleHarness(); h.user('A');
    const id = h.sm.appendSessionInfo('旧标题');
    if (automatic) h.sm.getEntry(id).autoTitle = true;
    await h.emit('session_start'); t.mock.timers.tick(0); await flush();
    assert.equal(h.calls.length, automatic ? 1 : 0);
    assert.equal(h.sm.getSessionName(), automatic ? '任务 A' : '旧标题');
    await h.emit('session_shutdown');
  }
});

test('title cache restores A→B→A across reload, without new generation or repeated rename', async t => {
  titleEnv(t);
  const h = titleHarness();
  const a = h.user('任务 A');
  await h.emit('session_start'); t.mock.timers.tick(0); await flush();
  assert.match(getCurrentSystemPrompt(h.calls[0].messages), /You label conversations/);
  h.sm.resetLeaf(); h.user('任务 B'); h.output('任务 B');
  await h.emit('session_tree'); t.mock.timers.tick(120000); await flush();
  assert.equal(h.sm.getSessionName(), '任务 B');
  await h.emit('session_shutdown');
  const resumed = titleHarness(h.sm);
  await resumed.emit('session_start'); t.mock.timers.tick(0); await flush();
  resumed.sm.branch(a);
  resumed.ctx.isIdle = () => false;
  await resumed.emit('session_tree'); t.mock.timers.tick(0); await flush();
  assert.equal(resumed.sm.getSessionName(), '任务 B');
  resumed.ctx.isIdle = () => true;
  t.mock.timers.tick(1000); await flush();
  assert.equal(resumed.sm.getSessionName(), '任务 A');
  assert.equal(resumed.calls.length, 0);
  const count = resumed.renames.length;
  await resumed.emit('agent_settled'); t.mock.timers.tick(120000); await flush();
  assert.equal(resumed.renames.length, count);
  await resumed.emit('session_shutdown');
});

test('title uses projected content; invalid attempt requires explicit retry; manual title beats late result', async t => {
  titleEnv(t);
  const h = titleHarness();
  const id = h.user('PRIVATE_OMITTED');
  h.sm.appendContextEdit(id, { content: 'new task' });
  h.output('this is not a valid title because it is far too long to be a title');
  await h.emit('session_start'); t.mock.timers.tick(0); await flush();
  assert.doesNotMatch(JSON.stringify(h.calls), /PRIVATE_OMITTED/);
  assert.equal(h.warnings.length, 1);
  await h.emit('agent_settled'); t.mock.timers.tick(120000); await flush();
  assert.equal(h.calls.length, 1);
  h.output('new task'); await h.retry(); await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.sm.getSessionName(), 'new task');
  h.user('different task'); const pending = h.defer();
  await h.emit('agent_settled'); t.mock.timers.tick(120000); await flush();
  h.pi.setSessionName('manual'); await flush(); pending.resolve(); await flush();
  assert.equal(h.sm.getSessionName(), 'manual');
  await h.emit('session_shutdown');
});

test('delayed automatic A→B→A name events cannot poison ownership across reload', async t => {
  titleEnv(t);
  const h = titleHarness(); h.delayNames(); const a = h.user('A');
  await h.emit('session_start'); t.mock.timers.tick(0); await flush();
  h.sm.resetLeaf(); h.user('B'); h.output('任务 B');
  await h.emit('session_tree'); t.mock.timers.tick(120000); await flush();
  h.sm.branch(a); await h.emit('session_tree'); t.mock.timers.tick(0); await flush();
  await h.deliverNames(); await h.emit('session_shutdown');
  const resumed = titleHarness(h.sm);
  await resumed.emit('session_start'); t.mock.timers.tick(0); await flush();
  resumed.user('C'); resumed.output('任务 C');
  await resumed.emit('agent_settled'); t.mock.timers.tick(120000); await flush();
  assert.equal(resumed.calls.length, 1);
  assert.equal(resumed.sm.getSessionName(), '任务 C');
  await resumed.emit('session_shutdown');
});

test('same-name manual rename wins even before its asynchronous event is delivered', async t => {
  titleEnv(t);
  const h = titleHarness(); h.user('A');
  await h.emit('session_start'); t.mock.timers.tick(0); await flush();
  h.user('B'); h.output('任务 B'); const pending = h.defer();
  await h.emit('agent_settled'); t.mock.timers.tick(120000); await flush();
  const manualName = h.sm.getSessionName();
  h.sm.appendSessionInfo(manualName); // Pi persists /name before async event delivery.
  pending.resolve(); await flush();
  assert.equal(h.sm.getSessionName(), manualName);
  await h.emit('session_info_changed', { name: manualName });
  const calls = h.calls.length; await h.retry(); await flush();
  assert.equal(h.calls.length, calls);
  await h.emit('session_shutdown');
});

test('quota dedupes fresh requests, retains official model cache, exposes stale failures and cleans up', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000000 });
  const handlers = {}, commands = {}, statuses = [];
  let requests = 0, fail = false;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    if (fail) throw new Error('offline failure');
    return Response.json({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 } } });
  });
  const token = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline' } })).toString('base64url')}.x`;
  const ctx = { hasUI: true, model: { provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api' },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) },
    ui: { setStatus: (_key, value) => statuses.push(value), notify() {} },
  };
  quotaExtension({ registerProvider() {}, on: (name, fn) => { handlers[name] = fn; }, registerCommand: (name, command) => { commands[name] = command; } });
  handlers.session_start({}, ctx); await flush();
  handlers.agent_settled({}, ctx); handlers.model_select({}, ctx); await flush();
  assert.equal(requests, 1);
  fail = true;
  t.mock.timers.tick(60000); await flush();
  assert.equal(requests, 2);
  assert.match(statuses.at(-1), /stale.*sampled/);
  handlers.agent_settled({}, ctx); await flush(); assert.equal(requests, 2);
  await commands['codex-provider-usage'].handler('', ctx); assert.equal(requests, 3);
  handlers.session_shutdown({}, ctx); t.mock.timers.tick(120000); await flush();
  assert.equal(requests, 3); assert.equal(statuses.at(-1), undefined);
});

test('manual quota callers receive shared success and failure across distinct event contexts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000000 });
  const handlers = {}, commands = {}, notices = [];
  let requests = 0, pending;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    if (pending) return pending.promise;
    return Response.json({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 } } });
  });
  const token = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline' } })).toString('base64url')}.x`;
  const ctx = { hasUI: true, model: { provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api' },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) },
    ui: { setStatus() {}, notify: (text, level) => notices.push({ text, level }) },
  };
  quotaExtension({ registerProvider() {}, on: (name, fn) => { handlers[name] = fn; }, registerCommand: (name, command) => { commands[name] = command; } });
  handlers.session_start({}, ctx); await flush();
  for (const failure of [false, true]) {
    pending = Promise.withResolvers();
    const command = commands['codex-provider-usage'].handler('', { ...ctx });
    await flush(); handlers.agent_settled({}, { ...ctx }); await flush();
    if (failure) pending.reject(new Error('offline failure'));
    else pending.resolve(Response.json({ rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000 } } }));
    await command;
    assert.equal(notices.at(-1).level, failure ? 'warning' : 'info');
  }
  assert.equal(requests, 3);
  handlers.session_shutdown({}, ctx);
});

test('Herdr UI companion balances coalesced waits and clears on shutdown', () => {
  const handlers = {}, events = [];
  let idle = false;
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    uiStateExtension({ on: (event, handler) => { handlers[event] = handler; }, events: { emit: (event, data) => events.push(data) } });
    const ctx = { mode: 'tui', isIdle: () => idle };
    handlers.session_start({}, ctx);
    handlers.ui_prompt_start({}, ctx); handlers.ui_prompt_start({}, ctx);
    assert.deepEqual(events.map(e => e.active), [true]);
    handlers.ui_prompt_end(); handlers.ui_prompt_end();
    idle = true; handlers.ui_prompt_start({}, ctx);
    assert.deepEqual(events.map(e => e.active), [true, false]);
    idle = false; handlers.ui_prompt_start({}, ctx); handlers.session_shutdown();
    assert.deepEqual(events.map(e => e.active), [true, false, true, false]);
  } finally { if (prior === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = prior; }
});

test('pooled Codex quota is integrated into the footer without an extra status row', () => {
  const handlers = {}; let component;
  const colors = [];
  const ctx = { mode: 'tui', cwd: '/tmp/offline', model: { provider: 'codex-pool', id: 'gpt-test' },
    getContextUsage: () => ({ percent: 20 }),
    sessionManager: { getLeafId: () => 'a', getEntries: () => [] },
    ui: { setFooter: factory => { component = factory({ requestRender() {} }, {
      fg: (color, value) => { colors.push([color, value]); return value; },
    }, { onBranchChange: () => () => {}, getGitBranch: () => undefined,
      getExtensionStatuses: () => new Map([['codex-pool', 'CMU · Edu · quota left 5h 67% · 7d 5%']]),
    }); } },
  };
  footerExtension({ on: (name, fn) => { handlers[name] = fn; }, getSessionName: () => undefined });
  handlers.session_start({}, ctx);
  const lines = component.render(160);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /CMU · Edu · quota left 5h 67% · 7d 5%/);
  assert.doesNotMatch(lines.join('\n'), /codex-pool/);
  assert(colors.some(([color, value]) => color === 'success' && value === '67%'));
  assert(colors.some(([color, value]) => color === 'error' && value === '5%'));
  component.dispose();
});

test('footer includes standalone usage and caches full-history aggregation until leaf changes', async () => {
  const handlers = {}; let component, scans = 0, names = 0, leaf = 'a';
  const usage = { input: 100, output: 20, cacheRead: 100, cacheWrite: 0 };
  const entries = [{ type: 'message', message: { role: 'assistant', usage } }, { type: 'usage', kind: 'unknown_kind', usage: { ...usage, input: 200 } }];
  const ctx = { mode: 'tui', cwd: '/tmp/offline', getContextUsage: () => undefined,
    sessionManager: { getLeafId: () => leaf, getEntries: () => { scans++; return entries; } },
    ui: { setFooter: factory => { component = factory({ requestRender() {} }, { fg: (_color, value) => value }, { onBranchChange: () => () => {}, getGitBranch: () => undefined, getExtensionStatuses: () => new Map() }); } },
  };
  footerExtension({ on: (name, fn) => { handlers[name] = fn; }, getSessionName: () => { names++; return 'offline'; } });
  handlers.session_start({}, ctx);
  assert.match(component.render(160).join('\n'), /300 in/);
  component.render(80); component.invalidate(); component.render(160);
  assert.equal(scans, 1); assert.equal(names, 1);
  entries.push({ type: 'usage', usage }); leaf = 'b';
  assert.match(component.render(160).join('\n'), /400 in/);
  assert.equal(scans, 2);
  handlers.session_tree({}, ctx); component.render(160); assert.equal(scans, 3);
  component.dispose(); handlers.session_shutdown({}, ctx);
});

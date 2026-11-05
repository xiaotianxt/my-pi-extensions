import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from "jiti";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const ai = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-ai/providers/all': `${ai}/providers/all.js`,
  '@earendil-works/pi-ai': `${ai}/index.js`,
} });
const { default: extension } = await jiti.import('../extensions/openai-codex.ts');
const { ModelRuntime } = await import(`${root}/dist/core/model-runtime.js`);
const { AuthStorage } = await import(`${root}/dist/core/auth-storage.js`);
const { InMemoryCodingAgentModelsStore } = await import(`${root}/dist/core/models-store.js`);
const { builtinProviders, getBuiltinModelDataGeneratedAt } = await import(`${ai}/providers/all.js`);
const providerId = 'openai-codex';
const builtin = builtinProviders().find(p => p.id === providerId);

function registration() {
  let args;
  extension({ registerProvider: (...value) => { args = value; }, on() {}, registerCommand() {} });
  return args;
}

function setEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
  });
}

const credential = {
  type: 'oauth', access: 'offline-access', refresh: 'offline-refresh',
  expires: Date.now() + 3600000, accountId: 'offline-account',
};

test('OAuth override preserves cached models and subsequent remote catalog refreshes', async t => {
  setEnv(t, 'PI_OFFLINE', undefined);
  const store = new InMemoryCodingAgentModelsStore();
  const cached = { ...builtin.getModels()[0], id: 'catalog-only-cached-model' };
  const newer = { ...cached, id: 'catalog-only-new-model' };
  const lastModified = getBuiltinModelDataGeneratedAt() + 60000;
  await store.write(providerId, { models: [cached], lastModified, checkedAt: Date.now() });
  const runtime = await ModelRuntime.create({
    modelsPath: null, modelsStore: store,
    credentials: AuthStorage.inMemory({ [providerId]: credential }),
  });
  const args = registration();
  if (typeof args[0] === 'string') runtime.registerProvider(...args);
  else runtime.registerNativeProvider(args[0]);
  await runtime.refresh({ allowNetwork: false, providers: [providerId] });
  assert.ok(runtime.models.getModels(providerId).some(m => m.id === cached.id));
  assert.ok((await runtime.getAvailable()).some(m => m.id === cached.id));

  t.mock.method(globalThis, 'fetch', async url => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://pi.dev');
    assert.equal(parsed.pathname, `/api/models/providers/${providerId}`);
    return Response.json([newer], { headers: {
      'last-modified': new Date(lastModified + 60000).toUTCString(), etag: 'offline-v2',
    } });
  });
  const result = await runtime.refresh({ allowNetwork: true, force: true, providers: [providerId] });
  assert.equal(result.errors.size, 0);
  assert.ok((await runtime.getAvailable()).some(m => m.id === newer.id));
  assert.equal((await store.read(providerId)).models[0].id, newer.id);
});

test('refresh still supports the custom endpoint and the built-in endpoint', async t => {
  const [, config] = registration();
  const signal = new AbortController().signal;
  const access = `x.${Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: credential.accountId },
  })).toString('base64url')}.x`;
  for (const endpoint of [undefined, 'http://127.0.0.1:12345/refresh']) {
    await t.test(endpoint ? 'custom endpoint' : 'built-in endpoint', async t => {
      setEnv(t, 'CODEX_REFRESH_TOKEN_URL_OVERRIDE', endpoint);
      t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(String(url), endpoint ?? 'https://auth.openai.com/oauth/token');
        assert.equal(options.signal, signal);
        const body = endpoint ? JSON.parse(options.body) : Object.fromEntries(new URLSearchParams(options.body));
        assert.equal(body.refresh_token, credential.refresh);
        return Response.json({ access_token: access, refresh_token: 'offline-rotated', expires_in: 3600 });
      });
      const refreshed = await config.oauth.refreshToken(credential, signal);
      assert.equal(refreshed.refresh, 'offline-rotated');
      assert.equal(refreshed.accountId, credential.accountId);
      assert.equal(config.oauth.getApiKey(refreshed), access);
    });
  }
});

test('login retains built-in method selection and handles cancellation without network', async () => {
  const [, config] = registration();
  const callbacks = {
    signal: new AbortController().signal,
    onSelect: async prompt => {
      assert.ok(prompt.options.some(option => /browser/i.test(option.label)));
      assert.ok(prompt.options.some(option => /device/i.test(option.label)));
      return undefined;
    },
  };
  await assert.rejects(config.oauth.login(callbacks), /login cancelled/);
});

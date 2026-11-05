import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from "jiti";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')),
} });
const { default: install } = await jiti.import('../extensions/codex-diagnostics.ts');
function harness(t, directory) {
  const dir = directory ?? mkdtempSync(join(tmpdir(), 'codex-diagnostics-test-'));
  if (!directory) t.after(() => rmSync(dir, { recursive: true, force: true }));
  const handlers = {};
  install({ on: (name, fn) => { handlers[name] = fn; } }, dir);
  const ctx = { model: { provider: 'openai-codex', id: 'gpt-6-astra', baseUrl: 'https://chatgpt.com/backend-api' },
    sessionManager: { getSessionId: () => 'test-session' } };
  const path = join(dir, `${process.pid}.jsonl`);
  return { dir, path, emit: (name, event) => handlers[name](event, ctx),
    read: () => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse) };
}

test('metadata captures the access error and correlates requests without persisting content or auth', t => {
  const h = harness(t);
  const secret = 'DO_NOT_LOG_SECRET';
  const payload = { model: 'gpt-6-astra', input: secret, instructions: secret };
  assert.equal(h.emit('before_provider_request', { payload }), undefined);
  h.emit('after_provider_response', { status: 200, headers: {
    'X-Request-Id': 'req_123', authorization: secret, 'set-cookie': secret,
  } });
  const data = { type: 'error', request_id: 'req_error', error: { code: 'access_check_failed',
    message: `Unable to verify Daybreak Blue access. Please try again. ${secret}` }, extra: secret };
  const before = structuredClone(data);
  h.emit('provider_stream_event', { provider: 'openai-codex', model: 'gpt-6-astra', data });
  h.emit('message_end', { message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-6-astra',
    stopReason: 'error', errorMessage: data.error.message, content: [secret] } });
  assert.deepEqual(data, before);
  assert.deepEqual(payload, { model: 'gpt-6-astra', input: secret, instructions: secret });
  const records = h.read();
  assert.equal(new Set(records.map(r => r.request)).size, 1);
  assert.equal(records.find(r => r.event === 'provider_error').code, 'access_check_failed');
  assert.equal(records.find(r => r.event === 'provider_error').request_id, 'req_error');
  assert.equal(records.find(r => r.event === 'provider_error').classification, 'daybreak_blue_access_verification_failed');
  assert.equal(records.find(r => r.event === 'http_response').headers['x-request-id'], 'req_123');
  assert.equal(records.find(r => r.event === 'stream_start').transport, 'sse');
  assert.ok(!readFileSync(h.path, 'utf8').includes(secret));
  assert.equal(statSync(h.path).mode & 0o777, 0o600);
  assert.equal(statSync(h.dir).mode & 0o777, 0o700);
  h.emit('before_provider_request', { payload });
  h.emit('provider_stream_event', { provider: 'openai-codex', model: 'gpt-6-astra',
    data: { type: 'response.created', response: { id: 'resp_456', model: 'gpt-6-astra', output: secret } } });
  assert.notEqual(h.read().at(-1).request, records[0].request);
  assert.equal(h.read().findLast(r => r.event === 'stream_start').transport, 'websocket_inferred');
});

test('rotation is bounded and retention only removes old diagnostic files', t => {
  const h = harness(t);
  const expired = join(h.dir, '1234.jsonl.1');
  const unrelated = join(h.dir, 'keep.txt');
  for (const path of [expired, unrelated]) {
    writeFileSync(path, 'old');
    utimesSync(path, 1, 1);
  }
  writeFileSync(h.path, 'x'.repeat(1024 * 1024));
  h.emit('before_provider_request', { payload: { model: 'gpt-6-astra' } });
  assert.ok(existsSync(`${h.path}.1`));
  assert.ok(statSync(h.path).size < 1024 * 1024);
  assert.ok(!existsSync(expired));
  assert.ok(existsSync(unrelated));
});

test('logging failure warns once without failing requests', t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-diagnostics-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'not-a-directory');
  writeFileSync(file, '');
  const h = harness(t, file);
  const warning = t.mock.method(console, 'error', () => {});
  for (let i = 0; i < 2; i++) {
    assert.doesNotThrow(() => h.emit('before_provider_request', { payload: { model: 'gpt-6-astra' } }));
  }
  assert.equal(warning.mock.calls.length, 1);
});

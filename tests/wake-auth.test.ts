import test from 'node:test';
import assert from 'node:assert/strict';
import * as notify from '../src/server/notify.ts';
import { deliver, wakeAuthFrom, wakeAuthHeader } from '../src/server/notify.ts';

const U = 'https://wake.example.test/hook/abc';
test('GROK_WAKE_KEY adds Authorization only for agent:grok at the pinned GROK_WAKE_URL', () => {
  assert.deepEqual(wakeAuthHeader(wakeAuthFrom({}), 'agent:grok', U), {});
  assert.deepEqual(wakeAuthHeader(wakeAuthFrom({ GROK_WAKE_KEY: 'k1' }), 'agent:grok', U), {}, 'no pin => fail closed');
  const a = wakeAuthFrom({ GROK_WAKE_KEY: 'k1', GROK_WAKE_URL: U });
  assert.deepEqual(wakeAuthHeader(a, 'agent:grok', U), { Authorization: 'Bearer k1' });
  assert.deepEqual(wakeAuthHeader(a, 'agent:grok', U + '?x=1'), {}, 'URL change => no header');
  assert.deepEqual(wakeAuthHeader(a, 'agent:grok', 'https://evil.example.test/hook/abc'), {});
  assert.deepEqual(wakeAuthHeader(a, 'agent:muse', U), {});
  assert.deepEqual(wakeAuthHeader(a, undefined, U), {});
  assert.deepEqual(wakeAuthHeader(a, 'constructor', U), {}, 'no prototype lookup');
  assert.deepEqual(wakeAuthHeader(wakeAuthFrom({ GROK_WAKE_KEY: '', GROK_WAKE_URL: U }), 'agent:grok', U), {});
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a['agent:grok']), 'context is immutable');
});

// Minimal D1 fake: no claim column (unfenced path), one pending row per deliver call.
function fakeDb(id: string) {
  const stmt = (sql: string) => ({
    bind: () => stmt(sql),
    all: async () => { if (sql.includes('claim_token FROM webhook_outbox LIMIT 0')) throw new Error('no such column: claim_token');
      return { results: sql.startsWith('SELECT o.id') ? [{ id, principal_id: 'agent:grok', payload_json: '{"n":1}', attempts: 0, url: U, secret: 's' }] : [] }; },
    first: async () => null,
  });
  return { prepare: stmt, batch: async () => [] } as never;
}

test('overlap: invocation A in flight keeps its own auth while B (env {} or other key) runs concurrently', async () => {
  assert.equal((notify as Record<string, unknown>).configureWakeAuth, undefined, 'no module-global auth setter remains');
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const seen: Record<string, string | undefined> = {};
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>; const d = h['X-Workroom-Delivery']!;
    if (d === 'A') await gate; // A is parked mid-delivery while B/C start and finish
    seen[d] = h.Authorization; return new Response(null, { status: 200 });
  }) as typeof fetch;
  const pA = deliver(fakeDb('A'), ['A'], wakeAuthFrom({ GROK_WAKE_KEY: 'kA', GROK_WAKE_URL: U }), fetchImpl);
  await deliver(fakeDb('B'), ['B'], wakeAuthFrom({}), fetchImpl);
  await deliver(fakeDb('C'), ['C'], wakeAuthFrom({ GROK_WAKE_KEY: 'kC', GROK_WAKE_URL: U }), fetchImpl);
  release(); await pA;
  assert.deepEqual(seen, { A: 'Bearer kA', B: undefined, C: 'Bearer kC' });
});

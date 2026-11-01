import test from 'node:test';
import assert from 'node:assert/strict';
import { agyUsage, fetchGatewaySources, openRouterKey, ssuSource } from '../scripts/meter-readers.mts';

const NOW = '2026-10-27T06:00:00.000Z';

test('ssu credits: numeric remaining/total/used parse as measured credits', () => {
  const s = ssuSource({ remaining_credits: 2994.98, monthly_credits: 3000, used_credits: 5.02 }, null, NOW);
  assert.equal(s.agent, 'ssu'); assert.equal(s.method, 'measured');
  assert.equal((s as unknown as Record<string, unknown>).credits_remaining, 2994.98);
  assert.equal((s as unknown as Record<string, unknown>).credits_total, 3000);
  assert.equal((s as unknown as Record<string, unknown>).credits_used, 5.02);
  assert.equal(s.used_percent, 0.2);
});

test('ssu usage body can supply used when credits body lacks it', () => {
  const s = ssuSource({ balance: 2500, limit: 3000 }, { used: 500 }, NOW);
  assert.equal(s.method, 'measured');
  assert.equal((s as unknown as Record<string, unknown>).credits_used, 500);
  assert.equal(s.used_percent, 16.7);
});

test('ssu unknown shape is unavailable, never guessed', () => {
  const s = ssuSource({ hello: 'world' }, null, NOW);
  assert.equal(s.method, 'unavailable'); assert.equal(s.used_percent, null);
  // Superseded by Dots b4c39f8b #2: response keys are untrusted and are never copied
  // into basis — unrecognized keys are reported as a count only.
  assert.ok(!s.basis.includes('hello'), 'untrusted response key must not appear in basis');
  assert.match(s.basis, /unrecognized/);
});

test('openrouter key: usage/limit parse, remaining derived', () => {
  const s = openRouterKey({ data: { usage: 4.104, limit: 5, is_free_tier: false } }, NOW);
  assert.equal(s.agent, 'openrouter'); assert.equal(s.method, 'measured');
  assert.equal((s as unknown as Record<string, unknown>).usage_usd, 4.104);
  assert.equal((s as unknown as Record<string, unknown>).remaining_usd, 0.896);
});

test('openrouter key: null limit leaves remaining null', () => {
  const s = openRouterKey({ data: { usage: 1.5, limit: null } }, NOW);
  assert.equal(s.method, 'measured');
  assert.equal((s as unknown as Record<string, unknown>).remaining_usd, null);
});

test('agy usage: worst bucket across groups drives used_percent', () => {
  const s = agyUsage({ groups: [
    { name: 'Gemini', buckets: [{ window: 'weekly', remaining_fraction: 0.9, reset_time: '2026-11-01T00:00:00Z' }, { window: '5h', remaining_fraction: 0.5, reset_time: '2026-10-27T11:00:00Z' }] },
    { name: 'Claude+GPT', buckets: [{ window: 'weekly', remaining_fraction: 0.8, reset_time: '2026-11-01T00:00:00Z' }] },
  ] }, NOW);
  assert.equal(s.agent, 'agy'); assert.equal(s.method, 'measured');
  assert.equal(s.used_percent, 50); assert.equal(s.resets_at, '2026-10-27T11:00:00Z');
});

test('agy usage: unparseable payload is unavailable', () => {
  const s = agyUsage({ nope: 1 }, NOW);
  assert.equal(s.method, 'unavailable');
});

test('fetchGatewaySources: no keys means no fetch calls and unavailable sources', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; throw new Error('must not be called'); };
  const out = await fetchGatewaySources({ env: {}, fetchFn, now: NOW, agyRun: () => null });
  assert.equal(calls, 0);
  assert.deepEqual(out.map(s => [s.agent, s.method]), [['ssu', 'unavailable'], ['openrouter', 'unavailable'], ['agy', 'unavailable']]);
});

test('fetchGatewaySources: mocked SSU + OpenRouter respond measured; key never leaks into output', async () => {
  const seen: { url: string; auth: string | undefined }[] = [];
  const fetchFn = async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ url, auth: init?.headers?.Authorization });
    if (url.endsWith('/credits/')) return { ok: true, status: 200, json: async () => ({ remaining_credits: 2994.98, monthly_credits: 3000 }) };
    if (url.endsWith('/usage/')) return { ok: true, status: 200, json: async () => ({ used_credits: 5.02 }) };
    if (url.includes('openrouter')) return { ok: true, status: 200, json: async () => ({ data: { usage: 4.104, limit: 5 } }) };
    throw new Error('unexpected url ' + url);
  };
  const out = await fetchGatewaySources({ env: { SSU_API_KEY: 'sk-test-ssu', OPENROUTER_API_KEY: 'sk-test-or' }, fetchFn, now: NOW, agyRun: () => null });
  const ssu = out.find(s => s.agent === 'ssu'); const or = out.find(s => s.agent === 'openrouter');
  assert.equal(ssu?.method, 'measured'); assert.equal((ssu as unknown as Record<string, unknown>)?.credits_used, 5.02);
  assert.equal(or?.method, 'measured');
  assert.ok(seen.every(x => x.auth === 'Bearer sk-test-ssu' || x.auth === 'Bearer sk-test-or'));
  assert.ok(!JSON.stringify(out).includes('sk-test'));
});

test('fetchGatewaySources: HTTP failure degrades to unavailable, does not throw', async () => {
  const fetchFn = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const out = await fetchGatewaySources({ env: { SSU_API_KEY: 'k', OPENROUTER_API_KEY: 'k2' }, fetchFn, now: NOW, agyRun: () => null });
  assert.ok(out.filter(s => s.agent !== 'agy').every(s => s.method === 'unavailable'));
});

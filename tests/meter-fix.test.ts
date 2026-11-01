// METER fix red tests for Dots scoped FAIL 8e823dfa (ruling 5df9996d), findings 1-5.
import test from 'node:test';
import assert from 'node:assert/strict';
import { READ_TOOLS } from '../src/server/app.ts';
import { latestByAgent, parseSnapshot, usageRead } from '../src/server/usage.ts';
import { fetchGatewaySources } from '../scripts/meter-readers.mts';
import { codexFromLines, render } from '../scripts/usage-collect.mts';

const NOW = '2026-10-27T06:30:00.000Z';
const SECRET = 'sk-synthetic-secret-xyz';

test('F1: workroom_usage_read is in the read-only allowlist', () => {
  assert.ok(READ_TOOLS.has('workroom_usage_read'));
});

test('F2: usageRead authorizes without calling service.read (no cursor side effect)', async () => {
  let readCalls = 0; let authorized: string | null = null;
  const service = {
    read: async () => { readCalls++; return { data: { messages: [] } }; },
    authorize: async (room: string) => { authorized = room; },
    db: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
  };
  const out = await usageRead(service as never, { room: 'room_main' });
  assert.equal(readCalls, 0);
  assert.equal(authorized, 'room_main');
  assert.deepEqual((out as { data: { sources: unknown[] } }).data.sources, []);
});

test('F3: gateway exception text (incl. synthetic secret) never lands in basis or output', async () => {
  const fetchFn = async () => { throw new Error(`dial failed for key ${SECRET}`); };
  const out = await fetchGatewaySources({ env: { SSU_API_KEY: SECRET, OPENROUTER_API_KEY: SECRET }, fetchFn, now: NOW, agyRun: () => null });
  assert.ok(!JSON.stringify(out).includes(SECRET), 'secret leaked into output');
  for (const s of out) assert.ok(!s.basis.includes('dial failed'), `exception text in basis: ${s.basis}`);
});

test('F4a: SSU usage 503 does not leave the source marked measured; both calls attempted', async () => {
  const seen: string[] = [];
  const fetchFn = async (url: string) => {
    seen.push(url);
    if (url.endsWith('/credits/')) return { ok: true, status: 200, json: async () => ({ remaining_credits: 2500, monthly_credits: 3000, used_credits: 500 }) };
    return { ok: false, status: 503, json: async () => ({}) };
  };
  const out = await fetchGatewaySources({ env: { SSU_API_KEY: 'k' }, fetchFn, now: NOW, agyRun: () => null });
  const ssu = out.find(s => s.agent === 'ssu');
  assert.ok(seen.some(u => u.endsWith('/usage/')));
  assert.notEqual(ssu?.method, 'measured');
  const extra = ssu as unknown as Record<string, unknown>;
  assert.equal(extra.usage_status, 'failed');
  assert.equal(extra.credits_status, 'measured');
});

test('F4b: SSU credits failure does not skip the usage attempt', async () => {
  const seen: string[] = [];
  const fetchFn = async (url: string) => {
    seen.push(url);
    if (url.endsWith('/credits/')) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ used_credits: 42, monthly_credits: 3000 }) };
  };
  const out = await fetchGatewaySources({ env: { SSU_API_KEY: 'k' }, fetchFn, now: NOW, agyRun: () => null });
  assert.ok(seen.some(u => u.endsWith('/usage/')), 'usage was not attempted');
  const ssu = out.find(s => s.agent === 'ssu') as unknown as Record<string, unknown>;
  assert.equal(ssu.credits_status, 'failed');
  assert.equal(ssu.usage_status, 'measured');
});

test('F4c: malformed agy buckets fail only the agy source, never the whole collection', async () => {
  const fetchFn = async (url: string) => url.includes('openrouter')
    ? { ok: true, status: 200, json: async () => ({ data: { usage: 1, limit: 5 } }) }
    : { ok: true, status: 200, json: async () => ({ remaining_credits: 10, monthly_credits: 100, used_credits: 5 }) };
  const out = await fetchGatewaySources({ env: { SSU_API_KEY: 'k', OPENROUTER_API_KEY: 'k2' }, fetchFn, now: NOW,
    agyRun: () => ({ groups: [{ name: 'g', buckets: 42 }, null] }) });
  assert.equal(out.find(s => s.agent === 'agy')?.method, 'unavailable');
  assert.equal(out.find(s => s.agent === 'openrouter')?.method, 'measured');
});

test('F4d: a hanging gateway call is bounded by a timeout and degrades to unavailable', async () => {
  const fetchFn = () => new Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>(() => { /* never settles */ });
  const out = await fetchGatewaySources({ env: { OPENROUTER_API_KEY: 'k' }, fetchFn, now: NOW, agyRun: () => null, timeoutMs: 50 });
  assert.equal(out.find(s => s.agent === 'openrouter')?.method, 'unavailable');
});

test('F5a: codex used_percent above 100 stays schema-valid end to end (round-2: flagged, not clamped)', () => {
  const line = JSON.stringify({ timestamp: NOW, payload: { rate_limits: { plan_type: 'pro', primary: { used_percent: 137, window_minutes: 300, resets_at: 1792302862 } } } });
  const s = codexFromLines([line], '/dev/null')!;
  assert.ok(s.used_percent == null || s.used_percent <= 100, `used_percent ${s.used_percent} exceeds schema max`);
  // Dots b4c39f8b #3 supersedes the silent clamp: the value is flagged out_of_range (see meter-fix2 G5b).
  assert.equal((s as unknown as Record<string, unknown>).used_percent_flag, 'out_of_range');
  const text = render({ kind: 'usage.snapshot.v1', collected_at: NOW, sources: [s] });
  assert.ok(parseSnapshot(text), 'snapshot with flagged source must parse');
});

test('F5b: latestByAgent keeps the newest observed_at; a later-posted stale snapshot does not overwrite', () => {
  const mk = (pct: number, at: string) => render({ kind: 'usage.snapshot.v1', collected_at: at, sources: [{ agent: 'codex', method: 'measured', used_percent: pct, observed_at: at, basis: 'x' }] });
  // newest-first message order: m2 was posted later but carries an OLDER observation (stale).
  const r = latestByAgent([
    { id: 'm2', actor_id: 'grok', text: mk(99, '2026-10-27T01:00:00.000Z'), created_at: '2026-10-27T03:00:00.000Z' },
    { id: 'm1', actor_id: 'grok', text: mk(10, '2026-10-27T02:00:00.000Z'), created_at: '2026-10-27T02:30:00.000Z' },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0]?.used_percent, 10);
  assert.equal(r[0]?.message_id, 'm1');
});

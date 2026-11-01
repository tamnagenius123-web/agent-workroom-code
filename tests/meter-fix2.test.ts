// METER fix round 2 red tests for Dots scoped FAIL b4c39f8b at 312cae4 (ruling 1f2060e4), defects 1-3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { latestByAgent } from '../src/server/usage.ts';
import { fetchGatewaySources, ssuSource, openRouterKey } from '../scripts/meter-readers.mts';
import { codexFromLines, render } from '../scripts/usage-collect.mts';

const NOW = '2026-10-27T06:30:00.000Z';
const SECRET = 'sk-synthetic-secret-xyz';
type Resp = { ok: boolean; status: number; json(): Promise<unknown> };
const hangJson = (): Promise<unknown> => new Promise<unknown>(() => { /* never settles */ });

test('G1: SSU body (json) hang is bounded by the timeout AND the request is aborted', async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const fetchFn = async (_url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<Resp> => {
    signals.push(init?.signal);
    return { ok: true, status: 200, json: hangJson };
  };
  const started = Date.now();
  const out = await fetchGatewaySources({ env: { SSU_API_KEY: 'k' }, fetchFn, now: NOW, agyRun: () => null, timeoutMs: 50 });
  assert.ok(Date.now() - started < 5000, 'collection must be bounded even when json() hangs');
  assert.equal(out.find(s => s.agent === 'ssu')?.method, 'unavailable');
  assert.ok(signals.length >= 2 && signals.every(s => s?.aborted === true), 'every SSU request signal must be aborted on timeout');
});

test('G2: OpenRouter body (json) hang is bounded by the timeout AND the request is aborted', async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const fetchFn = async (_url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<Resp> => {
    signals.push(init?.signal);
    return { ok: true, status: 200, json: hangJson };
  };
  const started = Date.now();
  const out = await fetchGatewaySources({ env: { OPENROUTER_API_KEY: 'k' }, fetchFn, now: NOW, agyRun: () => null, timeoutMs: 50 });
  assert.ok(Date.now() - started < 5000, 'collection must be bounded even when json() hangs');
  assert.equal(out.find(s => s.agent === 'openrouter')?.method, 'unavailable');
  assert.ok(signals.length >= 1 && signals.every(s => s?.aborted === true), 'OpenRouter request signal must be aborted on timeout');
});

test('G3a: SSU unknown-shape basis never copies untrusted response keys', () => {
  const s = ssuSource({ [SECRET]: 1 }, null, NOW);
  assert.equal(s.method, 'unavailable');
  assert.ok(!JSON.stringify(s).includes(SECRET), 'untrusted key leaked into source');
});

test('G3b: OpenRouter unknown-shape basis never copies untrusted response keys', () => {
  const s = openRouterKey({ [SECRET]: 1, data: { other: 2 } }, NOW);
  assert.equal(s.method, 'unavailable');
  assert.ok(!JSON.stringify(s).includes(SECRET), 'untrusted key leaked into source');
});

test('G3c: agy group names from the payload never carry into the output', async () => {
  const s = (await import('../scripts/meter-readers.mts')).agyUsage(
    { groups: [{ name: SECRET, buckets: [{ window: '5h', remaining_fraction: 0.5, reset_time: '2026-10-27T11:00:00Z' }] }] }, NOW);
  assert.equal(s.method, 'measured');
  assert.ok(!JSON.stringify(s).includes(SECRET), 'agy group name leaked into output');
});

test('G4a: latestByAgent orders observed_at by epoch, not string (mixed ISO offsets)', () => {
  const mk = (pct: number, at: string) => render({ kind: 'usage.snapshot.v1', collected_at: at, sources: [{ agent: 'codex', method: 'measured', used_percent: pct, observed_at: at, basis: 'x' }] });
  // '2026-10-27T03:00:00+03:00' == 00:00Z, which is OLDER than 01:00Z despite the larger string.
  const r = latestByAgent([
    { id: 'm2', actor_id: 'grok', text: mk(99, '2026-10-27T03:00:00+03:00'), created_at: '2026-10-27T03:10:00.000Z' },
    { id: 'm1', actor_id: 'grok', text: mk(10, '2026-10-27T01:00:00.000Z'), created_at: '2026-10-27T02:30:00.000Z' },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0]?.used_percent, 10, 'epoch-newer source (01:00Z) must win over 00:00Z');
  assert.equal(r[0]?.message_id, 'm1');
});

test('G4b: latestByAgent never lets an invalid observed_at win over a valid one', () => {
  const mk = (pct: number, at: string) => render({ kind: 'usage.snapshot.v1', collected_at: at, sources: [{ agent: 'codex', method: 'measured', used_percent: pct, observed_at: at, basis: 'x' }] });
  const r = latestByAgent([
    { id: 'm2', actor_id: 'grok', text: mk(99, 'not-a-time'), created_at: '2026-10-27T03:10:00.000Z' },
    { id: 'm1', actor_id: 'grok', text: mk(10, '2026-10-27T01:00:00.000Z'), created_at: '2026-10-27T02:30:00.000Z' },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0]?.used_percent, 10);
  assert.equal(r[0]?.message_id, 'm1');
});

test('G5a: SSU used_percent above 100 is flagged out_of_range, not silently clamped to a measured 100', () => {
  const s = ssuSource({ remaining_credits: 0, monthly_credits: 3000, used_credits: 4500 }, null, NOW);
  const extra = s as unknown as Record<string, unknown>;
  assert.equal(s.used_percent, null, 'out-of-range percent must not be presented as a measured value');
  assert.equal(extra.used_percent_flag, 'out_of_range');
  assert.equal(extra.used_percent_raw, 150);
});

test('G5b: codex used_percent above 100 is flagged out_of_range, not silently clamped', () => {
  const line = JSON.stringify({ timestamp: NOW, payload: { rate_limits: { plan_type: 'pro', primary: { used_percent: 137, window_minutes: 300, resets_at: 1792302862 } } } });
  const s = codexFromLines([line], '/dev/null')!;
  const extra = s as unknown as Record<string, unknown>;
  assert.equal(s.used_percent, null);
  assert.equal(extra.used_percent_flag, 'out_of_range');
  assert.equal(extra.used_percent_raw, 137);
  assert.ok(render({ kind: 'usage.snapshot.v1', collected_at: NOW, sources: [s] }).length > 0);
});

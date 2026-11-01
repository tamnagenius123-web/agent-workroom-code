// METER fix round 5 red tests for Dots scoped FAIL 48a0a4f6 at 1d4a2b5 (ruling c1196ff6).
// Three counterexamples, fixed at shared boundaries, not per-field:
// (1) a producer out_of_range flag/raw is DELETED by the consumer sanitizer, losing the
//     anomaly explanation; (2) the sanitizer is not an allowlist — unknown extra fields,
//     agy group KEYS and a poisoned resets_at_flag pass through with markers; (3) no
//     per-source isolation — negative Muse tokens compute negative usage, a null ledger
//     entry aborts the whole collector, and an invalid Codex reset (finite but outside
//     the Date range, so toISOString throws) drops the entire source incl. its valid
//     secondary window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { codexFromLines, museFromLedger, render } from '../scripts/usage-collect.mts';
import { latestByAgent, parseSnapshot } from '../src/server/usage.ts';
import { percentField } from '../src/server/usage-validate.ts';

const NOW = '2026-10-27T08:30:00.000Z';
const SECRET = '<redacted>';
const noLeak = (v: unknown) => assert.ok(!JSON.stringify(v).includes(SECRET), 'untrusted value leaked into output');
const snapText = (sources: unknown[]) => render({ kind: 'usage.snapshot.v1', collected_at: NOW, sources: sources as never[] });

test('K1: producer out_of_range flag + raw survive the consumer sanitizer (anomaly explanation kept)', () => {
  const src = { agent: 'ssu', method: 'measured', ...percentField(150), observed_at: NOW, basis: 'x' };
  assert.equal(src.used_percent, null); assert.equal(src.used_percent_flag, 'out_of_range'); assert.equal(src.used_percent_raw, 150);
  const r = latestByAgent([{ id: 'm1', actor_id: 'grok', text: snapText([src]), created_at: '1' }]);
  assert.equal(r.length, 1);
  const s = r[0] as unknown as Record<string, unknown>;
  assert.equal(s.used_percent_flag, 'out_of_range', 'flag must survive sanitizing');
  assert.equal(s.used_percent_raw, 150, 'raw must survive sanitizing');
});

test('K2a: unknown extra fields on a snapshot source are stripped by the sanitizer allowlist', () => {
  const src = { agent: 'codex', method: 'measured', used_percent: 5, observed_at: NOW, basis: 'x', evil_field: SECRET, another: SECRET };
  const snap = parseSnapshot(snapText([src]));
  assert.ok(snap, 'snapshot must survive');
  noLeak(snap);
  const s = snap.sources[0] as unknown as Record<string, unknown>;
  assert.ok(!('evil_field' in s) && !('another' in s), 'extra fields must be stripped, not passed through');
});

test('K2b: agy group keys are untrusted — only positional group_N keys survive sanitizing', () => {
  const src = { agent: 'agy', method: 'measured', used_percent: 5, observed_at: NOW, basis: 'x',
    agy_groups_min_remaining_fraction: { [SECRET]: 0.5, group_1: 0.7 } };
  const r = latestByAgent([{ id: 'm1', actor_id: 'grok', text: snapText([src]), created_at: '1' }]);
  noLeak(r);
  const g = (r[0] as unknown as Record<string, unknown>).agy_groups_min_remaining_fraction as Record<string, unknown>;
  assert.deepEqual(Object.keys(g), ['group_1']);
  assert.equal(g.group_1, 0.7);
});

test('K2c: a poisoned resets_at_flag is dropped; the fixed code with a null resets_at is kept', () => {
  const bad = { agent: 'agy', method: 'measured', used_percent: 5, resets_at: null, resets_at_flag: SECRET, observed_at: NOW, basis: 'x' };
  const r1 = latestByAgent([{ id: 'm1', actor_id: 'grok', text: snapText([bad]), created_at: '1' }]);
  noLeak(r1);
  assert.ok(!('resets_at_flag' in (r1[0] as unknown as Record<string, unknown>)), 'non-enum flag must be stripped');
  const good = { agent: 'agy', method: 'measured', used_percent: 5, resets_at: null, resets_at_flag: 'invalid_timestamp', observed_at: NOW, basis: 'x' };
  const r2 = latestByAgent([{ id: 'm2', actor_id: 'grok', text: snapText([good]), created_at: '1' }]);
  assert.equal((r2[0] as unknown as Record<string, unknown>).resets_at_flag, 'invalid_timestamp');
});

test('K3a: negative Muse ledger tokens are rejected — usage never goes negative', () => {
  const s = museFromLedger({ budget_tokens: 1000, entries: [{ at: NOW, tokens: -500 }, { at: NOW, tokens: 100 }] }, NOW);
  assert.equal(s.tokens_total, 100, 'negative entry must contribute 0, not -500');
  assert.equal(s.used_percent, 10);
});

test('K3b: a null ledger entry is isolated to its own source — collector does not abort', () => {
  const s = museFromLedger({ budget_tokens: 1000, entries: [null, { at: NOW, tokens: 100 }] } as never, NOW);
  assert.equal(s.tokens_total, 100);
  const dead = museFromLedger(null as never, NOW);
  assert.equal(dead.agent, 'muse');
  assert.equal(dead.method, 'unavailable', 'a malformed ledger degrades its own source only');
});

test('K3c: an out-of-Date-range Codex reset is isolated — source and its windows survive, reset drops to null', () => {
  const line = JSON.stringify({ timestamp: '2026-10-27T08:00:00Z', payload: { rate_limits: { plan_type: 'pro',
    primary: { used_percent: 42, window_minutes: 300, resets_at: 1e20 },
    secondary: { used_percent: 30, window_minutes: 10080, resets_at: 1792302862 } } } });
  const s = codexFromLines([line], '/dev/null');
  assert.ok(s, 'one bad reset must not drop the whole source');
  assert.equal(s.used_percent, 42);
  assert.equal(s.resets_at, null, 'invalid reset is dropped to null, never thrown through');
});

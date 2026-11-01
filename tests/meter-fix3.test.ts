// METER fix round 3 red tests for Dots scoped FAIL 8df020e5 at d0ef48d (ruling 7b55c1d9).
// Defects: (1) agy reset_time is copied into resets_at unvalidated — any string the
// payload carries (incl. a synthetic secret) lands in the output; (2) Codex plan_type
// is copied into basis verbatim. Fix contract: every untrusted field goes through an
// allowlist — resets_at takes only a validated ISO timestamp (otherwise null plus the
// fixed resets_at_flag code), plan labels become fixed enums, unknown values are
// dropped, never echoed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { agyUsage } from '../scripts/meter-readers.mts';
import { codexFromLines } from '../scripts/usage-collect.mts';

const NOW = '2026-10-27T07:30:00.000Z';
const SECRET = 'sk-synthetic-secret-xyz';
type Extra = Record<string, unknown>;
const agy = (reset: unknown) => agyUsage({ groups: [{ name: 'g', buckets: [{ window: '5h', remaining_fraction: 0.5, reset_time: reset }] }] }, NOW);

test('H1: agy reset_time carrying a secret string is dropped, never copied into resets_at or anywhere in the output', () => {
  const s = agy(SECRET);
  assert.equal(s.method, 'measured');
  assert.equal(s.resets_at, null, 'unvalidated reset_time must not be presented as resets_at');
  assert.equal((s as unknown as Extra).resets_at_flag, 'invalid_timestamp');
  assert.ok(!JSON.stringify(s).includes(SECRET), 'untrusted reset_time leaked into output');
});

test('H2: agy reset_time that is not a real calendar date (Feb 30) is dropped with the fixed flag', () => {
  const s = agy('2026-02-30T00:00:00Z');
  assert.equal(s.resets_at, null);
  assert.equal((s as unknown as Extra).resets_at_flag, 'invalid_timestamp');
});

test('H3: agy reset_time of a non-string type is dropped with the fixed flag, never throws', () => {
  const s = agy(1792302862);
  assert.equal(s.resets_at, null);
  assert.equal((s as unknown as Extra).resets_at_flag, 'invalid_timestamp');
});

test('H4: agy valid ISO reset_time is kept verbatim and carries no flag', () => {
  const s = agy('2026-10-27T11:00:00Z');
  assert.equal(s.resets_at, '2026-10-27T11:00:00Z');
  assert.equal((s as unknown as Extra).resets_at_flag, undefined);
});

test('H5: agy valid ISO reset_time with a numeric offset is kept verbatim', () => {
  const s = agy('2026-10-27T20:00:00+09:00');
  assert.equal(s.resets_at, '2026-10-27T20:00:00+09:00');
  assert.equal((s as unknown as Extra).resets_at_flag, undefined);
});

test('H6: worst bucket with an invalid reset_time does not borrow another bucket\'s reset', () => {
  const s = agyUsage({ groups: [{ name: 'g', buckets: [
    { window: '5h', remaining_fraction: 0.5, reset_time: SECRET },
    { window: 'weekly', remaining_fraction: 0.9, reset_time: '2026-11-01T00:00:00Z' },
  ] }] }, NOW);
  assert.equal(s.used_percent, 50);
  assert.equal(s.resets_at, null, 'resets_at belongs to the worst bucket; an invalid one is dropped, not replaced');
  assert.equal((s as unknown as Extra).resets_at_flag, 'invalid_timestamp');
  assert.ok(!JSON.stringify(s).includes(SECRET));
});

const codexLine = (plan: unknown, win: unknown = 300) => JSON.stringify({ timestamp: NOW, payload: { rate_limits: { plan_type: plan, primary: { used_percent: 42, window_minutes: win, resets_at: 1792302862 } } } });

test('H7: codex plan_type carrying a secret string never lands in basis or anywhere in the output', () => {
  const s = codexFromLines([codexLine(SECRET)], '/dev/null')!;
  assert.ok(!JSON.stringify(s).includes(SECRET), 'untrusted plan_type leaked into output');
  assert.match(s.basis, /plan unrecognized/, 'unknown plan values are reported as a fixed enum label, never echoed');
});

test('H8: codex allowlisted plan_type (pro) is still named by its fixed enum label', () => {
  const s = codexFromLines([codexLine('pro')], '/dev/null')!;
  assert.match(s.basis, /plan pro/);
});

test('H9: codex window_minutes of a non-numeric type never lands in basis', () => {
  const s = codexFromLines([codexLine('pro', SECRET)], '/dev/null')!;
  assert.ok(!JSON.stringify(s).includes(SECRET), 'untrusted window_minutes leaked into output');
  assert.match(s.basis, /window unknown/);
});

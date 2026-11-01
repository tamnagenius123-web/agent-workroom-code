// METER fix round 4 red tests for Dots scoped FAIL 9c9d6cdf at 84f8696 (ruling 5da30952).
// Defect class: untrusted fields OUTSIDE the fix2/fix3 lists still pass through —
// Codex j.timestamp is copied into observed_at, a string used_percent survives, and the
// Muse ledger entry `at` is copied into observed_at; all three reach the render.
// observed_at ordering uses Date.parse, which rolls 2026-02-30 over to Mar 2 and so
// breaks newest-first; a source whose observed_at is invalid is returned as-is.
// Fix contract (ruling): ONE shared validator for every untrusted output field (fixed
// enums / numeric ranges, anything else dropped to null, never echoed) and ONE strict
// date parser (exact ISO 8601 + round-trip, overflow rejected, unparseable -> null and
// sorts last, never failing the whole result). The enumeration tests at the bottom
// poison every producer field so a future field cannot skip the validator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { codexFromLines, museFromLedger, render } from '../scripts/usage-collect.mts';
import { latestByAgent, parseSnapshot } from '../src/server/usage.ts';

const NOW = '2026-10-27T08:30:00.000Z';
const SECRET = '<redacted>';
type Extra = Record<string, unknown>;
const noLeak = (v: unknown) => assert.ok(!JSON.stringify(v).includes(SECRET), 'untrusted value leaked into output');

const codexLine = (over: Record<string, unknown>) => JSON.stringify({
  timestamp: '2026-10-27T08:00:00Z',
  payload: { rate_limits: { plan_type: 'pro', primary: { used_percent: 42, window_minutes: 300, resets_at: 1792302862 } } },
  ...over,
});

test('J1: codex timestamp carrying a secret string never reaches observed_at or any output field', () => {
  const s = codexFromLines([codexLine({ timestamp: SECRET })], '/dev/null');
  assert.ok(s); noLeak(s);
  assert.ok(s.observed_at === null || /^\d{4}-\d{2}-\d{2}T/.test(s.observed_at), 'observed_at must be a validated timestamp or null');
});

test('J2: codex string used_percent is dropped to null, never echoed', () => {
  const line = JSON.stringify({ timestamp: '2026-10-27T08:00:00Z', payload: { rate_limits: { plan_type: 'pro', primary: { used_percent: SECRET, window_minutes: 300, resets_at: 1792302862 } } } });
  const s = codexFromLines([line], '/dev/null');
  if (s) { assert.equal(s.used_percent, null); noLeak(s); }
});

test('J3: muse ledger entry `at` carrying a secret never reaches observed_at', () => {
  const s = museFromLedger({ budget_tokens: 1000, entries: [{ at: SECRET, tokens: 100 }] }, NOW);
  noLeak(s);
  assert.equal(s.observed_at, NOW, 'invalid ledger `at` falls back to the collection time, never the raw value');
});

test('J4: muse ledger `at` that is a rollover date (2026-02-30) is rejected, not parsed into March', () => {
  const s = museFromLedger({ budget_tokens: 1000, entries: [{ at: '2026-02-30T00:00:00Z', tokens: 100 }] }, NOW);
  assert.equal(s.observed_at, NOW);
});

test('J5: latestByAgent ordering uses the strict parser — a rollover observed_at cannot beat a valid older one', () => {
  const mk = (pct: number, at: string) => render({ kind: 'usage.snapshot.v1', collected_at: at, sources: [{ agent: 'codex', method: 'measured', used_percent: pct, observed_at: at, basis: 'x' }] });
  const msgs = [
    { id: 'm-new', actor_id: 'grok', text: mk(99, '2026-02-30T00:00:00Z'), created_at: '2' },
    { id: 'm-old', actor_id: 'grok', text: mk(10, '2026-01-15T00:00:00Z'), created_at: '1' },
  ];
  const r = latestByAgent(msgs);
  assert.equal(r.length, 1);
  assert.equal(r[0]?.used_percent, 10, 'rollover date must sort last (null epoch), not roll into March and win');
  assert.equal(r[0]?.message_id, 'm-old');
});

test('J6: latestByAgent never returns an invalid observed_at — it is dropped to null, source kept', () => {
  const mk = (at: string) => render({ kind: 'usage.snapshot.v1', collected_at: at, sources: [{ agent: 'codex', method: 'measured', used_percent: 5, observed_at: at, basis: 'x' }] });
  const r = latestByAgent([{ id: 'm1', actor_id: 'grok', text: mk(SECRET), created_at: '1' }]);
  assert.equal(r.length, 1, 'an invalid observed_at must not fail the whole result');
  assert.equal(r[0]?.observed_at, null);
  noLeak(r);
});

test('J7: snapshot with a string used_percent keeps the source with used_percent null (no whole-snapshot failure, no echo)', () => {
  const text = render({ kind: 'usage.snapshot.v1', collected_at: NOW, sources: [{ agent: 'codex', method: 'measured', used_percent: SECRET as unknown as number, observed_at: NOW, basis: 'x' }] });
  const snap = parseSnapshot(text);
  assert.ok(snap, 'snapshot must survive a poisoned field');
  const r = latestByAgent([{ id: 'm1', actor_id: 'grok', text, created_at: '1' }]);
  assert.equal(r.length, 1);
  assert.equal(r[0]?.used_percent, null);
  noLeak(r);
});

test('J8 (enumeration): every producer output field is validator-covered — poisoned payloads leak nothing into output or render', async () => {
  const { ssuSource, openRouterKey, agyUsage } = await import('../scripts/meter-readers.mts');
  const outs: unknown[] = [];
  outs.push(ssuSource({ remaining_credits: SECRET, total: SECRET, used: SECRET }, { usage: SECRET }, NOW));
  outs.push(openRouterKey({ usage: SECRET, limit: SECRET }, NOW));
  outs.push(agyUsage({ groups: [{ name: SECRET, buckets: [{ window: SECRET, remaining_fraction: 0.5, reset_time: SECRET }] }] }, NOW));
  outs.push(codexFromLines([codexLine({ timestamp: SECRET })], '/dev/null'));
  outs.push(museFromLedger({ budget_tokens: 1000, entries: [{ at: SECRET, tokens: 100 }] }, NOW));
  for (const o of outs) noLeak(o);
  const snap = { kind: 'usage.snapshot.v1' as const, collected_at: NOW, sources: outs.filter(Boolean) as never[] };
  noLeak(render(snap as never));
  for (const o of outs) {
    if (!o) continue;
    const e = o as Extra;
    if ('used_percent' in e && e.used_percent !== null) assert.equal(typeof e.used_percent, 'number');
    if ('resets_at' in e && e.resets_at !== null && e.resets_at !== undefined) assert.equal(typeof e.resets_at, 'string');
    if ('observed_at' in e && e.observed_at !== null) assert.match(String(e.observed_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  }
});

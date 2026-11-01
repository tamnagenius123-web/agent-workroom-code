// METER fix round 6 red tests for Dots provisional FAIL d1060027 at 28fca07.
// Counterexample (static trace by Dots): sanitizeSourceFields only cleans
// agy_groups_min_remaining_fraction when the value is a plain object. A string or
// array value is an ALLOWED_FIELDS member, so it survived the sanitizer untouched
// and could flow usage.ts parseSnapshot -> latestByAgent -> the MCP read output.
// Object values also had no [0,1] range check (the contract is a fraction:
// Partial<Record<GroupKey, number>> with zod min(0).max(1) on the schema side),
// so -0.25 / 1.5 were measured values. Fix: the field is a per-group fraction
// map or nothing — any non-object shape is deleted at the sanitizer boundary,
// and object entries survive only as group_N keys with finite numbers in [0,1].
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../scripts/usage-collect.mts';
import { latestByAgent } from '../src/server/usage.ts';

const NOW = '2026-10-27T08:30:00.000Z';
const SECRET = '<redacted>';
const noLeak = (v: unknown) => assert.ok(!JSON.stringify(v).includes(SECRET), 'untrusted value leaked into output');
const snapText = (sources: unknown[]) => render({ kind: 'usage.snapshot.v1', collected_at: NOW, sources: sources as never[] });
const readOne = (field: unknown) => {
  const src = { agent: 'agy', method: 'measured', used_percent: 5, observed_at: NOW, basis: 'x', agy_groups_min_remaining_fraction: field };
  const r = latestByAgent([{ id: 'm1', actor_id: 'grok', text: snapText([src]), created_at: '1' }]);
  assert.equal(r.length, 1);
  return r[0] as unknown as Record<string, unknown>;
};

test('K1: a string agy fraction is deleted by the sanitizer, never passed through', () => {
  const s = readOne(SECRET);
  noLeak(s);
  assert.ok(!('agy_groups_min_remaining_fraction' in s), 'string payload must be deleted, not echoed');
  const numeric = readOne('0.5');
  assert.ok(!('agy_groups_min_remaining_fraction' in numeric), 'even a numeric-looking string is the wrong shape and must be deleted');
});

test('K2: an array agy fraction is deleted by the sanitizer', () => {
  const s = readOne([0.5, 0.25]);
  assert.ok(!('agy_groups_min_remaining_fraction' in s), 'array payload must be deleted');
});

test('K3: scalar and boolean agy fractions are deleted by the sanitizer', () => {
  for (const v of [0.5, 1, true, false]) {
    const s = readOne(v);
    assert.ok(!('agy_groups_min_remaining_fraction' in s), `non-map payload ${String(v)} must be deleted`);
  }
});

test('K4: out-of-range group fractions are dropped; in-range entries survive', () => {
  const s = readOne({ group_1: -0.25, group_2: 1.5, group_3: 2, group_4: 0.5 });
  assert.deepEqual(s.agy_groups_min_remaining_fraction, { group_4: 0.5 }, 'only the [0,1] entry may survive');
});

test('K5: regression — valid group fractions incl. boundaries 0 and 1 survive unchanged', () => {
  const valid = { group_1: 0, group_2: 1, group_12: 0.25 };
  const s = readOne(valid);
  assert.deepEqual(s.agy_groups_min_remaining_fraction, valid);
});

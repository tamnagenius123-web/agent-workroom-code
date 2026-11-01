// TRACKER-LOAD-QUERY red-first tests (contract: room post 813426ae / 59eac605,
// tracker row quoted verbatim in 63628aa1).
// Pure aggregation: same input -> same output, deterministic order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTrackerLoad, TRACKER_OPEN_STATUSES } from '../src/phase-contracts/tracker-load.ts';

test('empty input gives an empty, zeroed, deterministic result', () => {
  const out = computeTrackerLoad([]);
  assert.deepEqual(out.agents, []);
  assert.equal(out.counted_units, 0);
  assert.equal(out.excluded_done, 0);
  assert.deepEqual(out.rejected, []);
  assert.equal(out.totals.open_total, 0);
  for (const s of TRACKER_OPEN_STATUSES) assert.equal(out.totals.by_status[s], 0);
});

test('counts open units per agent by role (build/review) and status', () => {
  const out = computeTrackerLoad([
    { id: 'U1', worker: 'grok', verifier: 'dots', status: 'OPEN' },
    { id: 'U2', worker: 'grok', verifier: 'Muse', status: 'CLAIMED' },
    { id: 'U3', worker: 'dots', verifier: 'grok', status: 'BLOCKED' },
  ]);
  assert.equal(out.counted_units, 3);
  const grok = out.agents.find(a => a.agent === 'grok')!;
  assert.equal(grok.build.by_status.OPEN, 1);
  assert.equal(grok.build.by_status.CLAIMED, 1);
  assert.equal(grok.build.open_total, 2);
  assert.equal(grok.review.by_status.BLOCKED, 1);
  assert.equal(grok.review.open_total, 1);
  assert.equal(grok.open_total, 3);
  // deterministic order: agents sorted by id
  assert.deepEqual(out.agents.map(a => a.agent), [...out.agents.map(a => a.agent)].sort());
});

test('author == acceptor rows are rejected, never counted', () => {
  const out = computeTrackerLoad([
    { id: 'U1', worker: 'grok', verifier: 'grok', status: 'OPEN' },
    { id: 'U2', worker: 'grok', verifier: 'dots', status: 'OPEN' },
  ]);
  assert.equal(out.counted_units, 1);
  assert.deepEqual(out.rejected, [{ id: 'U1', reason: 'author_equals_acceptor' }]);
});

test('done units are excluded, not counted as load', () => {
  const out = computeTrackerLoad([
    { id: 'U1', worker: 'grok', verifier: 'dots', status: 'DONE' },
    { id: 'U2', worker: 'grok', verifier: 'dots', status: 'MERGED' },
    { id: 'U3', worker: 'grok', verifier: 'dots', status: 'PUSHED' },
  ]);
  assert.equal(out.excluded_done, 2);
  assert.equal(out.counted_units, 1);
  assert.equal(out.totals.by_status.PUSHED, 1);
});

test('unknown agent (rev2 semantics): a one-side-missing row is missing_agent; an agent:-prefixed name buckets under its canonical id', () => {
  const out = computeTrackerLoad([
    { id: 'U1', worker: '', verifier: 'dots', status: 'OPEN' },
    { id: 'U2', worker: 'agent:nobody', verifier: 'dots', status: 'GATED' },
  ]);
  assert.equal(out.counted_units, 1);
  assert.deepEqual(out.rejected, [{ id: 'U1', reason: 'missing_agent' }]);
  const nobody = out.agents.find(a => a.agent === 'nobody')!;
  assert.equal(nobody.build.by_status.GATED, 1);
});

test('pure: same input gives the same output and the input is not mutated', () => {
  const units = [
    { id: 'U2', worker: 'dots', verifier: 'grok', status: 'FAIL' },
    { id: 'U1', worker: 'grok', verifier: 'dots', status: 'OPEN' },
  ];
  const snapshot = JSON.parse(JSON.stringify(units)) as unknown;
  const a = computeTrackerLoad(units);
  const b = computeTrackerLoad([...units].reverse());
  assert.deepEqual(a, b);
  assert.deepEqual(units, snapshot);
});

// --- rev2 (Claude FAIL 0d31518f + grok contract 7ee3189b/35ea960d/444f3f84) ---

test('rev2: canonical id — case variants of the same agent are author==acceptor', () => {
  const out = computeTrackerLoad([
    { id: 'U1', worker: 'Grok Bot', verifier: 'grok bot', status: 'OPEN' },
    { id: 'U2', worker: 'agent:muse', verifier: 'Muse', status: 'OPEN' },
  ]);
  assert.equal(out.counted_units, 0);
  assert.deepEqual(out.rejected, [
    { id: 'U1', reason: 'author_equals_acceptor' },
    { id: 'U2', reason: 'author_equals_acceptor' },
  ]);
});

test('rev2: canonical id — worker:/verifier: labels and agent: prefix are stripped before comparing and bucketing', () => {
  const out = computeTrackerLoad([
    { id: 'U1', worker: 'verifier: Muse', verifier: 'Muse', status: 'OPEN' },
    { id: 'U2', worker: 'worker: Grok Bot', verifier: 'dots', status: 'OPEN' },
    { id: 'U3', worker: 'Agent:Grok', verifier: 'dots', status: 'CLAIMED' },
  ]);
  assert.equal(out.counted_units, 2);
  assert.deepEqual(out.rejected, [{ id: 'U1', reason: 'author_equals_acceptor' }]);
  assert.equal(out.agents.find(a => a.agent === 'grok bot')!.build.by_status.OPEN, 1);
  assert.equal(out.agents.find(a => a.agent === 'grok')!.build.by_status.CLAIMED, 1);
});

test('rev2: a slash verifier cell is a set — worker matching any member is author==acceptor', () => {
  const out = computeTrackerLoad([
    { id: 'U1', worker: 'dots', verifier: 'Grok Bot/Dots', status: 'OPEN' },
    { id: 'U2', worker: 'grok', verifier: 'dots/codex', status: 'OPEN' },
  ]);
  assert.equal(out.counted_units, 1);
  assert.deepEqual(out.rejected, [{ id: 'U1', reason: 'author_equals_acceptor' }]);
  assert.equal(out.agents.find(a => a.agent === 'dots')!.review.open_total, 1);
  assert.equal(out.agents.find(a => a.agent === 'codex')!.review.open_total, 1);
  assert.equal(out.totals.open_total, 1);
});

test('rev2: both sides blank is an unclaimed row counted under unknown, never rejected', () => {
  for (const [worker, verifier] of [['', ''], ['—', '—'], ['worker:', 'verifier:'], [undefined, undefined]] as const) {
    const out = computeTrackerLoad([{ id: 'U1', worker, verifier, status: 'OPEN' }]);
    assert.equal(out.counted_units, 1, JSON.stringify([worker, verifier]));
    assert.deepEqual(out.rejected, []);
    const unknown = out.agents.find(a => a.agent === 'unknown')!;
    assert.equal(unknown.build.open_total, 1);
    assert.equal(unknown.review.open_total, 1);
  }
});

test('rev2: exactly one side blank is missing_agent, in both directions; label-only counts as blank', () => {
  const out = computeTrackerLoad([
    { id: 'U1', worker: '', verifier: 'dots', status: 'OPEN' },
    { id: 'U2', worker: 'grok', verifier: '', status: 'OPEN' },
    { id: 'U3', worker: 'worker:', verifier: 'dots', status: 'OPEN' },
    { id: 'U4', worker: 'grok', verifier: 'verifier:', status: 'OPEN' },
  ]);
  assert.equal(out.counted_units, 0);
  assert.deepEqual(out.rejected, [
    { id: 'U1', reason: 'missing_agent' },
    { id: 'U2', reason: 'missing_agent' },
    { id: 'U3', reason: 'missing_agent' },
    { id: 'U4', reason: 'missing_agent' },
  ]);
});

test('rev2: rejected is sorted by id, so reversed input with rejections gives the same output', () => {
  const units = [
    { id: 'U9', worker: 'grok', verifier: 'grok', status: 'OPEN' },
    { id: 'U1', worker: 'grok', verifier: 'GROK', status: 'OPEN' },
    { id: 'U5', worker: 'grok', verifier: 'dots', status: 'OPEN' },
  ];
  const a = computeTrackerLoad(units);
  const b = computeTrackerLoad([...units].reverse());
  assert.deepEqual(a, b);
  assert.deepEqual(a.rejected.map(r => r.id), ['U1', 'U9']);
});

test('rev2: a duplicate unit id is rejected as duplicate_unit on the second occurrence, never counted twice', () => {
  const out = computeTrackerLoad([
    { id: 'U1', worker: 'grok', verifier: 'dots', status: 'OPEN' },
    { id: 'U1', worker: 'dots', verifier: 'grok', status: 'CLAIMED' },
  ]);
  assert.equal(out.counted_units, 1);
  assert.deepEqual(out.rejected, [{ id: 'U1', reason: 'duplicate_unit' }]);
});

test('unknown status is rejected explicitly, never silently bucketed', () => {
  const out = computeTrackerLoad([
    { id: 'U1', worker: 'grok', verifier: 'dots', status: 'IN PROGRESS' },
  ]);
  assert.equal(out.counted_units, 0);
  assert.deepEqual(out.rejected, [{ id: 'U1', reason: 'unknown_status' }]);
});

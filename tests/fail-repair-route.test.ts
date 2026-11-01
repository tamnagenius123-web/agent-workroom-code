import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPAIR_PRINCIPAL, routeVerdict, type Verdict } from '../src/server/fail-repair-route.ts';

const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const SHA3 = '3'.repeat(40);
const v = (over: Partial<Verdict>): Verdict => ({
  unit: 'TG-UI', sha: SHA1, builder: 'agent:grok', verifier: 'agent:dots', result: 'FAIL', ...over,
});

test('V3-9: a FAIL on an unpinned unit creates a repair claim for Claude', () => {
  const d = routeVerdict(v({}), []);
  assert.equal(d.kind, 'repair');
  if (d.kind !== 'repair') return;
  assert.equal(REPAIR_PRINCIPAL, 'agent:claude');
  assert.deepEqual(d.claim, {
    id: `TG-UI-REPAIR-${SHA1}`,
    unit: 'TG-UI',
    failed_sha: SHA1,
    assignee: 'agent:claude',
    verifier: 'agent:dots',
  });
});

test('V3-9: a PASS creates nothing', () => {
  assert.deepEqual(routeVerdict(v({ result: 'PASS' }), []), { kind: 'none' });
});

test('V3-9: the same FAIL routed twice gives the same claim id', () => {
  const a = routeVerdict(v({}), []);
  const b = routeVerdict(v({ verifier: 'agent:muse' }), [v({})]);
  assert.equal(a.kind, 'repair');
  assert.equal(b.kind, 'repair');
  if (a.kind === 'repair' && b.kind === 'repair') assert.equal(a.claim.id, b.claim.id);
});

test('V3-9: owner-pinned units keep their builder (OR-U2 Dots, SSU-GW Grok CLI)', () => {
  const or = routeVerdict(v({ unit: 'OR-U2-RIGHTS', builder: 'agent:dots', verifier: 'agent:muse' }), []);
  assert.equal(or.kind, 'pinned');
  if (or.kind === 'pinned') assert.equal(or.claim.assignee, 'agent:dots');
  const ssu = routeVerdict(v({ unit: 'SSU-GW-S2', builder: 'agent:grok', verifier: 'agent:muse' }), []);
  assert.equal(ssu.kind, 'pinned');
  if (ssu.kind === 'pinned') assert.equal(ssu.claim.assignee, 'agent:grok');
  // A prefix match needs a unit-id boundary: OR-U20 is not OR-U2.
  assert.equal(routeVerdict(v({ unit: 'OR-U20' }), []).kind, 'repair');
});

test('V3-9: the FAILing verifier re-verifies, but never the repair author', () => {
  const d = routeVerdict(v({ builder: 'agent:dots', verifier: 'agent:claude' }), []);
  assert.equal(d.kind, 'repair');
  if (d.kind === 'repair') assert.equal(d.claim.verifier, null);
});

test('V3-9: a self-verdict (verifier is the builder) is rejected, not routed', () => {
  assert.deepEqual(routeVerdict(v({ verifier: 'agent:grok' }), []), { kind: 'rejected', reason: 'self_verdict' });
});

test('V3-9 vs V3-7: two FAILs by Claude on a unit hand it to V3-7 reassignment, not back to Claude', () => {
  const history = [v({ sha: SHA1, builder: 'agent:grok' }), v({ sha: SHA2, builder: 'agent:claude' })];
  const d = routeVerdict(v({ sha: SHA3, builder: 'agent:claude' }), history);
  assert.deepEqual(d, { kind: 'reassign', unit: 'TG-UI', barred: ['agent:claude'] });
});

test('V3-9 vs V3-7: two verifiers FAILing one sha count as one builder failure', () => {
  const history = [v({ sha: SHA2, builder: 'agent:claude', verifier: 'agent:muse' })];
  const d = routeVerdict(v({ sha: SHA2, builder: 'agent:claude', verifier: 'agent:dots' }), history);
  assert.equal(d.kind, 'repair');
});

test('V3-9 vs V3-7: the original builder with two FAILs is barred, Claude still repairs', () => {
  const history = [v({ sha: SHA1 })];
  const d = routeVerdict(v({ sha: SHA2 }), history);
  assert.equal(d.kind, 'repair');
});

test('V3-9 vs V3-7: a pinned builder with two FAILs goes to the owner, not to another builder', () => {
  const pin = { unit: 'OR-U2', builder: 'agent:dots', verifier: 'agent:muse' } as const;
  const d = routeVerdict(v({ ...pin, sha: SHA2 }), [v({ ...pin, sha: SHA1 })]);
  assert.deepEqual(d, { kind: 'owner', unit: 'OR-U2', pinned: 'agent:dots', barred: ['agent:dots'] });
});

test('V3-9: history from other units does not count', () => {
  const history = [v({ unit: 'TG-MIRROR-R6', sha: SHA1, builder: 'agent:claude' })];
  assert.equal(routeVerdict(v({ sha: SHA2, builder: 'agent:claude' }), history).kind, 'repair');
});

// Dots 7e7c4d9f: two valid shas sharing a 7-char prefix must not collide into one claim id.
test('V3-9: distinct shas with the same 7-char prefix get distinct claim ids', () => {
  const a = routeVerdict(v({ sha: 'abcdef0' + '1'.repeat(33) }), []);
  const b = routeVerdict(v({ sha: 'abcdef0' + '2'.repeat(33) }), []);
  assert.equal(a.kind, 'repair');
  assert.equal(b.kind, 'repair');
  if (a.kind === 'repair' && b.kind === 'repair') assert.notEqual(a.claim.id, b.claim.id);
});

test('V3-9: a malformed incoming verdict is rejected, never routed or thrown on', () => {
  const bad: unknown[] = [
    { sha: 'abc' }, { sha: 'ABCDEF0' + '1'.repeat(33) }, { sha: null }, { sha: 1234567 },
    { builder: 'grok' }, { verifier: null }, { unit: '' }, { unit: 'TG UI' }, { result: 'fail' },
  ];
  for (const over of bad) {
    const d = routeVerdict({ ...v({}), ...(over as object) } as Verdict, []);
    assert.deepEqual(d, { kind: 'rejected', reason: 'invalid_verdict' }, JSON.stringify(over));
  }
});

test('V3-9: malformed history entries do not count toward the V3-7 bar', () => {
  const junk = [
    v({ sha: 'not-a-sha', builder: 'agent:claude' }),
    { ...v({ builder: 'agent:claude' }), sha: null } as unknown as Verdict,
    { ...v({ builder: 'agent:claude' }), sha: 42 } as unknown as Verdict,
  ];
  const d = routeVerdict(v({ sha: SHA3, builder: 'agent:claude' }), junk);
  assert.equal(d.kind, 'repair');
});

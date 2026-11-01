import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { projectBrief } from '../src/checkin/project.ts';
import { renderMarkdown } from '../src/checkin/render.ts';
import type { CheckinBrief } from '../src/checkin/types.ts';

// Check-in read projection: the brief must project claim/blocked/review/
// unknown from one state-ledger snapshot and must NEVER hide partiality.
// The unforgivable bug for this unit is a brief that looks complete while a
// section is unknown, so most tests assert the PARTIAL reasons explicitly.

const NOW = new Date('2026-11-01T01:35:00.000Z');
const ACTOR = 'agent:muse';

function load(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/checkin/${name}`, import.meta.url), 'utf8'));
}

function brief(name: string, actor: string | null = ACTOR): CheckinBrief {
  return projectBrief(load(name), { actor, now: NOW });
}

function reasonCodes(b: CheckinBrief): string[] {
  return b.header.partialReasons.map((r) => r.code).sort();
}

const STANDING = ['claims-not-in-snapshot', 'extraction-completeness-unverifiable'];

test('healthy snapshot: header carries watermark, age and standing PARTIAL reasons', () => {
  const b = brief('healthy.json');
  assert.equal(b.header.status, 'PARTIAL');
  assert.deepEqual(reasonCodes(b), STANDING);
  assert.equal(b.header.room, 'room_main');
  assert.equal(b.header.builtAt, '2026-11-01T01:30:00.000Z');
  assert.equal(b.header.ageMs, 5 * 60 * 1000);
  assert.equal(b.header.watermark.lastMessageId, 'msg-last-1');
  assert.equal(b.header.watermark.lastMessageAt, '2026-11-01T01:29:00.000Z');
  assert.equal(b.header.watermark.mainSha, '1111111111111111111111111111111111111111');
});

test('claims section is UNKNOWN with zero fabricated items (FR-004)', () => {
  const b = brief('healthy.json');
  assert.equal(b.claims.status, 'UNKNOWN');
  assert.equal(b.claims.items.length, 0);
  assert.match(b.claims.reason, /no claim records/);
});

test('blocked section lists gates with provenance, newest first (FR-005)', () => {
  const b = brief('healthy.json');
  assert.equal(b.blocked.length, 2);
  const [first, second] = b.blocked;
  assert.equal(first?.kind, 'BLOCKED');
  assert.equal(first?.ref, 'msg-blocked-1');
  assert.equal(first?.raisedBy, 'agent:dots');
  assert.equal(first?.pr, 103);
  assert.equal(first?.waitingOn, null);
  assert.equal(second?.kind, 'HOLD');
  assert.equal(second?.source, 'decisions');
  assert.equal(b.summary.blocked, 1);
  assert.equal(b.summary.holds, 1);
});

test('reviews: satisfied PR drops out, no-verdict and after-FAIL stay (FR-006)', () => {
  const b = brief('healthy.json');
  assert.deepEqual(
    b.reviews.awaiting.map((r) => r.pr),
    [102, 103],
  );
  assert.equal(b.reviews.satisfiedCount, 1);
  const gadget = b.reviews.awaiting.find((r) => r.pr === 102);
  assert.equal(gadget?.state, 'no-verdicts');
  assert.equal(gadget?.awaitingMe, true);
  const gizmo = b.reviews.awaiting.find((r) => r.pr === 103);
  assert.equal(gizmo?.state, 'after-fail');
  assert.equal(gizmo?.awaitingMe, false); // authored by the checking-in actor
  assert.equal(gizmo?.verdicts[0]?.messageId, 'msg-fail-103');
});

test('reviews: without an actor, awaitingMe is false everywhere', () => {
  const b = brief('healthy.json', null);
  assert.ok(b.reviews.awaiting.every((r) => r.awaitingMe === false));
});

test('stale snapshot adds stale-snapshot reason and reports age (US3)', () => {
  const b = brief('stale.json');
  assert.ok(reasonCodes(b).includes('stale-snapshot'));
  assert.equal(b.header.ageMs, (5 * 60 + 35) * 60 * 1000);
});

test('truncated snapshot adds count-mismatch reasons with omitted counts (US3)', () => {
  const b = brief('truncated.json');
  const codes = reasonCodes(b);
  assert.ok(codes.includes('count-mismatch:prs'));
  assert.ok(codes.includes('count-mismatch:decisions'));
  const prs = b.header.partialReasons.find((r) => r.code === 'count-mismatch:prs');
  assert.match(prs?.detail ?? '', /omitted 2/);
});

test('conflicts: self/stale/unbound PASS never satisfies the gate (FR-006)', () => {
  const b = brief('conflicts.json');
  assert.deepEqual(
    b.reviews.awaiting.map((r) => r.pr),
    [202, 203, 204, 205],
  );
  const byPr = new Map(b.reviews.awaiting.map((r) => [r.pr, r]));
  assert.ok(byPr.get(202)?.flags.includes('self-pass-not-counted'));
  assert.equal(byPr.get(202)?.state, 'no-valid-pass');
  assert.ok(byPr.get(203)?.flags.includes('stale-pass'));
  assert.ok(byPr.get(204)?.flags.includes('unbound-pass'));
  assert.equal(b.reviews.satisfiedCount, 1); // #201 has a gate-valid PASS
});

test('conflicts: PASS+FAIL, orphans and missing head ref surface as UNKNOWN (FR-007)', () => {
  const b = brief('conflicts.json');
  const kinds = b.unknown.map((u) => `${u.kind}:${u.pr ?? ''}`);
  assert.ok(kinds.includes('pass-fail-conflict:201'));
  assert.ok(kinds.includes('orphan-verdict:999'));
  assert.ok(kinds.includes('orphan-gate:998'));
  assert.ok(kinds.includes('head-ref-missing:205'));
  const conflict = b.unknown.find((u) => u.kind === 'pass-fail-conflict');
  assert.ok(conflict?.refs.includes('msg-pass-201'));
  assert.ok(conflict?.refs.includes('msg-fail-201'));
  // the orphan gate is still a gate: it stays in the blocked section too
  assert.ok(b.blocked.some((g) => g.pr === 998));
});

test('empty snapshot: standing reasons only, all sections empty, no false stale', () => {
  const b = brief('empty.json');
  assert.equal(b.header.status, 'PARTIAL');
  assert.deepEqual(reasonCodes(b), STANDING);
  assert.equal(b.reviews.awaiting.length, 0);
  assert.equal(b.blocked.length, 0);
  assert.equal(b.summary.openPrs, 0);
  assert.ok(b.unknown.some((u) => u.kind === 'extraction-caveat'));
  assert.ok(!b.unknown.some((u) => u.kind === 'pass-fail-conflict'));
});

test('unexpected schema is flagged, projection still produced', () => {
  const raw = load('healthy.json') as Record<string, unknown>;
  const b = projectBrief({ ...raw, schema: 'state-ledger/2' }, { actor: ACTOR, now: NOW });
  assert.ok(reasonCodes(b).includes('unexpected-schema'));
  assert.equal(b.reviews.awaiting.length, 2);
});

test('non-object input throws a plain error instead of fabricating a brief', () => {
  assert.throws(() => projectBrief(42, { actor: ACTOR, now: NOW }), /snapshot must be a JSON object/);
  assert.throws(() => projectBrief(null, { actor: ACTOR, now: NOW }), /snapshot must be a JSON object/);
});

test('markdown render carries status, reasons, sections and source refs (FR-009)', () => {
  const md = renderMarkdown(brief('healthy.json'));
  assert.match(md, /PARTIAL/);
  assert.match(md, /claims-not-in-snapshot/);
  assert.match(md, /msg-last-1/);
  assert.match(md, /## Open claims — UNKNOWN/);
  assert.match(md, /msg-blocked-1/);
  assert.match(md, /#102/);
  assert.match(md, /msg-fail-103/);
});

test('projection and render are deterministic', () => {
  const a = brief('conflicts.json');
  const b = brief('conflicts.json');
  assert.deepEqual(a, b);
  assert.equal(renderMarkdown(a), renderMarkdown(b));
});

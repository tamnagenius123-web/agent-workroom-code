import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCHEMA_VERSION, SKILL_STAGES, SKILL_STAGE_REJECT, createSkillStage, nextSkillStage, previousSkillStage,
  recordIsLiveProof, reduceSkillStage, skillCandidateView, skillStageAuthorization, validateSkillCandidate,
  type SkillStage, type SkillStageEvent, type SkillStageKind, type SkillStageRecord, type SkillStageRejectCode,
  type SkillStageResult,
} from '../src/phase-contracts/index.ts';

const PROPOSER = 'agent:grok';
const SKILL = 'skill:cand-1';
const REVIEWER = 'agent:muse';
const OTHER = 'agent:dots';

function start(version = '2'): SkillStageRecord {
  return createSkillStage({ skill_id: SKILL, proposer_id: PROPOSER, version });
}

function promote(to: SkillStage, revision: number, id: string, actor?: string): SkillStageEvent {
  return {
    id,
    kind: 'promote',
    actor: actor ?? (to === 'promoted' ? REVIEWER : PROPOSER),
    expected_revision: revision,
    to,
  };
}

function revert(to: SkillStage, revision: number, id: string, rollback_to = '1', actor = REVIEWER): SkillStageEvent {
  return { id, kind: 'revert', actor, expected_revision: revision, to, rollback_to };
}

function applied(result: SkillStageResult): SkillStageRecord {
  if (!result.ok) assert.fail(`${result.code}: ${result.message}`);
  return result.state;
}

function rejected(result: SkillStageResult, code: SkillStageRejectCode, original: SkillStageRecord): void {
  const stage = original.stage;
  const revision = original.revision;
  const seen = original.seen_event_ids.length;
  const rollback = original.rollback_to;
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, code);
  assert.equal(result.state, original);
  assert.equal(original.stage, stage);
  assert.equal(original.revision, revision);
  assert.equal(original.seen_event_ids.length, seen);
  assert.equal(original.rollback_to, rollback);
}

function actorFor(to: SkillStage): string {
  return to === 'promoted' ? REVIEWER : PROPOSER;
}

function withRevision(revision: number, stage: SkillStage = 'candidate'): SkillStageRecord {
  return { ...start(), stage, revision, merge_authorized: false, deploy_authorized: false };
}

function climbTo(target: SkillStage, from: SkillStageRecord = start()): SkillStageRecord {
  let state = from;
  const fromIndex = SKILL_STAGES.indexOf(state.stage);
  const end = SKILL_STAGES.indexOf(target);
  assert.ok(fromIndex >= 0 && end >= fromIndex);
  while (state.stage !== target) {
    const to = nextSkillStage(state.stage);
    if (to === null) assert.fail(`no next stage from ${state.stage}`);
    state = applied(reduceSkillStage(state, promote(to, state.revision, `up-${state.revision}`, actorFor(to))));
  }
  return state;
}

function assertUnauthorized(state: SkillStageRecord): void {
  assert.equal(state.merge_authorized, false);
  assert.equal(state.deploy_authorized, false);
  assert.deepEqual(skillStageAuthorization(state), {
    stage: state.stage,
    merge_authorized: false,
    deploy_authorized: false,
  });
  const view = skillCandidateView(state);
  assert.equal(view.ok, true, view.ok ? '' : view.errors.join(' | '));
  if (!view.ok) return;
  assert.equal(recordIsLiveProof(view.value), false);
  assert.equal(view.value.stage, state.stage);
  assert.equal(view.value.promoter_id, state.promoter_id);
  assert.equal(view.value.rollback_to, state.rollback_to);
}

test('transitions follow SKILL_STAGES one adjacent step at a time', () => {
  assert.deepEqual([...SKILL_STAGES], ['candidate', 'shadow', 'replay', 'prospective', 'independent_review', 'promoted']);
  const first = SKILL_STAGES[0];
  assert.ok(first);
  assert.equal(previousSkillStage(first), null);
  for (let i = 0; i < SKILL_STAGES.length; i += 1) {
    const stage = SKILL_STAGES[i];
    assert.ok(stage);
    const next = SKILL_STAGES[i + 1] ?? null;
    assert.equal(nextSkillStage(stage), next);
    if (next) assert.equal(previousSkillStage(next), stage);
  }
});

test('createSkillStage opens at candidate revision 0 with no merge or deploy authority', () => {
  const state = start();
  assert.equal(state.skill_id, SKILL);
  assert.equal(state.proposer_id, PROPOSER);
  assert.equal(state.promoter_id, null);
  assert.equal(state.stage, 'candidate');
  assert.equal(state.version, '2');
  assert.equal(state.rollback_to, null);
  assert.equal(state.revision, 0);
  assert.deepEqual([...state.seen_event_ids], []);
  assert.deepEqual([...state.history], []);
  assertUnauthorized(state);
});

test('createSkillStage refuses a record the skill-candidate validator rejects', () => {
  assert.throws(
    () => createSkillStage({ skill_id: 'has space', proposer_id: PROPOSER, version: '1' }),
    /skill_candidate\.skill_id/,
  );
  assert.throws(
    () => createSkillStage({ skill_id: SKILL, proposer_id: PROPOSER, version: 'v1' }),
    /skill_candidate\.version/,
  );
});

test('happy path climbs one stage at a time and sets the promoter only at promoted', () => {
  const opened = start();
  let state = applied(reduceSkillStage(opened, promote('shadow', 0, 'e1', PROPOSER)));
  assert.equal(opened.stage, 'candidate');
  assert.equal(opened.revision, 0);
  assert.equal(state.stage, 'shadow');
  assert.equal(state.revision, 1);
  assert.equal(state.promoter_id, null);
  state = applied(reduceSkillStage(state, promote('replay', 1, 'e2', PROPOSER)));
  state = applied(reduceSkillStage(state, promote('prospective', 2, 'e3', SKILL)));
  state = applied(reduceSkillStage(state, promote('independent_review', 3, 'e4', PROPOSER)));
  assert.equal(state.promoter_id, null);
  state = applied(reduceSkillStage(state, promote('promoted', 4, 'e5', OTHER)));
  assert.equal(state.stage, 'promoted');
  assert.equal(state.revision, 5);
  assert.equal(state.promoter_id, OTHER);
  assert.deepEqual([...state.seen_event_ids], ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.equal(state.history.length, 5);
  assert.equal(state.history[4]?.actor, OTHER);
  assert.equal(state.history[4]?.from, 'independent_review');
  assert.equal(state.history[4]?.to, 'promoted');
  assert.equal(state.history[4]?.rollback_to, null);
  assertUnauthorized(state);
});

test('the proposer may advance through independent_review', () => {
  let state = applied(reduceSkillStage(start(), promote('shadow', 0, 'a1', PROPOSER)));
  state = applied(reduceSkillStage(state, promote('replay', 1, 'a2', SKILL)));
  state = applied(reduceSkillStage(state, promote('prospective', 2, 'a3', PROPOSER)));
  state = applied(reduceSkillStage(state, promote('independent_review', 3, 'a4', PROPOSER)));
  assert.equal(state.stage, 'independent_review');
  assert.equal(state.promoter_id, null);
  assertUnauthorized(state);
});

test('rollback walks one stage back to an earlier version and records the revert', () => {
  let state = climbTo('promoted');
  state = applied(reduceSkillStage(state, revert('independent_review', state.revision, 'rb1', '1')));
  const last = state.history[state.history.length - 1];
  assert.equal(state.stage, 'independent_review');
  assert.equal(state.promoter_id, null);
  assert.equal(state.version, '2');
  assert.equal(state.rollback_to, '1');
  assert.equal(last?.kind, 'revert');
  assert.equal(last?.from, 'promoted');
  assert.equal(last?.to, 'independent_review');
  assert.equal(last?.event_id, 'rb1');
  assert.equal(last?.rollback_to, '1');
  state = applied(reduceSkillStage(state, revert('prospective', state.revision, 'rb2', '0.9', PROPOSER)));
  state = applied(reduceSkillStage(state, revert('replay', state.revision, 'rb3', '0.8')));
  state = applied(reduceSkillStage(state, revert('shadow', state.revision, 'rb4', '0.2')));
  state = applied(reduceSkillStage(state, revert('candidate', state.revision, 'rb5', '0.1')));
  assert.equal(state.stage, 'candidate');
  assert.equal(state.rollback_to, '0.1');
  assert.equal(state.history.filter(row => row.kind === 'revert').length, 5);
  assertUnauthorized(state);
});

test('after rollback the candidate can climb again with a promoter who is not the proposer', () => {
  let state = climbTo('independent_review');
  state = applied(reduceSkillStage(state, revert('prospective', state.revision, 'down-1', '1')));
  assert.equal(state.stage, 'prospective');
  state = applied(reduceSkillStage(state, promote('independent_review', state.revision, 'up-again', OTHER)));
  state = applied(reduceSkillStage(state, promote('promoted', state.revision, 'up-promoted', REVIEWER)));
  assert.equal(state.stage, 'promoted');
  assert.equal(state.promoter_id, REVIEWER);
  assert.equal(state.rollback_to, '1');
  assertUnauthorized(state);
});

test('promote then revert at successive revisions is rollback, not concurrency', () => {
  const opened = start();
  const shadowed = applied(reduceSkillStage(opened, promote('shadow', 0, 'p1', PROPOSER)));
  const rolled = applied(reduceSkillStage(shadowed, revert('candidate', 1, 'r1', '1')));
  assert.equal(rolled.stage, 'candidate');
  assert.equal(rolled.revision, 2);
  assert.equal(rolled.rollback_to, '1');
  const batched = applied(reduceSkillStage(start(), [
    promote('shadow', 0, 'b-p'),
    revert('candidate', 1, 'b-r', '1'),
  ]));
  assert.equal(batched.stage, 'candidate');
  assert.equal(batched.revision, 2);
});

test('rejects a skipped stage on promote and revert', () => {
  const opened = start();
  rejected(reduceSkillStage(opened, promote('replay', 0, 'skip-1', PROPOSER)), SKILL_STAGE_REJECT.skipped_stage, opened);
  rejected(reduceSkillStage(opened, promote('prospective', 0, 'skip-2', PROPOSER)), SKILL_STAGE_REJECT.skipped_stage, opened);
  rejected(reduceSkillStage(opened, promote('independent_review', 0, 'skip-3')), SKILL_STAGE_REJECT.skipped_stage, opened);
  rejected(reduceSkillStage(opened, promote('promoted', 0, 'skip-4')), SKILL_STAGE_REJECT.skipped_stage, opened);
  rejected(reduceSkillStage(opened, promote('candidate', 0, 'stay', PROPOSER)), SKILL_STAGE_REJECT.skipped_stage, opened);
  rejected(reduceSkillStage(opened, revert('candidate', 0, 'no-prev', '1')), SKILL_STAGE_REJECT.skipped_stage, opened);
  rejected(reduceSkillStage(opened, revert('shadow', 0, 'wrong-way', '1')), SKILL_STAGE_REJECT.skipped_stage, opened);

  const shadow = climbTo('shadow');
  rejected(reduceSkillStage(shadow, promote('prospective', 1, 'skip-fwd', PROPOSER)), SKILL_STAGE_REJECT.skipped_stage, shadow);
  rejected(reduceSkillStage(shadow, revert('replay', 1, 'skip-back', '1')), SKILL_STAGE_REJECT.skipped_stage, shadow);

  const promoted = climbTo('promoted');
  rejected(reduceSkillStage(promoted, promote('promoted', 5, 'no-next')), SKILL_STAGE_REJECT.skipped_stage, promoted);
  rejected(reduceSkillStage(promoted, revert('candidate', 5, 'jump-back', '1')), SKILL_STAGE_REJECT.skipped_stage, promoted);
  rejected(reduceSkillStage(promoted, revert('prospective', 5, 'skip-back-2', '1')), SKILL_STAGE_REJECT.skipped_stage, promoted);
  assert.equal(promoted.rollback_to, null);
});

test('rejects a stale revision before a bad rollback or a skipped stage is considered', () => {
  const opened = start();
  const shadow = applied(reduceSkillStage(opened, promote('shadow', 0, 'fresh', PROPOSER)));
  rejected(reduceSkillStage(shadow, promote('replay', 0, 'late', PROPOSER)), SKILL_STAGE_REJECT.stale_revision, shadow);
  rejected(reduceSkillStage(shadow, promote('replay', 2, 'early', PROPOSER)), SKILL_STAGE_REJECT.stale_revision, shadow);
  rejected(reduceSkillStage(opened, promote('shadow', 1, 'ahead', PROPOSER)), SKILL_STAGE_REJECT.stale_revision, opened);
  rejected(reduceSkillStage(shadow, revert('candidate', 0, 'stale-rb', '9')), SKILL_STAGE_REJECT.stale_revision, shadow);
});

test('rejects a duplicate event id before the stale-revision check', () => {
  const opened = start();
  const first = promote('shadow', 0, 'dup-1', PROPOSER);
  const shadow = applied(reduceSkillStage(opened, first));
  rejected(reduceSkillStage(shadow, first), SKILL_STAGE_REJECT.duplicate_event, shadow);
  rejected(reduceSkillStage(shadow, promote('replay', 1, 'dup-1', PROPOSER)), SKILL_STAGE_REJECT.duplicate_event, shadow);
  const replayed = applied(reduceSkillStage(shadow, [promote('replay', 1, 'ok-2', PROPOSER), promote('prospective', 2, 'ok-3', PROPOSER)]));
  rejected(reduceSkillStage(replayed, promote('independent_review', 3, 'ok-2')), SKILL_STAGE_REJECT.duplicate_event, replayed);
});

test('rejects concurrent promote and revert at the same revision before any event applies', () => {
  const opened = start();
  const up = promote('shadow', 0, 'c-up', PROPOSER);
  const down = revert('candidate', 0, 'c-down', '1');
  rejected(reduceSkillStage(opened, [up, down]), SKILL_STAGE_REJECT.concurrent_promote_revert, opened);
  rejected(reduceSkillStage(opened, [down, up]), SKILL_STAGE_REJECT.concurrent_promote_revert, opened);

  const shadow = climbTo('shadow');
  rejected(
    reduceSkillStage(shadow, [promote('replay', 1, 'c-up-2', PROPOSER), revert('candidate', 1, 'c-down-2', '1')]),
    SKILL_STAGE_REJECT.concurrent_promote_revert,
    shadow,
  );
  const mixed = [
    promote('replay', 1, 'seq-up', PROPOSER),
    promote('prospective', 2, 'seq-up-2', PROPOSER),
    revert('prospective', 2, 'seq-down', '1'),
  ];
  rejected(reduceSkillStage(shadow, mixed), SKILL_STAGE_REJECT.concurrent_promote_revert, shadow);
  assert.equal(shadow.stage, 'shadow');
  assert.equal(shadow.revision, 1);

  const badShapeStillConcurrent = reduceSkillStage(opened, [
    { id: '', kind: 'promote', actor: '', expected_revision: 0, to: 'shadow' },
    { id: 'x', kind: 'revert', actor: REVIEWER, expected_revision: 0, to: 'candidate', rollback_to: '1' },
  ]);
  rejected(badShapeStillConcurrent, SKILL_STAGE_REJECT.concurrent_promote_revert, opened);
});

test('reuses the skill-candidate rule that the proposer may never be the promoter', () => {
  const review = climbTo('independent_review');
  const self = promote('promoted', review.revision, 'self-a', PROPOSER);
  rejected(reduceSkillStage(review, self), SKILL_STAGE_REJECT.proposer_equals_promoter, review);
  const forged = {
    schema_version: SCHEMA_VERSION,
    consumer: 'P6' as const,
    provenance: {
      kind: 'synthetic_fixture' as const,
      producer_id: 'skill_stage_reducer',
      source_ref: 'skill-stage-reducer',
    },
    proof_mode: 'synthetic' as const,
    skill_id: SKILL,
    stage: 'promoted' as const,
    version: review.version,
    rollback_to: null,
    proposer_id: PROPOSER,
    promoter_id: PROPOSER,
  };
  const verdict = validateSkillCandidate(forged);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.ok(verdict.errors.some(error => error.includes('proposer may never equal promoter')));
  const refused = reduceSkillStage(review, self);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.message, /proposer may never equal promoter/);

  const promoted = applied(reduceSkillStage(review, promote('promoted', review.revision, 'ok-pr', OTHER)));
  assert.equal(promoted.stage, 'promoted');
  assert.equal(promoted.promoter_id, OTHER);
  assertUnauthorized(promoted);
});

test('the proposer may revert from promoted', () => {
  const promoted = climbTo('promoted');
  const down = applied(reduceSkillStage(promoted, revert('independent_review', promoted.revision, 'author-rb', '1', PROPOSER)));
  assert.equal(down.stage, 'independent_review');
  assert.equal(down.promoter_id, null);
  assert.equal(down.rollback_to, '1');
  assertUnauthorized(down);
});

test('rollback_to must be strictly earlier than the current version', () => {
  const opened = createSkillStage({ skill_id: SKILL, proposer_id: PROPOSER, version: '1' });
  const shadow = applied(reduceSkillStage(opened, promote('shadow', 0, 'p', PROPOSER)));
  const sameNumber = {
    schema_version: SCHEMA_VERSION,
    consumer: 'P6' as const,
    provenance: {
      kind: 'synthetic_fixture' as const,
      producer_id: 'skill_stage_reducer',
      source_ref: 'skill-stage-reducer',
    },
    proof_mode: 'synthetic' as const,
    skill_id: SKILL,
    stage: 'candidate' as const,
    version: '1',
    rollback_to: '1.0',
    proposer_id: PROPOSER,
    promoter_id: null,
  };
  assert.equal(validateSkillCandidate(sameNumber).ok, true);
  rejected(reduceSkillStage(shadow, revert('candidate', 1, 'rb-tie', '1.0')), SKILL_STAGE_REJECT.rollback_not_earlier, shadow);
  rejected(reduceSkillStage(shadow, revert('candidate', 1, 'rb-pad', '1.0.0')), SKILL_STAGE_REJECT.rollback_not_earlier, shadow);
  rejected(reduceSkillStage(shadow, revert('candidate', 1, 'rb-same', '1')), SKILL_STAGE_REJECT.rollback_not_earlier, shadow);
  rejected(reduceSkillStage(shadow, revert('candidate', 1, 'rb-later', '2')), SKILL_STAGE_REJECT.rollback_not_earlier, shadow);
  rejected(reduceSkillStage(shadow, revert('candidate', 1, 'rb-shape', 'v1')), SKILL_STAGE_REJECT.invalid_input, shadow);
  rejected(reduceSkillStage(shadow, { id: 'rb-null', kind: 'revert' as SkillStageKind, actor: REVIEWER, expected_revision: 1, to: 'candidate' }), SKILL_STAGE_REJECT.invalid_input, shadow);

  const earlier = applied(reduceSkillStage(shadow, revert('candidate', 1, 'rb-ok', '0.9')));
  assert.equal(earlier.rollback_to, '0.9');
  assert.equal(earlier.version, '1');
  assertUnauthorized(earlier);

  const high = createSkillStage({ skill_id: SKILL, proposer_id: PROPOSER, version: '1.10.0' });
  const moved = applied(reduceSkillStage(high, promote('shadow', 0, 'h', PROPOSER)));
  const back = applied(reduceSkillStage(moved, revert('candidate', 1, 'hb', '1.2.0')));
  assert.equal(back.rollback_to, '1.2.0');
  rejected(reduceSkillStage(moved, revert('candidate', 1, 'later-patch', '1.10.1')), SKILL_STAGE_REJECT.rollback_not_earlier, moved);
  const dotted = createSkillStage({ skill_id: SKILL, proposer_id: PROPOSER, version: '1.2' });
  const dottedShadow = applied(reduceSkillStage(dotted, promote('shadow', 0, 'd', PROPOSER)));
  rejected(reduceSkillStage(dottedShadow, revert('candidate', 1, 'pad-tie', '1.2.0')), SKILL_STAGE_REJECT.rollback_not_earlier, dottedShadow);
});

test('promoted never implies merge or deploy authorization', () => {
  for (const stage of SKILL_STAGES) assertUnauthorized(climbTo(stage));
  const rolled = applied(reduceSkillStage(climbTo('promoted'), revert('independent_review', 5, 'auth-rb', '1')));
  assertUnauthorized(rolled);
  const again = applied(reduceSkillStage(rolled, promote('promoted', rolled.revision, 'auth-up', OTHER)));
  assert.equal(again.stage, 'promoted');
  assert.equal(again.merge_authorized, false);
  assert.equal(again.deploy_authorized, false);
  assertUnauthorized(again);
});

test('a rejected event does not consume its id, so a corrected retry may reuse it', () => {
  const opened = start();
  rejected(reduceSkillStage(opened, promote('replay', 0, 'retry-id', PROPOSER)), SKILL_STAGE_REJECT.skipped_stage, opened);
  const shadow = applied(reduceSkillStage(opened, promote('shadow', 0, 'retry-id', PROPOSER)));
  assert.deepEqual([...shadow.seen_event_ids], ['retry-id']);
});

test('a batch of successive promotions applies in order when revisions chain', () => {
  const opened = start();
  const state = applied(reduceSkillStage(opened, [
    promote('shadow', 0, 'b1', PROPOSER),
    promote('replay', 1, 'b2', PROPOSER),
    promote('prospective', 2, 'b3', SKILL),
    promote('independent_review', 3, 'b4', PROPOSER),
    promote('promoted', 4, 'b5', OTHER),
  ]));
  assert.equal(state.stage, 'promoted');
  assert.equal(state.revision, 5);
  assert.equal(state.promoter_id, OTHER);
  assert.equal(opened.revision, 0);
  assertUnauthorized(state);
});

test('a batch stops at the first bad event and keeps the prefix on the returned state', () => {
  const opened = start();
  const result = reduceSkillStage(opened, [
    promote('shadow', 0, 'ok'),
    promote('promoted', 1, 'skip'),
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, SKILL_STAGE_REJECT.skipped_stage);
  assert.equal(result.state.stage, 'shadow');
  assert.equal(result.state.revision, 1);
  assert.deepEqual([...result.state.seen_event_ids], ['ok']);
  assert.equal(opened.stage, 'candidate');
  assert.equal(opened.revision, 0);
});

test('an empty batch is a no-op', () => {
  const opened = start();
  const result = reduceSkillStage(opened, []);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state, opened);
});

test('an invalid event shape is rejected without mutation', () => {
  const opened = start();
  rejected(reduceSkillStage(opened, promote('shadow', 0, '', PROPOSER)), SKILL_STAGE_REJECT.invalid_input, opened);
  rejected(
    reduceSkillStage(opened, { id: 'bad-kind', kind: 'advance' as SkillStageKind, actor: PROPOSER, expected_revision: 0, to: 'shadow' }),
    SKILL_STAGE_REJECT.invalid_input,
    opened,
  );
  rejected(
    reduceSkillStage(opened, { id: 'bad-to', kind: 'promote', actor: PROPOSER, expected_revision: 0, to: 'live' as SkillStage }),
    SKILL_STAGE_REJECT.invalid_input,
    opened,
  );
  rejected(
    reduceSkillStage(opened, { id: 'bad-rev', kind: 'promote', actor: PROPOSER, expected_revision: 1.5, to: 'shadow' }),
    SKILL_STAGE_REJECT.invalid_input,
    opened,
  );
  rejected(
    reduceSkillStage(opened, { id: 'bad-neg', kind: 'promote', actor: PROPOSER, expected_revision: -1, to: 'shadow' }),
    SKILL_STAGE_REJECT.invalid_input,
    opened,
  );
  rejected(
    reduceSkillStage(opened, { id: 'bad-actor', kind: 'promote', actor: '', expected_revision: 0, to: 'shadow' }),
    SKILL_STAGE_REJECT.invalid_input,
    opened,
  );
  rejected(
    reduceSkillStage(opened, { id: 'bad-space', kind: 'promote', actor: 'agent grok', expected_revision: 0, to: 'shadow' }),
    SKILL_STAGE_REJECT.invalid_input,
    opened,
  );
  const longId = 'a'.repeat(129);
  rejected(
    reduceSkillStage(opened, { id: longId, kind: 'promote', actor: PROPOSER, expected_revision: 0, to: 'shadow' }),
    SKILL_STAGE_REJECT.invalid_input,
    opened,
  );
});

test('a promote at Number.MAX_SAFE_INTEGER is rejected and leaves the state unchanged', () => {
  const capped = withRevision(Number.MAX_SAFE_INTEGER);
  const result = reduceSkillStage(capped, promote('shadow', Number.MAX_SAFE_INTEGER, 'over-promote', PROPOSER));
  rejected(result, SKILL_STAGE_REJECT.revision_overflow, capped);
  assert.equal(capped.revision, Number.MAX_SAFE_INTEGER);
  assert.equal(Number.isSafeInteger(capped.revision), true);
  assert.equal(capped.stage, 'candidate');
  assert.equal(Number.isSafeInteger(Number.MAX_SAFE_INTEGER + 1), false);
});

test('a promote at Number.MAX_SAFE_INTEGER - 1 advances to Number.MAX_SAFE_INTEGER', () => {
  const near = withRevision(Number.MAX_SAFE_INTEGER - 1);
  const state = applied(reduceSkillStage(near, promote('shadow', near.revision, 'edge-promote', PROPOSER)));
  assert.equal(state.revision, Number.MAX_SAFE_INTEGER);
  assert.equal(Number.isSafeInteger(state.revision), true);
  assert.equal(state.stage, 'shadow');
  assert.equal(state.history.at(-1)?.revision_before, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(state.history.at(-1)?.revision_after, Number.MAX_SAFE_INTEGER);
  assert.equal(near.revision, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(near.stage, 'candidate');
});

test('every ok result has a safe integer revision', () => {
  const results: SkillStageResult[] = [];
  let state = start();
  for (const stage of SKILL_STAGES) {
    if (stage === state.stage) continue;
    const result = reduceSkillStage(state, promote(stage, state.revision, `inv-${state.revision}`));
    results.push(result);
    state = applied(result);
  }
  const earlier = previousSkillStage(state.stage);
  assert.ok(earlier);
  results.push(reduceSkillStage(state, revert(earlier, state.revision, 'inv-back', '1')));
  const near = withRevision(Number.MAX_SAFE_INTEGER - 1);
  results.push(reduceSkillStage(near, promote('shadow', near.revision, 'inv-edge', PROPOSER)));
  const capped = withRevision(Number.MAX_SAFE_INTEGER);
  results.push(reduceSkillStage(capped, promote('shadow', capped.revision, 'inv-cap', PROPOSER)));
  assert.ok(results.some(result => result.ok));
  for (const result of results) {
    if (!result.ok) continue;
    assert.equal(Number.isSafeInteger(result.state.revision), true);
    for (const row of result.state.history) {
      assert.equal(Number.isSafeInteger(row.revision_before), true);
      assert.equal(Number.isSafeInteger(row.revision_after), true);
    }
  }
});

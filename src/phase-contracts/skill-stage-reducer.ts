// P6 skill stage transitions. validateSkillCandidate checks one record; this applies the changes.
// Each event moves exactly one step along SKILL_STAGES. The proposer/promoter rule and version
// shape stay in validateSkillCandidate. rollback_to must name a strictly earlier version.
// Promoted never authorizes merge or deploy. Pure: no I/O, clock, network, or storage.

import {
  Problems, SCHEMA_VERSION, defined, isRecord, readEnum, readId, readInt,
} from './check.ts';
import {
  SKILL_STAGES, validateSkillCandidate, type SkillCandidate, type SkillStage,
} from './skill-candidate.ts';

export const SKILL_STAGE_KINDS = ['promote', 'revert'] as const;
export type SkillStageKind = typeof SKILL_STAGE_KINDS[number];

export const SKILL_STAGE_REJECT = {
  skipped_stage: 'skipped_stage',
  stale_revision: 'stale_revision',
  revision_overflow: 'revision_overflow',
  duplicate_event: 'duplicate_event',
  concurrent_promote_revert: 'concurrent_promote_revert',
  proposer_equals_promoter: 'proposer_equals_promoter',
  rollback_not_earlier: 'rollback_not_earlier',
  invalid_input: 'invalid_input',
} as const;
export type SkillStageRejectCode = typeof SKILL_STAGE_REJECT[keyof typeof SKILL_STAGE_REJECT];

export interface SkillStageEvent {
  id: string;
  kind: SkillStageKind;
  actor: string;
  expected_revision: number;
  to: SkillStage;
  /** Revert only. A version strictly earlier than the record's version. */
  rollback_to?: string;
}

export interface SkillStageApplied {
  event_id: string;
  kind: SkillStageKind;
  actor: string;
  from: SkillStage;
  to: SkillStage;
  revision_before: number;
  revision_after: number;
  rollback_to: string | null;
}

export interface SkillStageRecord {
  skill_id: string;
  proposer_id: string;
  promoter_id: string | null;
  stage: SkillStage;
  version: string;
  rollback_to: string | null;
  revision: number;
  seen_event_ids: readonly string[];
  history: readonly SkillStageApplied[];
  /** A promoted stage is not merge authorization. */
  merge_authorized: false;
  /** A promoted stage is not deploy authorization. */
  deploy_authorized: false;
}

export interface SkillStageAuthorization {
  stage: SkillStage;
  merge_authorized: false;
  deploy_authorized: false;
}

export interface SkillStageOk {
  ok: true;
  state: SkillStageRecord;
}

export interface SkillStageRejected {
  ok: false;
  code: SkillStageRejectCode;
  message: string;
  state: SkillStageRecord;
}

export type SkillStageResult = SkillStageOk | SkillStageRejected;

type NormalizedEvent = {
  id: string;
  actor: string;
  expected_revision: number;
  to: SkillStage;
} & (
  | { kind: 'promote' }
  | { kind: 'revert'; rollback_to: string }
);

const PROBE_ENVELOPE = {
  schema_version: SCHEMA_VERSION,
  consumer: 'P6',
  provenance: {
    kind: 'synthetic_fixture',
    producer_id: 'skill_stage_reducer',
    source_ref: 'skill-stage-reducer',
  },
  proof_mode: 'synthetic',
} as const;

const LADDER = SKILL_STAGES.join(' → ');

function seal(record: Omit<SkillStageRecord, 'merge_authorized' | 'deploy_authorized'>): SkillStageRecord {
  return { ...record, merge_authorized: false, deploy_authorized: false };
}

/** Synthetic probe so the skill-candidate validator, not a second copy of its rule, decides. */
function probe(
  state: Pick<SkillStageRecord, 'skill_id' | 'proposer_id' | 'version'>,
  stage: SkillStage,
  promoter_id: string | null,
  rollback_to: string | null,
) {
  return validateSkillCandidate({
    ...PROBE_ENVELOPE,
    skill_id: state.skill_id,
    stage,
    version: state.version,
    rollback_to,
    proposer_id: state.proposer_id,
    promoter_id,
  });
}

function digits(part: string): boolean {
  if (part.length === 0) return false;
  for (const ch of part) {
    if (ch < '0' || ch > '9') return false;
  }
  return true;
}

function stripZeros(part: string): string {
  let i = 0;
  while (i < part.length - 1 && part[i] === '0') i += 1;
  return part.slice(i);
}

/** Ordering only. validateSkillCandidate owns the version shape. Missing parts pad as 0, so 1 and 1.0.0 tie. */
function isStrictlyEarlier(target: string, current: string): boolean | undefined {
  const left = target.split('.');
  const right = current.split('.');
  if (left.length < 1 || left.length > 3 || right.length < 1 || right.length > 3) return undefined;
  for (let i = 0; i < 3; i += 1) {
    const a = left[i] ?? '0';
    const b = right[i] ?? '0';
    if (!digits(a) || !digits(b)) return undefined;
    const as = stripZeros(a);
    const bs = stripZeros(b);
    if (as.length !== bs.length) return as.length < bs.length;
    if (as < bs) return true;
    if (as > bs) return false;
  }
  return false;
}

export function nextSkillStage(stage: SkillStage): SkillStage | null {
  const index = SKILL_STAGES.indexOf(stage);
  if (index < 0 || index >= SKILL_STAGES.length - 1) return null;
  return SKILL_STAGES[index + 1] ?? null;
}

export function previousSkillStage(stage: SkillStage): SkillStage | null {
  const index = SKILL_STAGES.indexOf(stage);
  if (index <= 0) return null;
  return SKILL_STAGES[index - 1] ?? null;
}

function adjacent(from: SkillStage, to: SkillStage, kind: SkillStageKind): boolean {
  const expected = kind === 'promote' ? nextSkillStage(from) : previousSkillStage(from);
  return expected === to;
}

export function createSkillStage(input: { skill_id: string; proposer_id: string; version: string }): SkillStageRecord {
  const state = seal({
    skill_id: input.skill_id,
    proposer_id: input.proposer_id,
    promoter_id: null,
    stage: 'candidate',
    version: input.version,
    rollback_to: null,
    revision: 0,
    seen_event_ids: [],
    history: [],
  });
  const checked = probe(state, 'candidate', null, null);
  if (!checked.ok) throw new Error(checked.errors.join('; '));
  return state;
}

/** The stage projected as a skill candidate. Synthetic, never a live proof. */
export function skillCandidateView(state: SkillStageRecord) {
  return probe(state, state.stage, state.promoter_id, state.rollback_to);
}

/** Promoted and every earlier stage grant neither merge nor deploy. */
export function skillStageAuthorization(state: SkillStageRecord): SkillStageAuthorization {
  if (state.stage === 'promoted') return { stage: state.stage, merge_authorized: false, deploy_authorized: false };
  return { stage: state.stage, merge_authorized: false, deploy_authorized: false };
}

function reject(state: SkillStageRecord, code: SkillStageRejectCode, message: string): SkillStageRejected {
  return { ok: false, code, message, state };
}

function normalize(input: unknown): { event: NormalizedEvent } | { field: string } {
  if (!isRecord(input)) return { field: 'event' };
  const problems = new Problems();
  const id = readId(problems, input, 'id', 'skill_stage');
  if (!defined(id)) return { field: 'id' };
  const kind = readEnum(problems, input, 'kind', 'skill_stage', SKILL_STAGE_KINDS);
  if (!defined(kind)) return { field: 'kind' };
  const actor = readId(problems, input, 'actor', 'skill_stage');
  if (!defined(actor)) return { field: 'actor' };
  const expected_revision = readInt(problems, input, 'expected_revision', 'skill_stage', 0);
  if (!defined(expected_revision)) return { field: 'expected_revision' };
  const to = readEnum(problems, input, 'to', 'skill_stage', SKILL_STAGES);
  if (!defined(to)) return { field: 'to' };
  if (kind === 'revert') {
    if (typeof input.rollback_to !== 'string') return { field: 'rollback_to' };
    return { event: { id, kind, actor, expected_revision, to, rollback_to: input.rollback_to } };
  }
  return { event: { id, kind, actor, expected_revision, to } };
}

function concurrentPromoteRevert(events: readonly unknown[]): boolean {
  const kinds = new Map<number, { promote: boolean; revert: boolean }>();
  for (const event of events) {
    if (!isRecord(event)) continue;
    const problems = new Problems();
    const kind = readEnum(problems, event, 'kind', 'skill_stage', SKILL_STAGE_KINDS);
    const expected_revision = readInt(problems, event, 'expected_revision', 'skill_stage', 0);
    if (!defined(kind) || !defined(expected_revision)) continue;
    const found = kinds.get(expected_revision) ?? { promote: false, revert: false };
    if (kind === 'promote') found.promote = true;
    else found.revert = true;
    kinds.set(expected_revision, found);
    if (found.promote && found.revert) return true;
  }
  return false;
}

function rollbackFailure(state: SkillStageRecord, rollback_to: string): SkillStageRejected | null {
  const checked = probe(state, state.stage, state.promoter_id, rollback_to);
  if (!checked.ok) {
    if (checked.errors.some(error => error.includes('cannot name the current version'))) {
      return reject(state, SKILL_STAGE_REJECT.rollback_not_earlier, 'rollback_to must name an earlier version');
    }
    const promoter = checked.errors.find(error => error.includes('proposer may never equal promoter'));
    if (promoter) return reject(state, SKILL_STAGE_REJECT.proposer_equals_promoter, promoter);
    return reject(state, SKILL_STAGE_REJECT.invalid_input, checked.errors.join('; '));
  }
  const earlier = isStrictlyEarlier(rollback_to, state.version);
  if (earlier === undefined) return reject(state, SKILL_STAGE_REJECT.invalid_input, 'version ordering is unavailable');
  if (!earlier) return reject(state, SKILL_STAGE_REJECT.rollback_not_earlier, 'rollback_to must name an earlier version');
  return null;
}

function promoterFailure(state: SkillStageRecord, checked: { ok: true; value: SkillCandidate } | { ok: false; errors: string[] }): SkillStageRejected | null {
  if (checked.ok) return null;
  const promoter = checked.errors.find(error => error.includes('proposer may never equal promoter'));
  if (promoter) return reject(state, SKILL_STAGE_REJECT.proposer_equals_promoter, promoter);
  if (checked.errors.some(error => error.includes('cannot name the current version'))) {
    return reject(state, SKILL_STAGE_REJECT.rollback_not_earlier, 'rollback_to must name an earlier version');
  }
  return reject(state, SKILL_STAGE_REJECT.invalid_input, checked.errors.join('; '));
}

function applyOne(state: SkillStageRecord, input: unknown): SkillStageResult {
  const parsed = normalize(input);
  if ('field' in parsed) return reject(state, SKILL_STAGE_REJECT.invalid_input, `Event ${parsed.field} is invalid`);
  const event = parsed.event;
  if (state.seen_event_ids.includes(event.id)) {
    return reject(state, SKILL_STAGE_REJECT.duplicate_event, 'Event id was already applied');
  }
  if (event.expected_revision !== state.revision) {
    return reject(state, SKILL_STAGE_REJECT.stale_revision, 'Event expected_revision does not match the current revision');
  }
  if (!adjacent(state.stage, event.to, event.kind)) {
    return reject(state, SKILL_STAGE_REJECT.skipped_stage, `move exactly one stage along ${LADDER}`);
  }
  const rollback_to = event.kind === 'revert' ? event.rollback_to : state.rollback_to;
  if (event.kind === 'revert') {
    const failed = rollbackFailure(state, event.rollback_to);
    if (failed) return failed;
  }
  const promoter_id = event.to === 'promoted' ? event.actor : null;
  const failed = promoterFailure(state, probe(state, event.to, promoter_id, rollback_to));
  if (failed) return failed;
  // MAX_SAFE_INTEGER + 1 is 2^53: representable, but not a safe integer. Refuse before storing it.
  if (state.revision >= Number.MAX_SAFE_INTEGER) {
    return reject(state, SKILL_STAGE_REJECT.revision_overflow, 'Next revision would exceed the maximum safe integer');
  }
  const revisionAfter = state.revision + 1;
  const applied: SkillStageApplied = {
    event_id: event.id,
    kind: event.kind,
    actor: event.actor,
    from: state.stage,
    to: event.to,
    revision_before: state.revision,
    revision_after: revisionAfter,
    rollback_to: event.kind === 'revert' ? event.rollback_to : null,
  };
  return {
    ok: true,
    state: seal({
      skill_id: state.skill_id,
      proposer_id: state.proposer_id,
      promoter_id,
      stage: event.to,
      version: state.version,
      rollback_to,
      revision: revisionAfter,
      seen_event_ids: [...state.seen_event_ids, event.id],
      history: [...state.history, applied],
    }),
  };
}

/**
 * Apply one event, or a batch in order.
 * Promote and revert that name the same expected_revision are rejected before any event applies.
 * Otherwise the first rejection stops the batch and returns the state from before that event.
 */
export function reduceSkillStage(state: SkillStageRecord, event: SkillStageEvent): SkillStageResult;
export function reduceSkillStage(state: SkillStageRecord, events: readonly SkillStageEvent[]): SkillStageResult;
export function reduceSkillStage(
  state: SkillStageRecord,
  eventOrEvents: SkillStageEvent | readonly SkillStageEvent[],
): SkillStageResult {
  const events: readonly unknown[] = Array.isArray(eventOrEvents) ? eventOrEvents : [eventOrEvents];
  if (concurrentPromoteRevert(events)) {
    return reject(state, SKILL_STAGE_REJECT.concurrent_promote_revert, 'Promote and revert cannot be applied at the same revision');
  }
  let current = state;
  for (const event of events) {
    const result = applyOne(current, event);
    if (!result.ok) return result;
    current = result.state;
  }
  return { ok: true, state: current };
}

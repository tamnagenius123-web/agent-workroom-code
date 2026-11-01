// P6 skill candidate. Stages run candidate → shadow → replay → prospective → independent_review → promoted.
// A proposer may never be the promoter. rollback_to names an earlier version, never the current one.

import {
  Problems, checkKeys, defined, readEnvelope, readEnum, readId, readNullableId, readObject,
  type PhaseCheck, type PhaseEnvelope,
} from './check.ts';

export const SKILL_STAGES = ['candidate', 'shadow', 'replay', 'prospective', 'independent_review', 'promoted'] as const;
export type SkillStage = typeof SKILL_STAGES[number];

const VERSION_RE = /^[0-9]+(?:\.[0-9]+){0,2}$/;

export interface SkillCandidate extends PhaseEnvelope {
  skill_id: string;
  stage: SkillStage;
  version: string;
  rollback_to: string | null;
  proposer_id: string;
  promoter_id: string | null;
}

const KEYS = [
  'schema_version', 'consumer', 'provenance', 'proof_mode',
  'skill_id', 'stage', 'version', 'rollback_to', 'proposer_id', 'promoter_id',
] as const;

function readVersion(problems: Problems, obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (typeof value !== 'string' || !VERSION_RE.test(value)) {
    problems.add(`skill_candidate.${key}`, 'expected a numeric version such as 1 or 1.2.0');
    return undefined;
  }
  return value;
}

export function validateSkillCandidate(input: unknown): PhaseCheck<SkillCandidate> {
  const problems = new Problems();
  const obj = readObject(problems, input, 'skill_candidate');
  if (!obj) return problems.fail();
  checkKeys(problems, obj, KEYS, 'skill_candidate');
  const envelope = readEnvelope(problems, obj, 'skill_candidate');
  const skill_id = readId(problems, obj, 'skill_id', 'skill_candidate');
  const stage = readEnum(problems, obj, 'stage', 'skill_candidate', SKILL_STAGES);
  const version = readVersion(problems, obj, 'version');
  const rollback_to = readNullableVersion(problems, obj);
  const proposer_id = readId(problems, obj, 'proposer_id', 'skill_candidate');
  const promoter_id = readNullableId(problems, obj, 'promoter_id', 'skill_candidate');
  if (defined(proposer_id) && promoter_id !== undefined && promoter_id !== null && proposer_id === promoter_id) {
    problems.add('skill_candidate.promoter_id', 'proposer may never equal promoter');
  }
  if (defined(stage) && promoter_id !== undefined) {
    if (stage === 'promoted' && promoter_id === null) problems.add('skill_candidate.promoter_id', 'required when stage is promoted');
    if (stage !== 'promoted' && promoter_id !== null) problems.add('skill_candidate.promoter_id', 'must be null before promotion');
  }
  if (defined(version) && typeof rollback_to === 'string' && rollback_to === version) {
    problems.add('skill_candidate.rollback_to', 'cannot name the current version');
  }
  if (!defined(envelope) || !defined(skill_id) || !defined(stage) || !defined(version) || rollback_to === undefined || !defined(proposer_id)
    || promoter_id === undefined || problems.bad) {
    return problems.fail();
  }
  return { ok: true, value: { ...envelope, skill_id, stage, version, rollback_to, proposer_id, promoter_id } };
}

function readNullableVersion(problems: Problems, obj: Record<string, unknown>): string | null | undefined {
  if (!('rollback_to' in obj)) {
    problems.add('skill_candidate.rollback_to', 'required');
    return undefined;
  }
  const value = obj.rollback_to;
  if (value === null) return null;
  if (typeof value !== 'string' || !VERSION_RE.test(value)) {
    problems.add('skill_candidate.rollback_to', 'expected a numeric version or null');
    return undefined;
  }
  return value;
}

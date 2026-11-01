// IW-01 status record. Five classification fields stay separate: review support,
// structural grade, corpus level, memory tier, and promotion stage.
// Promotion stage is SkillStage from the skill candidate contract, not a second enum.
// kept, applied and effect are distinct recorded states. A kept experience entry is
// advice (OCG-W6); it does not apply a change and does not record an effect.
// This module never fills applied or effect from kept.

import { Problems, defined, isRecord, readBool, readEnum, readInt } from './check.ts';
import { SKILL_STAGES, type SkillStage } from './skill-candidate.ts';

export const REVIEW_SUPPORTS = ['none', 'pending', 'supported', 'blocked'] as const;
export type ReviewSupport = typeof REVIEW_SUPPORTS[number];

/** S–F structural ladder, including rungs the W5 letter does not compute. Not a review verdict. */
export const STRUCTURAL_GRADES = ['ungraded', 'F', 'D', 'C', 'B', 'A', 'S'] as const;
export type StructuralGrade = typeof STRUCTURAL_GRADES[number];

/** Viking-style corpus representation (L0 abstract → L2 full). Distinct from memory tier. */
export const CORPUS_LEVELS = ['L0', 'L1', 'L2'] as const;
export type CorpusLevel = typeof CORPUS_LEVELS[number];

/** OCG memory item tier (0 episode → 3 skill). Distinct from corpus level. */
export const MEMORY_TIERS = [0, 1, 2, 3] as const;
export type MemoryTier = typeof MEMORY_TIERS[number];

export const CLASSIFICATION_FIELDS = [
  'reviewSupport',
  'structuralGrade',
  'corpusLevel',
  'memoryTier',
  'promotionStage',
] as const;

export const LIFECYCLE_FIELDS = ['kept', 'applied', 'effect'] as const;

/** Names that would collapse separate axes or infer applied/effect from kept. */
export const COLLAPSED_ALIASES = ['status', 'grade', 'level', 'tier', 'stage', 'state'] as const;

export interface Iw01StatusRecord {
  reviewSupport: ReviewSupport;
  structuralGrade: StructuralGrade;
  corpusLevel: CorpusLevel;
  memoryTier: MemoryTier;
  promotionStage: SkillStage;
  kept: boolean;
  applied: boolean;
  effect: boolean;
}

export type Iw01StatusIssueCode =
  | 'not_object'
  | 'collapsed_field'
  | 'missing_field'
  | 'invalid_value'
  | 'unknown_field';

export interface Iw01StatusIssue {
  code: Iw01StatusIssueCode;
  field: string;
  message: string;
}

export type Iw01StatusValidation =
  | { ok: true; record: Iw01StatusRecord }
  | { ok: false; issues: readonly Iw01StatusIssue[] };

const FIELD_ORDER: readonly string[] = [...CLASSIFICATION_FIELDS, ...LIFECYCLE_FIELDS];
const ALLOWED_FIELDS = new Set<string>(FIELD_ORDER);
const COLLAPSED_SET = new Set<string>(COLLAPSED_ALIASES);

function issue(code: Iw01StatusIssueCode, field: string, message: string): Iw01StatusIssue {
  return { code, field, message };
}

function isMemoryTier(value: number): value is MemoryTier {
  return (MEMORY_TIERS as readonly number[]).includes(value);
}

function rank(item: Iw01StatusIssue): number {
  if (item.code === 'not_object') return 0;
  if (item.code === 'collapsed_field') {
    return 1 + COLLAPSED_ALIASES.indexOf(item.field as (typeof COLLAPSED_ALIASES)[number]);
  }
  const idx = FIELD_ORDER.indexOf(item.field);
  if (item.code === 'missing_field' || item.code === 'invalid_value') {
    return 20 + (idx < 0 ? FIELD_ORDER.length : idx);
  }
  return 40;
}

function sortIssues(issues: Iw01StatusIssue[]): Iw01StatusIssue[] {
  return issues.sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    if (left !== right) return left - right;
    if (a.field !== b.field) return a.field < b.field ? -1 : 1;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.message === b.message) return 0;
    return a.message < b.message ? -1 : 1;
  });
}

/**
 * Closed-set and boolean checks go through check.ts. IW-01 still reports
 * missing, invalid, and collapsed names as separate issue codes, which those
 * readers do not distinguish. Out-of-range memory tiers fail here: readInt has no max.
 */
function readChecked<T>(
  rec: Record<string, unknown>,
  field: string,
  issues: Iw01StatusIssue[],
  invalidMessage: string,
  missingMessage: string,
  parse: (problems: Problems) => T | undefined,
): T | undefined {
  if (!Object.hasOwn(rec, field)) {
    issues.push(issue('missing_field', field, missingMessage));
    return undefined;
  }
  const problems = new Problems();
  const value = parse(problems);
  if (value === undefined || problems.bad) {
    issues.push(issue('invalid_value', field, invalidMessage));
    return undefined;
  }
  return value;
}

function readMemoryTier(problems: Problems, rec: Record<string, unknown>): MemoryTier | undefined {
  const value = readInt(problems, rec, 'memoryTier', 'iw01', 0);
  if (value === undefined || !isMemoryTier(value)) return undefined;
  return value;
}

/**
 * Validate an IW-01 status record. Missing applied or effect is a failure.
 * Those states are never copied from kept.
 */
export function validateIw01Status(input: unknown): Iw01StatusValidation {
  if (!isRecord(input)) {
    return { ok: false, issues: [issue('not_object', 'record', 'Status record must be an object.')] };
  }
  const rec = input;
  const issues: Iw01StatusIssue[] = [];

  for (const alias of COLLAPSED_ALIASES) {
    if (Object.hasOwn(rec, alias)) {
      issues.push(issue(
        'collapsed_field',
        alias,
        `${alias} collapses separate IW-01 fields; keep reviewSupport, structuralGrade, corpusLevel, memoryTier, promotionStage, kept, applied and effect as their own fields.`,
      ));
    }
  }

  // Collapsed aliases have their own code. checkKeys would report them as unknown fields.
  for (const key of Object.keys(rec)) {
    if (!ALLOWED_FIELDS.has(key) && !COLLAPSED_SET.has(key)) {
      issues.push(issue('unknown_field', key, `${key} is not an IW-01 status field.`));
    }
  }

  const reviewSupport = readChecked(
    rec, 'reviewSupport', issues,
    'reviewSupport must be one of none, pending, supported, blocked.',
    'reviewSupport is required and is not inferred from other fields.',
    (problems) => readEnum(problems, rec, 'reviewSupport', 'iw01', REVIEW_SUPPORTS),
  );
  const structuralGrade = readChecked(
    rec, 'structuralGrade', issues,
    'structuralGrade must be one of ungraded, F, D, C, B, A, S.',
    'structuralGrade is required and is not inferred from other fields.',
    (problems) => readEnum(problems, rec, 'structuralGrade', 'iw01', STRUCTURAL_GRADES),
  );
  const corpusLevel = readChecked(
    rec, 'corpusLevel', issues,
    'corpusLevel must be L0, L1, or L2.',
    'corpusLevel is required and is not inferred from other fields.',
    (problems) => readEnum(problems, rec, 'corpusLevel', 'iw01', CORPUS_LEVELS),
  );
  const memoryTier = readChecked(
    rec, 'memoryTier', issues,
    'memoryTier must be an integer from 0 to 3.',
    'memoryTier is required and is not inferred from other fields.',
    (problems) => readMemoryTier(problems, rec),
  );
  const promotionStage = readChecked(
    rec, 'promotionStage', issues,
    `promotionStage must be one of ${SKILL_STAGES.join(', ')}.`,
    'promotionStage is required and is not inferred from other fields.',
    (problems) => readEnum(problems, rec, 'promotionStage', 'iw01', SKILL_STAGES),
  );
  const kept = readChecked(
    rec, 'kept', issues,
    'kept must be a boolean.',
    'kept is required and is not inferred from other fields.',
    (problems) => readBool(problems, rec, 'kept', 'iw01'),
  );
  const applied = readChecked(
    rec, 'applied', issues,
    'applied must be a boolean; it cannot be inferred from kept.',
    'applied is required; it cannot be inferred from kept.',
    (problems) => readBool(problems, rec, 'applied', 'iw01'),
  );
  const effect = readChecked(
    rec, 'effect', issues,
    'effect must be a boolean; it cannot be inferred from kept.',
    'effect is required; it cannot be inferred from kept.',
    (problems) => readBool(problems, rec, 'effect', 'iw01'),
  );

  if (!defined(reviewSupport) || !defined(structuralGrade) || !defined(corpusLevel) || !defined(memoryTier)
    || !defined(promotionStage) || !defined(kept) || !defined(applied) || !defined(effect) || issues.length > 0) {
    return { ok: false, issues: sortIssues(issues) };
  }
  return {
    ok: true,
    record: { reviewSupport, structuralGrade, corpusLevel, memoryTier, promotionStage, kept, applied, effect },
  };
}

/** Read the five classification fields. Does not derive one axis from another. */
export function classificationOf(
  record: Iw01StatusRecord,
): Pick<Iw01StatusRecord, (typeof CLASSIFICATION_FIELDS)[number]> {
  return {
    reviewSupport: record.reviewSupport,
    structuralGrade: record.structuralGrade,
    corpusLevel: record.corpusLevel,
    memoryTier: record.memoryTier,
    promotionStage: record.promotionStage,
  };
}

/** Read kept, applied and effect as recorded. Does not set applied or effect from kept. */
export function lifecycleOf(
  record: Iw01StatusRecord,
): Pick<Iw01StatusRecord, (typeof LIFECYCLE_FIELDS)[number]> {
  return { kept: record.kept, applied: record.applied, effect: record.effect };
}

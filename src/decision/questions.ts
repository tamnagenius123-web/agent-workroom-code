// Single registry of decision-layer questions, option wording, and per-action thresholds.
// Question text is fixed per point and is sent together. Choice labels are filled later
// from the eligible set; the instruction stays here.
//
// Wire field for options is `criteria` (OpenRouter Decisions and TypeSafe). A choice
// criteria value is a record of label -> description. A string is not sent (the API
// returns HTTP 400).

import { DecisionInputError } from './errors.ts';

export const DEFAULT_YES_AT = 0.7;
export const DEFAULT_NO_AT = 0.3;

export interface Thresholds {
  yesAt: number;
  noAt: number;
}

export type NoulBand = 'yes' | 'no' | 'unsettled';

export const DECISION_POINTS = [
  't2.rebalance',
  't4.rebalance',
  'sweep.owner_question',
  'verify.independent',
] as const;

export type PointId = typeof DECISION_POINTS[number];

export const QUESTION_IDS = [
  'waiting_on_external_reply',
  'diff_touches_critical_path',
  'fitting_candidate',
  'any_candidate_suitable',
  'owner_question_in_recent_events',
] as const;

export type QuestionId = typeof QUESTION_IDS[number];

/** Fixed question ids, in wire order. Do not send a subset: a different set can shift answers. */
export const POINT_QUESTIONS: { readonly [P in PointId]: readonly QuestionId[] } = {
  't2.rebalance': ['waiting_on_external_reply'],
  't4.rebalance': ['diff_touches_critical_path', 'fitting_candidate', 'any_candidate_suitable'],
  'sweep.owner_question': ['owner_question_in_recent_events'],
  'verify.independent': [],
};

const START: Thresholds = { yesAt: DEFAULT_YES_AT, noAt: DEFAULT_NO_AT };

export interface NoulQuestion {
  id: QuestionId;
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
  thresholds: Thresholds;
}

export interface ChoiceQuestion {
  id: 'fitting_candidate';
  type: 'choice';
  instructions: string;
  companionId: 'any_candidate_suitable';
  thresholds: Thresholds;
}

export type QuestionDef = NoulQuestion | ChoiceQuestion;

export const QUESTIONS: { readonly [K in QuestionId]: QuestionDef } = {
  waiting_on_external_reply: {
    id: 'waiting_on_external_reply',
    type: 'noul',
    instructions: 'Is `task` waiting on a reply from outside the workroom?',
    criteria: {
      true: 'A person or system outside the workroom still owes `task` a reply before work can continue.',
      false: '`task` can continue with no reply owed by anyone outside the workroom.',
    },
    thresholds: { ...START },
  },
  diff_touches_critical_path: {
    id: 'diff_touches_critical_path',
    type: 'noul',
    instructions: 'Does `diff` change a module named in `critical_path_modules`?',
    criteria: {
      true: '`diff` edits a file that `critical_path_modules` names.',
      false: '`diff` leaves every file that `critical_path_modules` names unchanged.',
    },
    thresholds: { ...START },
  },
  fitting_candidate: {
    id: 'fitting_candidate',
    type: 'choice',
    instructions: 'Which candidate in `candidates` fits `task`?',
    companionId: 'any_candidate_suitable',
    thresholds: { ...START },
  },
  any_candidate_suitable: {
    id: 'any_candidate_suitable',
    type: 'noul',
    instructions: 'Does any candidate in `candidates` fit `task`?',
    criteria: {
      true: 'At least one candidate in `candidates` can take `task`.',
      false: 'No candidate in `candidates` can take `task`.',
    },
    thresholds: { ...START },
  },
  owner_question_in_recent_events: {
    id: 'owner_question_in_recent_events',
    type: 'noul',
    instructions: 'Do `recent_events` contain a question that needs the owner to answer?',
    criteria: {
      true: '`recent_events` include a question for the owner that the owner has not answered.',
      false: '`recent_events` leave the owner with no unanswered question.',
    },
    thresholds: { ...START },
  },
};

const LABEL_RE = /^[a-z][a-z0-9_]{0,40}$/;

export interface EligibleOption {
  label: string;
  description: string;
}

export type WireQuestion =
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> };

/** Build the fixed question set for a point. Choice criteria are the eligible labels only. */
export function wireQuestions(point: PointId, eligible: readonly EligibleOption[]): Record<string, WireQuestion> {
  const out: Record<string, WireQuestion> = {};
  for (const id of POINT_QUESTIONS[point]) {
    const def = QUESTIONS[id];
    if (def.type === 'noul') {
      out[id] = {
        type: 'noul',
        instructions: def.instructions,
        criteria: { true: def.criteria.true, false: def.criteria.false },
      };
      continue;
    }
    const criteria: Record<string, string> = {};
    for (const option of eligible) {
      if (!LABEL_RE.test(option.label)) {
        throw new DecisionInputError('candidate', `option label ${option.label} is not a named token`);
      }
      if (option.label in criteria) throw new DecisionInputError('candidate', `duplicate option label ${option.label}`);
      if (option.description.trim().length === 0) {
        throw new DecisionInputError('candidate', `option ${option.label} needs a description`);
      }
      criteria[option.label] = option.description;
    }
    if (Object.keys(criteria).length === 0) {
      throw new DecisionInputError('candidate', 'choice has no eligible options');
    }
    out[id] = { type: 'choice', instructions: def.instructions, criteria };
  }
  return out;
}

export function thresholdsFor(
  id: QuestionId,
  override?: Partial<Record<QuestionId, Thresholds>>,
): Thresholds {
  const base = QUESTIONS[id].thresholds;
  const next = override?.[id] ?? base;
  if (!Number.isFinite(next.yesAt) || !Number.isFinite(next.noAt)) {
    throw new DecisionInputError('threshold', `thresholds for ${id} must be finite`);
  }
  if (next.yesAt > 1 || next.noAt < 0 || !(next.yesAt > next.noAt)) {
    throw new DecisionInputError('threshold', `thresholds for ${id} must satisfy 0 <= no < yes <= 1`);
  }
  return { yesAt: next.yesAt, noAt: next.noAt };
}

/** yes >= yesAt, no <= noAt, and the open band between them is unsettled. */
export function bandOf(probability: number, thresholds: Thresholds): NoulBand {
  if (probability >= thresholds.yesAt) return 'yes';
  if (probability <= thresholds.noAt) return 'no';
  return 'unsettled';
}

export function sameQuestionList(given: readonly QuestionId[], expected: readonly QuestionId[]): boolean {
  if (given.length !== expected.length) return false;
  return expected.every((id, index) => given[index] === id);
}

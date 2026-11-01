// P4 dispatch request and budget hold. Amounts are integer micro-USD.
// The four ids are distinct. Unknown subscription usage is the string UNKNOWN, never 0.
// Admission requires source_status FRESH and intent_status VALID (see requireFreshForDispatch).
// A FRESH source with a changed permission cannot dispatch. Freshness does not grant authority.

import {
  Problems, checkKeys, defined, distinctIds, readEnvelope, readEnum, readId, readInt, readNullableInt, readNullableText,
  readObject, readText, type PhaseCheck, type PhaseEnvelope,
} from './check.ts';
import { requireFreshForDispatch, type FreshnessCheck } from './freshness.ts';

export const SPEND_CATEGORIES = ['subscription', 'openrouter', 'claude_api_credit'] as const;
export type SpendCategory = typeof SPEND_CATEGORIES[number];

export const HOLD_STATES = ['held', 'settled', 'released_with_evidence', 'escalated'] as const;
export type HoldState = typeof HOLD_STATES[number];

export interface BudgetHold {
  run_id: string;
  attempt_id: string;
  hold_id: string;
  call_id: string;
  amount_micros: number;
  category: SpendCategory;
  state: HoldState;
  evidence_ref: string | null;
}

export interface UnitCostRecord extends PhaseEnvelope {
  unit_id: string;
  tool: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  usd_micros: number | null;
  subscription_usage: 'UNKNOWN' | number;
}

export interface DispatchRequest extends PhaseEnvelope {
  run_id: string;
  attempt_id: string;
  hold_id: string;
  call_id: string;
  hold: BudgetHold;
  unit_cost: UnitCostRecord;
}

const REQUEST_KEYS = [
  'schema_version', 'consumer', 'provenance', 'proof_mode',
  'run_id', 'attempt_id', 'hold_id', 'call_id', 'hold', 'unit_cost',
] as const;
const HOLD_KEYS = ['run_id', 'attempt_id', 'hold_id', 'call_id', 'amount_micros', 'category', 'state', 'evidence_ref'] as const;
const COST_KEYS = [
  'schema_version', 'consumer', 'provenance', 'proof_mode',
  'unit_id', 'tool', 'model', 'tokens_in', 'tokens_out', 'usd_micros', 'subscription_usage',
] as const;

export function validateBudgetHold(input: unknown): PhaseCheck<BudgetHold> {
  const problems = new Problems();
  const obj = readObject(problems, input, 'budget_hold');
  if (!obj) return problems.fail();
  checkKeys(problems, obj, HOLD_KEYS, 'budget_hold');
  const run_id = readId(problems, obj, 'run_id', 'budget_hold');
  const attempt_id = readId(problems, obj, 'attempt_id', 'budget_hold');
  const hold_id = readId(problems, obj, 'hold_id', 'budget_hold');
  const call_id = readId(problems, obj, 'call_id', 'budget_hold');
  const amount_micros = readInt(problems, obj, 'amount_micros', 'budget_hold', 0);
  const category = readEnum(problems, obj, 'category', 'budget_hold', SPEND_CATEGORIES);
  const state = readEnum(problems, obj, 'state', 'budget_hold', HOLD_STATES);
  const evidence_ref = readNullableText(problems, obj, 'evidence_ref', 'budget_hold', 500);
  distinctIds(problems, [
    ['run_id', run_id], ['attempt_id', attempt_id], ['hold_id', hold_id], ['call_id', call_id],
  ], 'budget_hold');
  if (defined(state) && evidence_ref !== undefined) {
    if (state === 'released_with_evidence' && evidence_ref === null) {
      problems.add('budget_hold.evidence_ref', 'released_with_evidence requires evidence_ref');
    }
    if (state !== 'released_with_evidence' && evidence_ref !== null) {
      problems.add('budget_hold.evidence_ref', 'evidence_ref is only set when state is released_with_evidence');
    }
  }
  if (!defined(run_id) || !defined(attempt_id) || !defined(hold_id) || !defined(call_id) || !defined(amount_micros)
    || !defined(category) || !defined(state) || evidence_ref === undefined || problems.bad) {
    return problems.fail();
  }
  return { ok: true, value: { run_id, attempt_id, hold_id, call_id, amount_micros, category, state, evidence_ref } };
}

export function validateUnitCostRecord(input: unknown): PhaseCheck<UnitCostRecord> {
  const problems = new Problems();
  const obj = readObject(problems, input, 'unit_cost');
  if (!obj) return problems.fail();
  checkKeys(problems, obj, COST_KEYS, 'unit_cost');
  const envelope = readEnvelope(problems, obj, 'unit_cost');
  const unit_id = readId(problems, obj, 'unit_id', 'unit_cost');
  const tool = readText(problems, obj, 'tool', 'unit_cost', 128);
  const model = readText(problems, obj, 'model', 'unit_cost', 128);
  const tokens_in = readInt(problems, obj, 'tokens_in', 'unit_cost', 0);
  const tokens_out = readInt(problems, obj, 'tokens_out', 'unit_cost', 0);
  const usd_micros = readNullableInt(problems, obj, 'usd_micros', 'unit_cost', 0);
  const usageRaw = obj.subscription_usage;
  let subscription_usage: 'UNKNOWN' | number | undefined;
  if (usageRaw === 'UNKNOWN') subscription_usage = 'UNKNOWN';
  else if (typeof usageRaw === 'number' && Number.isSafeInteger(usageRaw) && usageRaw > 0) subscription_usage = usageRaw;
  else if (usageRaw === 0) problems.add('unit_cost.subscription_usage', 'unknown subscription usage is UNKNOWN, never 0');
  else problems.add('unit_cost.subscription_usage', 'expected UNKNOWN or an integer > 0');
  if (!defined(envelope) || !defined(unit_id) || !defined(tool) || !defined(model) || !defined(tokens_in) || !defined(tokens_out)
    || usd_micros === undefined || !defined(subscription_usage) || problems.bad) {
    return problems.fail();
  }
  return { ok: true, value: { ...envelope, unit_id, tool, model, tokens_in, tokens_out, usd_micros, subscription_usage } };
}

function same(problems: Problems, label: string, left: string | undefined, right: string | undefined): void {
  if (defined(left) && defined(right) && left !== right) problems.add(`dispatch.${label}`, 'does not match hold');
}

export function validateDispatchRequest(input: unknown): PhaseCheck<DispatchRequest> {
  const problems = new Problems();
  const obj = readObject(problems, input, 'dispatch');
  if (!obj) return problems.fail();
  checkKeys(problems, obj, REQUEST_KEYS, 'dispatch');
  const envelope = readEnvelope(problems, obj, 'dispatch');
  const run_id = readId(problems, obj, 'run_id', 'dispatch');
  const attempt_id = readId(problems, obj, 'attempt_id', 'dispatch');
  const hold_id = readId(problems, obj, 'hold_id', 'dispatch');
  const call_id = readId(problems, obj, 'call_id', 'dispatch');
  distinctIds(problems, [
    ['run_id', run_id], ['attempt_id', attempt_id], ['hold_id', hold_id], ['call_id', call_id],
  ], 'dispatch');
  const holdParsed = validateBudgetHold(obj.hold);
  const costParsed = validateUnitCostRecord(obj.unit_cost);
  if (!holdParsed.ok) for (const error of holdParsed.errors) problems.add('dispatch.hold', error);
  if (!costParsed.ok) for (const error of costParsed.errors) problems.add('dispatch.unit_cost', error);
  if (holdParsed.ok) {
    same(problems, 'run_id', run_id, holdParsed.value.run_id);
    same(problems, 'attempt_id', attempt_id, holdParsed.value.attempt_id);
    same(problems, 'hold_id', hold_id, holdParsed.value.hold_id);
    same(problems, 'call_id', call_id, holdParsed.value.call_id);
  }
  if (!defined(envelope) || !defined(run_id) || !defined(attempt_id) || !defined(hold_id) || !defined(call_id)
    || !holdParsed.ok || !costParsed.ok || problems.bad) {
    return problems.fail();
  }
  return {
    ok: true,
    value: { ...envelope, run_id, attempt_id, hold_id, call_id, hold: holdParsed.value, unit_cost: costParsed.value },
  };
}

/** Structural dispatch request plus a freshness gate. Refuses unless the check result is FRESH. */
export function validateDispatchAdmission(
  request: unknown, freshness: unknown,
): PhaseCheck<{ request: DispatchRequest; freshness: FreshnessCheck }> {
  const parsedRequest = validateDispatchRequest(request);
  const parsedFreshness = requireFreshForDispatch(freshness);
  const errors = [
    ...(parsedRequest.ok ? [] : parsedRequest.errors),
    ...(parsedFreshness.ok ? [] : parsedFreshness.errors),
  ];
  if (!parsedRequest.ok || !parsedFreshness.ok) return { ok: false, errors };
  return { ok: true, value: { request: parsedRequest.value, freshness: parsedFreshness.value } };
}

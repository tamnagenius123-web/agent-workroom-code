// The selected decision model judges. This module decides.
// Size routing happens before the call: d1.2-ultra, else Jev 1.14, else no decision model.
// A failed call goes to the general chat model, then a conservative rule.
// It does not retry on the other decision model. The unsettled band is its own row.
// Shadow is the default. Live application stays behind DECISION_LIVE_ENABLED.
// Probabilistic output is never an independent verification PASS.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  chatOnce,
  estimateMicroUsd,
  getGenerationCost,
  OpenRouterError,
  reservationMicroUsd,
  roundUsdToMicro,
} from './llm-fallback.ts';
import type { ReserveInput, ReserveResult, SettleInput } from '../or-harness/ledger.ts';
import {
  DECISION_LEDGER_PROJECT,
  JEV_RESERVE_MICRO_USD,
  LLM_FALLBACK_MODEL,
  inputReserveMicro,
  resolveDecisionConfig,
  type DecisionConfig,
  type DecisionConfigOverride,
} from './config.ts';
import { DecisionInputError } from './errors.ts';
import { runHardFilters, tighten, type FilterCandidate, type HardFilterInput, type HardFilterResult } from './hard-filter.ts';
import {
  DECIDER_SHADOW_MODEL,
  JevClientError,
  postDeciderShadow,
  postDecision,
  buildDecisionsRequest,
  type DecisionAnswer,
  type DecisionQuestion,
  type FetchLike,
} from './jev-client.ts';
import { estimateDecisionTokens, routeBySize, type RoutingReason } from './route.ts';
import {
  POINT_QUESTIONS,
  bandOf,
  sameQuestionList,
  thresholdsFor,
  wireQuestions,
  type NoulBand,
  type PointId,
  type QuestionId,
  type Thresholds,
  type WireQuestion,
} from './questions.ts';
import { canonicalJson, shouldSkipSweep, stateHash, sweepKey, type SweepMemory } from './sweep.ts';
import {
  type JudgmentRow,
  type JudgmentStore,
  type ProviderPath,
  type Verdict,
} from './store.ts';

export type { ProviderPath, Verdict };
export type { NoulBand, PointId, QuestionId, Thresholds };

const LLM_MAX_TOKENS = 512;
const FALLTHROUGH = new Set<JevClientError['errorClass']>([
  'timeout',
  'transport',
  'http_status',
  'bad_response',
  'forbidden_model',
]);

type ChoiceGate = NoulBand | 'ineligible';

interface TruthRow {
  critical: NoulBand | '*';
  suitable: NoulBand | '*';
  choice: ChoiceGate | '*';
  verdict: Verdict;
}

/** Explicit T4 rows. The first match wins, so the unsettled and critical-path rows stay ahead of act. */
export const T4_ROWS: readonly TruthRow[] = [
  { critical: 'unsettled', suitable: '*', choice: '*', verdict: 'unsettled' },
  { critical: 'yes', suitable: '*', choice: '*', verdict: 'reject' },
  { critical: 'no', suitable: 'unsettled', choice: '*', verdict: 'unsettled' },
  { critical: 'no', suitable: 'no', choice: '*', verdict: 'reject' },
  { critical: 'no', suitable: 'yes', choice: 'ineligible', verdict: 'reject' },
  { critical: 'no', suitable: 'yes', choice: 'unsettled', verdict: 'unsettled' },
  { critical: 'no', suitable: 'yes', choice: 'no', verdict: 'reject' },
  { critical: 'no', suitable: 'yes', choice: 'yes', verdict: 'act' },
];

export function matchT4(critical: NoulBand, suitable: NoulBand, choice: ChoiceGate): Verdict {
  for (const row of T4_ROWS) {
    if (row.critical !== '*' && row.critical !== critical) continue;
    if (row.suitable !== '*' && row.suitable !== suitable) continue;
    if (row.choice !== '*' && row.choice !== choice) continue;
    return row.verdict;
  }
  return 'unsettled';
}

/** Waiting on an outside reply blocks rebalance. A clear no does not. The middle band stays unsettled. */
export function mapT2(waiting: NoulBand): Verdict {
  if (waiting === 'yes') return 'reject';
  if (waiting === 'no') return 'act';
  return 'unsettled';
}

/** A clear owner question is `act` for the record. Shadow does not ask the owner. */
export function mapSweep(ownerQuestion: NoulBand): Verdict {
  if (ownerQuestion === 'yes') return 'act';
  if (ownerQuestion === 'no') return 'reject';
  return 'unsettled';
}

/** A probability is not a verification PASS. This row does not read a model answer. */
export function mapVerification(): 'reject' {
  return 'reject';
}

export interface DecisionLedger {
  reserve(input: ReserveInput): Promise<ReserveResult> | ReserveResult;
  markPending(reservation_id: string, reason: string, extra?: {
    generation_id?: string;
    provider_account?: string | null;
    model?: string;
  }): Promise<void> | void;
  settle(reservation_id: string, actual: SettleInput): Promise<void> | void;
  closeNoCharge(reservation_id: string, evidence: string): Promise<'closed_no_charge'> | 'closed_no_charge';
}

export interface DecideInput {
  point: PointId;
  unit_id: string;
  state: unknown;
  questions?: readonly QuestionId[];
  candidates: readonly FilterCandidate[];
  hard_filter_result?: HardFilterResult;
  mode?: 'shadow' | 'live';
  filter?: Omit<HardFilterInput, 'unitId' | 'candidates'>;
  thresholds?: Partial<Record<QuestionId, Thresholds>>;
  apiKey?: string;
  fetchImpl?: FetchLike;
  ledger?: DecisionLedger;
  store?: JudgmentStore;
  sweeps?: SweepMemory;
  timeoutMs?: number;
  now?: () => number;
  project?: string;
  source_watermark?: string | null;
  /** When true, and mode is shadow, record a decider v1.2 comparison. Never a verdict. */
  shadowDecider?: boolean;
  /** When true, and mode is shadow, and d1 was selected, record a Jev comparison. Never a verdict. */
  shadowJev?: boolean;
  recordId?: string;
  /** Merged over the registry in config.ts. `live` defaults off. */
  config?: DecisionConfigOverride;
  logger?: (payload: string) => void;
}

export interface DecideResult {
  verdict: Verdict;
  answer: Record<string, DecisionAnswer> | null;
  probs: Record<string, number> | null;
  provider_path: ProviderPath;
  record_id: string;
  applied: boolean;
  rule_baseline: 'hold' | 'unchanged_state';
  agreed: boolean;
  routing_reason: RoutingReason | null;
}

export interface FlowView<T> {
  value: T;
  applied: boolean;
}

/** The recorded verdict is not written onto the current flow. */
export function applyOutcome<T>(current: T, result: DecideResult): FlowView<T> {
  return { value: current, applied: result.applied };
}

export async function decide(input: DecideInput): Promise<DecideResult> {
  const mode = input.mode ?? 'shadow';
  const config = resolveDecisionConfig(input.config);
  const point = input.point;
  const expected = POINT_QUESTIONS[point];
  const questions = input.questions ?? expected;
  if (!sameQuestionList(questions, expected)) {
    throw new DecisionInputError('question_set', `${point} keeps a fixed question set`);
  }
  for (const id of expected) thresholdsFor(id, input.thresholds);
  const needsChoice = expected.includes('fitting_candidate');
  const computed = runHardFilters({
    unitId: input.unit_id,
    candidates: input.candidates,
    ...input.filter,
  });
  const filter = tighten(computed, input.hard_filter_result, needsChoice);
  const now = input.now ?? Date.now;
  const started = now();
  const recordId = input.recordId ?? `jdg_${randomUUID()}`;
  const hash = stateHash(input.state);
  const project = input.project ?? DECISION_LEDGER_PROJECT;

  const ctx: FinishCtx = {
    input, mode, config, point, filter, now, started, recordId, hash, project,
    charged: 0,
    chargedAny: false,
    routingReason: null,
  };

  if (point === 'verify.independent') {
    return finish(ctx, { verdict: mapVerification(), path: 'rule', answer: null, probs: null, model: null, payload: null, genId: null, baseline: 'hold', shadow: null, remember: false });
  }
  if (filter.blocked) {
    return finish(ctx, { verdict: 'reject', path: 'rule', answer: null, probs: null, model: null, payload: null, genId: null, baseline: 'hold', shadow: null, remember: false });
  }
  if (point === 'sweep.owner_question' && input.sweeps) {
    const previous = await input.sweeps.get(sweepKey(input.unit_id, point));
    if (shouldSkipSweep(previous ?? null, hash)) {
      return finish(ctx, {
        verdict: 'fallback_rule',
        path: 'rule',
        answer: null,
        probs: null,
        model: null,
        payload: null,
        genId: null,
        baseline: 'unchanged_state',
        shadow: null,
        remember: false,
      });
    }
  }

  const wire = wireQuestions(point, filter.eligible.map(row => ({ label: row.label, description: row.description })));
  if (Object.keys(wire).length === 0) {
    return finish(ctx, { verdict: 'reject', path: 'rule', answer: null, probs: null, model: null, payload: null, genId: null, baseline: 'hold', shadow: null, remember: false });
  }

  const asked = asQuestions(wire);
  const tokens = estimateDecisionTokens(input.state, asked);
  const routed = routeBySize(tokens, config);
  ctx.routingReason = routed.reason;
  const trace = { trace_id: recordId, trace_name: `agent-workroom.${point}` };

  if (!input.fetchImpl || !input.ledger || !cleanKey(input.apiKey)) {
    return finish(ctx, { verdict: 'fallback_rule', path: 'rule', answer: null, probs: null, model: null, payload: null, genId: null, baseline: 'hold', shadow: null, remember: false });
  }
  const fetchImpl = input.fetchImpl;
  const ledger = input.ledger;
  const apiKey = input.apiKey ?? '';

  if (routed.route === 'none') {
    return llmOrRule(ctx, wire, fetchImpl, ledger, apiKey, null);
  }

  const spec = routed.route === 'd1' ? config.primary : config.largeContext;
  const path: ProviderPath = routed.route;
  let decisionPayload: string | null = null;
  try {
    decisionPayload = buildDecisionsRequest({
      model: spec.requestModel,
      state: input.state,
      questions: asked,
      session_id: input.unit_id,
      trace,
      providerOnly: spec.providerOnly,
    }).payload;
  } catch (error) {
    if (error instanceof JevClientError && error.errorClass === 'bad_request') throw error;
    return finish(ctx, { verdict: 'fallback_rule', path: 'rule', answer: null, probs: null, model: null, payload: null, genId: null, baseline: 'hold', shadow: null, remember: false });
  }

  const reserveMicro = spec.usdPerMillionInput !== undefined
    ? inputReserveMicro(tokens, spec.usdPerMillionInput)
    : JEV_RESERVE_MICRO_USD;
  const held = await reserve(ledger, {
    project,
    run_id: `decision-${recordId}`,
    attempt_id: `${recordId}-${routed.route}`,
    model: spec.requestModel,
    est_micro_usd: reserveMicro,
    pricing_snapshot: {
      model: spec.requestModel,
      source: spec.usdPerMillionInput !== undefined ? 'decision-layer-published-input-price' : 'decision-layer-provisional',
      estimate_micro_usd: reserveMicro,
      reserved_micro_usd: reserveMicro,
    },
  });
  if (!held.ok) {
    return finish(ctx, { verdict: 'reject', path: 'rule', answer: null, probs: null, model: null, payload: null, genId: null, baseline: 'hold', shadow: null, remember: false });
  }

  try {
    const posted = await postDecision({
      model: spec.requestModel,
      servedPrefix: spec.servedPrefix,
      requireSuffix: spec.requireSuffix,
      providerOnly: spec.providerOnly,
      expectProvider: spec.providerOnly?.includes('TypeSafe') ? 'TypeSafe' : undefined,
      state: input.state,
      questions: asked,
      session_id: input.unit_id,
      trace,
      apiKey,
      fetchImpl,
      timeoutMs: input.timeoutMs,
      logger: input.logger,
    });
    const micro = costMicro(posted.response.usage.cost);
    await ledger.settle(held.id, settleFrom(
      posted.response.id,
      micro,
      posted.response.provider,
      posted.response.model,
      posted.response.usage.input_tokens ?? 0,
      posted.response.usage.output_tokens ?? 0,
    ));
    ctx.charged += micro;
    ctx.chargedAny = true;
    const answer = posted.response.answers;
    const verdict = mapAnswers(point, answer, filter.eligible, input.thresholds);
    const shadow = await maybeShadow(input, mode, routed.route, wire, apiKey, fetchImpl, ledger, project, recordId, ctx);
    return finish(ctx, {
      verdict,
      path,
      answer,
      probs: gatingProbs(answer),
      model: posted.response.model,
      payload: posted.payload,
      genId: posted.response.id,
      baseline: 'hold',
      shadow,
      remember: point === 'sweep.owner_question',
    });
  } catch (error) {
    const failure = error instanceof JevClientError
      ? error
      : new JevClientError('transport', 'decisions transport');
    if (failure.errorClass === 'bad_request') throw failure;
    await releaseHold(ledger, held.id, failure);
    if (failure.generationId && failure.costUsd !== null && failure.errorClass === 'forbidden_model') {
      const micro = safeMicro(failure.costUsd);
      if (micro !== null) {
        await ledger.settle(held.id, settleFrom(
          failure.generationId,
          micro,
          failure.servedProvider ?? 'unknown',
          failure.servedModel ?? spec.requestModel,
          failure.promptTokens ?? 0,
          failure.completionTokens ?? 0,
        ));
        ctx.charged += micro;
        ctx.chargedAny = true;
      } else {
        await ledger.markPending(held.id, `decision:${failure.errorClass}`, {
          generation_id: failure.generationId,
          model: failure.servedModel ?? undefined,
          provider_account: failure.servedProvider,
        });
      }
    }
    if (!FALLTHROUGH.has(failure.errorClass)) {
      return finish(ctx, { verdict: 'fallback_rule', path: 'rule', answer: null, probs: null, model: null, payload: decisionPayload, genId: null, baseline: 'hold', shadow: null, remember: false });
    }
    return llmOrRule(ctx, wire, fetchImpl, ledger, apiKey, decisionPayload);
  }
}

interface FinishCtx {
  input: DecideInput;
  mode: 'shadow' | 'live';
  config: DecisionConfig;
  point: PointId;
  filter: HardFilterResult;
  now: () => number;
  started: number;
  recordId: string;
  hash: string;
  project: string;
  charged: number;
  chargedAny: boolean;
  routingReason: RoutingReason | null;
}async function llmOrRule(
  ctx: FinishCtx,
  wire: Record<string, WireQuestion>,
  fetchImpl: FetchLike,
  ledger: DecisionLedger,
  apiKey: string,
  jevPayload: string | null,
): Promise<DecideResult> {
  const prompt = llmPrompt(ctx.input.state, wire);
  const payload = JSON.stringify({
    model: LLM_FALLBACK_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: LLM_MAX_TOKENS,
  });
  let estimate: number;
  let reserveMicro: number;
  try {
    estimate = estimateMicroUsd(LLM_FALLBACK_MODEL, prompt.length, LLM_MAX_TOKENS);
    reserveMicro = reservationMicroUsd(estimate);
  } catch {
    return finish(ctx, { verdict: 'fallback_rule', path: 'rule', answer: null, probs: null, model: null, payload: jevPayload, genId: null, baseline: 'hold', shadow: null, remember: false });
  }
  const held = await reserve(ledger, {
    project: ctx.project,
    run_id: `decision-${ctx.recordId}`,
    attempt_id: `${ctx.recordId}-llm`,
    model: LLM_FALLBACK_MODEL,
    est_micro_usd: reserveMicro,
    pricing_snapshot: {
      model: LLM_FALLBACK_MODEL,
      source: 'decision-layer-llm',
      prompt_chars: prompt.length,
      max_tokens: LLM_MAX_TOKENS,
      estimate_micro_usd: estimate,
      reserved_micro_usd: reserveMicro,
    },
  });
  if (!held.ok) {
    return finish(ctx, { verdict: 'reject', path: 'rule', answer: null, probs: null, model: null, payload: jevPayload, genId: null, baseline: 'hold', shadow: null, remember: false });
  }
  let chat: { generation_id: string; text: string };
  try {
    chat = await chatOnce({
      model: LLM_FALLBACK_MODEL,
      prompt,
      maxTokens: LLM_MAX_TOKENS,
      timeoutMs: ctx.input.timeoutMs ?? 30_000,
      fetchImpl,
      apiKey,
    });
  } catch (error) {
    const status = error instanceof OpenRouterError ? error.status : null;
    if (status !== null && status >= 400 && status < 500) await ledger.closeNoCharge(held.id, `llm:http_${status}`);
    else await ledger.markPending(held.id, 'llm_error');
    return finish(ctx, { verdict: 'fallback_rule', path: 'rule', answer: null, probs: null, model: null, payload, genId: null, baseline: 'hold', shadow: null, remember: false });
  }
  const parsed = parseLlm(chat.text, wire);
  const cost = await getGenerationCost(chat.generation_id, {
    fetchImpl,
    apiKey,
    retries: 1,
    delayMs: 0,
    timeoutMs: ctx.input.timeoutMs ?? 30_000,
  }).catch(() => null);
  if (cost) {
    await ledger.settle(held.id, {
      generation_id: chat.generation_id,
      micro_usd: cost.micro_usd,
      cost_field: cost.cost_field,
      provider_account: cost.provider_name,
      model: cost.model ?? LLM_FALLBACK_MODEL,
      tokens: cost.tokens,
    });
    ctx.charged += cost.micro_usd;
    ctx.chargedAny = true;
  } else {
    await ledger.markPending(held.id, 'cost_unknown', { generation_id: chat.generation_id, model: LLM_FALLBACK_MODEL });
  }
  if (!parsed) {
    return finish(ctx, {
      verdict: 'unsettled',
      path: 'llm',
      answer: null,
      probs: null,
      model: LLM_FALLBACK_MODEL,
      payload,
      genId: chat.generation_id,
      baseline: 'hold',
      shadow: null,
      remember: false,
    });
  }
  const verdict = mapAnswers(ctx.point, parsed, ctx.filter.eligible, ctx.input.thresholds);
  return finish(ctx, {
    verdict,
    path: 'llm',
    answer: parsed,
    probs: gatingProbs(parsed),
    model: LLM_FALLBACK_MODEL,
    payload,
    genId: chat.generation_id,
    baseline: 'hold',
    shadow: null,
    remember: ctx.point === 'sweep.owner_question',
  });
}
async function maybeShadow(
  input: DecideInput,
  mode: 'shadow' | 'live',
  selected: 'd1' | 'jev',
  wire: Record<string, WireQuestion>,
  apiKey: string,
  fetchImpl: FetchLike,
  ledger: DecisionLedger,
  project: string,
  recordId: string,
  ctx: FinishCtx,
): Promise<unknown> {
  if (mode !== 'shadow') return null;
  const decider = input.shadowDecider
    ? await shadowCall(ledger, project, recordId, ctx, {
      attempt: 'decider',
      model: DECIDER_SHADOW_MODEL,
      reserveMicro: JEV_RESERVE_MICRO_USD,
      source: 'decision-layer-shadow-decider',
      run: () => postDeciderShadow({
        state: input.state,
        questions: asQuestions(wire),
        session_id: input.unit_id,
        trace: { trace_id: recordId, trace_name: `agent-workroom.${input.point}.shadow-decider` },
        apiKey,
        fetchImpl,
        timeoutMs: input.timeoutMs,
        logger: input.logger,
      }),
    })
    : null;
  const jev = input.shadowJev && selected === 'd1'
    ? await shadowCall(ledger, project, recordId, ctx, {
      attempt: 'shadow-jev',
      model: ctx.config.largeContext.requestModel,
      reserveMicro: JEV_RESERVE_MICRO_USD,
      source: 'decision-layer-shadow-jev',
      run: () => postDecision({
        model: ctx.config.largeContext.requestModel,
        servedPrefix: ctx.config.largeContext.servedPrefix,
        requireSuffix: ctx.config.largeContext.requireSuffix,
        providerOnly: ctx.config.largeContext.providerOnly,
        expectProvider: 'TypeSafe',
        state: input.state,
        questions: asQuestions(wire),
        session_id: input.unit_id,
        trace: { trace_id: recordId, trace_name: `agent-workroom.${input.point}.shadow-jev` },
        apiKey,
        fetchImpl,
        timeoutMs: input.timeoutMs,
        logger: input.logger,
      }),
    })
    : null;
  if (!decider && !jev) return null;
  if (decider && !jev) return decider;
  return { decider, jev };
}

async function shadowCall(
  ledger: DecisionLedger,
  project: string,
  recordId: string,
  ctx: FinishCtx,
  spec: {
    attempt: string;
    model: string;
    reserveMicro: number;
    source: string;
    run: () => Promise<{ response: { id: string; model: string; provider: string; usage: { cost: number; input_tokens?: number; output_tokens?: number } }; payload: string }>;
  },
): Promise<unknown> {
  let reservationId: string | null = null;
  try {
    const held = await reserve(ledger, {
      project,
      run_id: `decision-${recordId}`,
      attempt_id: `${recordId}-${spec.attempt}`,
      model: spec.model,
      est_micro_usd: spec.reserveMicro,
      pricing_snapshot: {
        model: spec.model,
        source: spec.source,
        estimate_micro_usd: spec.reserveMicro,
        reserved_micro_usd: spec.reserveMicro,
      },
    });
    if (!held.ok) return { model: spec.model, skipped: 'over_budget' };
    reservationId = held.id;
    const posted = await spec.run();
    const micro = safeMicro(posted.response.usage.cost);
    if (micro !== null) {
      await ledger.settle(held.id, settleFrom(
        posted.response.id,
        micro,
        posted.response.provider,
        posted.response.model,
        posted.response.usage.input_tokens ?? 0,
        posted.response.usage.output_tokens ?? 0,
      ));
      ctx.charged += micro;
      ctx.chargedAny = true;
    } else {
      await ledger.markPending(held.id, 'shadow_cost', { generation_id: posted.response.id, model: posted.response.model });
    }
    return { model: spec.model, payload: posted.payload, response: posted.response };
  } catch (error) {
    const klass = error instanceof JevClientError ? error.errorClass : 'transport';
    const status = error instanceof JevClientError ? error.status : null;
    const apiCode = error instanceof JevClientError ? error.apiCode : null;
    if (reservationId) {
      if (status !== null && status >= 400 && status < 500) await ledger.closeNoCharge(reservationId, `shadow:${klass}`);
      else await ledger.markPending(reservationId, 'shadow_error');
    }
    return { model: spec.model, errorClass: klass, status, apiCode };
  }
}

interface FinishPatch {
  verdict: Verdict;
  path: ProviderPath;
  answer: Record<string, DecisionAnswer> | null;
  probs: Record<string, number> | null;
  model: string | null;
  payload: string | null;
  genId: string | null;
  baseline: 'hold' | 'unchanged_state';
  shadow: unknown;
  remember: boolean;
}

async function finish(ctx: FinishCtx, patch: FinishPatch): Promise<DecideResult> {
  if (patch.remember && ctx.input.sweeps) {
    await ctx.input.sweeps.set(sweepKey(ctx.input.unit_id, ctx.point), ctx.hash);
  }
  const agreed = patch.verdict === 'reject' || patch.verdict === 'fallback_rule';
  const applied = ctx.mode === 'live' && ctx.config.live && (patch.verdict === 'act' || patch.verdict === 'reject');
  const elapsed = ctx.now() - ctx.started;
  const row: JudgmentRow = {
    id: ctx.recordId,
    point: ctx.point,
    unit_id: ctx.input.unit_id,
    input_hash: ctx.hash,
    source_watermark: ctx.input.source_watermark ?? null,
    hard_filter_result_json: JSON.stringify({
      blocked: ctx.filter.blocked,
      eligible: ctx.filter.eligible.map(item => ({ id: item.id, label: item.label })),
      dropped: ctx.filter.dropped,
    }),
    request_payload_json: patch.payload,
    provider_path: patch.path,
    routing_reason: ctx.routingReason,
    model: patch.model,
    answer_json: patch.answer ? JSON.stringify(patch.answer) : null,
    probs_json: patch.probs ? JSON.stringify(patch.probs) : null,
    verdict: patch.verdict,
    shadow_decider_json: patch.shadow === null ? null : JSON.stringify(patch.shadow),
    rule_baseline: patch.baseline,
    agreed: agreed ? 1 : 0,
    cost_micro_usd: ctx.chargedAny ? ctx.charged : null,
    gen_id: patch.genId,
    latency_ms: Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : 0,
    created_at: new Date(ctx.started).toISOString(),
    consumed_by: null,
  };
  if (ctx.input.store) await ctx.input.store.insert(row);
  return {
    verdict: patch.verdict,
    answer: patch.answer,
    probs: patch.probs,
    provider_path: patch.path,
    record_id: ctx.recordId,
    applied,
    rule_baseline: patch.baseline,
    agreed,
    routing_reason: ctx.routingReason,
  };
}

function mapAnswers(
  point: PointId,
  answers: Record<string, DecisionAnswer>,
  eligible: readonly FilterCandidate[],
  override: Partial<Record<QuestionId, Thresholds>> | undefined,
): Verdict {
  if (point === 'verify.independent') return mapVerification();
  if (point === 't2.rebalance') {
    return mapT2(asBand(readNoul(answers, 'waiting_on_external_reply'), thresholdsFor('waiting_on_external_reply', override)));
  }
  if (point === 'sweep.owner_question') {
    return mapSweep(asBand(readNoul(answers, 'owner_question_in_recent_events'), thresholdsFor('owner_question_in_recent_events', override)));
  }
  const critical = asBand(readNoul(answers, 'diff_touches_critical_path'), thresholdsFor('diff_touches_critical_path', override));
  const suitable = asBand(readNoul(answers, 'any_candidate_suitable'), thresholdsFor('any_candidate_suitable', override));
  const choice = choiceGate(answers, eligible, thresholdsFor('fitting_candidate', override));
  return matchT4(critical, suitable, choice);
}

function asBand(probability: number | null, thresholds: Thresholds): NoulBand {
  if (probability === null || !Number.isFinite(probability)) return 'unsettled';
  return bandOf(probability, thresholds);
}

function readNoul(answers: Record<string, DecisionAnswer>, id: string): number | null {
  const answer = answers[id];
  if (!answer || answer.type !== 'noul') return null;
  return answer.noul;
}

function choiceGate(
  answers: Record<string, DecisionAnswer>,
  eligible: readonly FilterCandidate[],
  thresholds: Thresholds,
): ChoiceGate {
  const answer = answers.fitting_candidate;
  if (!answer || answer.type !== 'choice') return 'unsettled';
  if (!eligible.some(row => row.label === answer.choice)) return 'ineligible';
  if (!answer.probabilities) return 'unsettled';
  const probability = answer.probabilities[answer.choice];
  if (typeof probability !== 'number') return 'unsettled';
  return bandOf(probability, thresholds);
}

function gatingProbs(answers: Record<string, DecisionAnswer>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, answer] of Object.entries(answers)) {
    if (answer.type === 'noul') out[id] = answer.noul;
    else if (answer.type === 'choice' && answer.probabilities) {
      for (const [label, probability] of Object.entries(answer.probabilities)) out[`${id}.${label}`] = probability;
    }
  }
  return out;
}

const llmRoot = z.object({ answers: z.record(z.string(), z.unknown()) }).strict();
const llmNoul = z.object({
  type: z.literal('noul'),
  noul: z.number().refine(value => Number.isFinite(value) && value >= 0 && value <= 1),
}).strict();
const llmChoice = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
}).strict();

function parseLlm(text: string, wire: Record<string, WireQuestion>): Record<string, DecisionAnswer> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const root = llmRoot.safeParse(raw);
  if (!root.success) return null;
  const ids = Object.keys(wire);
  const got = Object.keys(root.data.answers);
  if (got.length !== ids.length || ids.some(id => !(id in root.data.answers))) return null;
  const out: Record<string, DecisionAnswer> = {};
  for (const id of ids) {
    const question = wire[id];
    const body = root.data.answers[id];
    if (!question) return null;
    if (question.type === 'noul') {
      const parsed = llmNoul.safeParse(body);
      if (!parsed.success) return null;
      out[id] = parsed.data;
      continue;
    }
    const parsed = llmChoice.safeParse(body);
    if (!parsed.success) return null;
    const labels = Object.keys(question.criteria);
    if (!labels.includes(parsed.data.choice)) return null;
    const keys = Object.keys(parsed.data.probabilities);
    if (keys.length !== labels.length || labels.some(label => !keys.includes(label))) return null;
    for (const label of labels) {
      const probability = parsed.data.probabilities[label];
      if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) return null;
    }
    out[id] = {
      type: 'choice',
      choice: parsed.data.choice,
      probabilities: parsed.data.probabilities,
    };
  }
  return out;
}

function llmPrompt(state: unknown, questions: Record<string, WireQuestion>): string {
  return [
    'Return one JSON object and nothing else.',
    'Shape: {"answers":{"<question id>": <answer>}}.',
    'A noul answer is {"type":"noul","noul":<number from 0 to 1>}.',
    'A choice answer is {"type":"choice","choice":<one criteria label>,"probabilities":{<every criteria label>:<number from 0 to 1>}}.',
    'Use only the question ids and choice labels below.',
    'State:',
    canonicalJson(state),
    'Questions:',
    canonicalJson(questions),
  ].join('\n');
}

async function reserve(ledger: DecisionLedger, body: ReserveInput): Promise<{ ok: true; id: string } | { ok: false }> {
  const result = await ledger.reserve(body);
  if (!result.ok) return { ok: false };
  return { ok: true, id: result.reservation_id };
}

async function releaseHold(ledger: DecisionLedger, reservationId: string, error: JevClientError): Promise<void> {
  if (error.errorClass === 'forbidden_model' && error.generationId && error.costUsd !== null) return;
  const evidence = `decision:${error.errorClass}${error.apiCode !== null ? `:${String(error.apiCode)}` : ''}`;
  if (error.status !== null && error.status >= 400 && error.status < 500) {
    await ledger.closeNoCharge(reservationId, evidence);
    return;
  }
  await ledger.markPending(reservationId, evidence, error.generationId ? { generation_id: error.generationId, model: error.servedModel ?? undefined } : undefined);
}

function settleFrom(id: string, micro: number, provider: string, model: string, prompt: number, completion: number): SettleInput {
  const total = Number.isSafeInteger(prompt + completion) ? prompt + completion : null;
  return {
    generation_id: id,
    micro_usd: micro,
    cost_field: 'usage',
    provider_account: provider,
    model,
    tokens: { prompt, completion, total },
  };
}

function costMicro(usd: number): number {
  return roundUsdToMicro(usd);
}

function safeMicro(usd: number): number | null {
  try {
    return roundUsdToMicro(usd);
  } catch {
    return null;
  }
}

function cleanKey(apiKey: string | undefined): boolean {
  return typeof apiKey === 'string' && apiKey.length > 0 && apiKey.trim() === apiKey && !/[\r\n\0]/.test(apiKey);
}

function asQuestions(wire: Record<string, WireQuestion>): Record<string, DecisionQuestion> {
  const out: Record<string, DecisionQuestion> = {};
  for (const [id, question] of Object.entries(wire)) {
    if (!question) continue;
    if (question.type === 'noul') {
      out[id] = { type: 'noul', instructions: question.instructions, criteria: { true: question.criteria.true, false: question.criteria.false } };
    } else {
      out[id] = { type: 'choice', instructions: question.instructions, criteria: { ...question.criteria } };
    }
  }
  return out;
}
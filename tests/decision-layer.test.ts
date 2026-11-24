import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import test, { after, before } from 'node:test';
import { Miniflare } from 'miniflare';
import { D1_ULTRA_REQUEST_MODEL, DECISION_LIVE_ENABLED, JEV_CONTEXT_TOKENS, JEV_REQUEST_MODEL, resolveDecisionConfig } from '../src/decision/config.ts';
import { DecisionInputError } from '../src/decision/errors.ts';
import {
  applyOutcome,
  decide,
  matchT4,
  type DecisionLedger,
} from '../src/decision/decide.ts';
import { runHardFilters } from '../src/decision/hard-filter.ts';
import {
  DECIDER_SHADOW_MODEL,
  DECISIONS_URL,
  FORBIDDEN_DECISION_MODELS,
  JevClientError,
  buildJevRequest,
  imageWithinBounds,
  isServedJevModel,
  postJevDecision,
  type FetchLike,
} from '../src/decision/jev-client.ts';
import { POINT_QUESTIONS, bandOf, type QuestionId } from '../src/decision/questions.ts';
import { routeBySize } from '../src/decision/route.ts';
import { MapSweepMemory, shouldSkipSweep, stateHash } from '../src/decision/sweep.ts';
import { JUDGMENT_COLUMNS, MemoryJudgmentStore, createD1JudgmentStore } from '../src/decision/store.ts';
import { selectVerifier, SEED_ROLE_CATALOG } from '../src/phase-contracts/role-select.ts';
import type { Database } from '../src/server/db.ts';

const KEY = 'test-key';
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GENERATION_URL = 'https://openrouter.ai/api/v1/generation';
const SERVED = 'liquid/d1.2-ultra';
const JEV_SERVED = 'typesafe/jev-1.14-20261014';
const originalFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async () => {
    throw new Error('unexpected network');
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

interface Call {
  url: string;
  method: string;
  body: string;
  headerNames: string[];
  authorization: string | null;
}

function headerNames(init: RequestInit | undefined): { names: string[]; authorization: string | null } {
  const headers = init?.headers;
  if (!headers || headers instanceof Headers || Array.isArray(headers)) return { names: [], authorization: null };
  const record = headers as Record<string, string>;
  const names = Object.keys(record);
  const authKey = names.find(name => name.toLowerCase() === 'authorization');
  return { names, authorization: authKey ? record[authKey] ?? null : null };
}

function scripted(handler: (url: string, init: RequestInit | undefined) => Response): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const headers = headerNames(init);
    calls.push({
      url: String(input),
      method: init?.method ?? '',
      body: typeof init?.body === 'string' ? init.body : '',
      headerNames: headers.names,
      authorization: headers.authorization,
    });
    return handler(String(input), init);
  };
  return { fetchImpl, calls };
}

function usage(cost = 0.0000384) {
  return {
    input_tokens: 120,
    output_tokens: 8,
    cost,
    is_byok: false,
    cost_details: {
      upstream_inference_cost: cost,
      upstream_inference_prompt_cost: cost,
      upstream_inference_completions_cost: 0,
    },
  };
}

function jevResponse(answers: Record<string, unknown>, extra?: { model?: string; provider?: string; cost?: number }) {
  return {
    id: 'gen-dec-1',
    model: extra?.model ?? SERVED,
    provider: extra?.provider ?? 'TypeSafe',
    answers,
    usage: usage(extra?.cost ?? 0.0000384),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function noul(n: number) {
  return { type: 'noul', noul: n };
}

function choice(label: string, probabilities: Record<string, number>, confidence = 0.99) {
  return { type: 'choice', choice: label, probabilities, confidence };
}

interface LedgerLog {
  reserve: { model: string; attempt_id: string }[];
  pending: { reservation_id: string; reason: string }[];
  settle: { reservation_id: string; micro_usd: number; model: string; cost_field: string }[];
  close: { reservation_id: string; evidence: string }[];
}

function fakeLedger(ok = true): { ledger: DecisionLedger; log: LedgerLog } {
  const log: LedgerLog = { reserve: [], pending: [], settle: [], close: [] };
  let n = 0;
  const holds = new Map<string, Parameters<DecisionLedger['reserve']>[0]>();
  const ledger: DecisionLedger = {
    reserve(input) {
      log.reserve.push({ model: input.model, attempt_id: input.attempt_id });
      n += 1;
      if (!ok) return { ok: false, reason: 'over_budget', remaining: 0 };
      holds.set(`res-${n}`, input);
      return { ok: true, reservation_id: `res-${n}`, created: true, state: 'open' };
    },
    assertReservation(binding) {
      const held = holds.get(binding.reservation_id);
      assert.ok(held);
      for (const field of ['project', 'run_id', 'attempt_id', 'model'] as const) assert.equal(held[field], binding[field]);
    },
    markPending(reservation_id, reason) {
      log.pending.push({ reservation_id, reason });
    },
    settle(reservation_id, actual) {
      log.settle.push({ reservation_id, micro_usd: actual.micro_usd, model: actual.model, cost_field: actual.cost_field });
    },
    closeNoCharge(reservation_id, evidence) {
      log.close.push({ reservation_id, evidence });
      return 'closed_no_charge';
    },
  };
  return { ledger, log };
}

function base(over: Record<string, unknown> = {}) {
  return {
    point: 't2.rebalance' as const,
    unit_id: 'unit-1',
    state: { task: 'The vendor has not answered.' },
    questions: POINT_QUESTIONS['t2.rebalance'],
    candidates: [],
    apiKey: KEY,
    timeoutMs: 1000,
    source_watermark: 'evt-9',
    recordId: 'jdg_test',
    ...over,
  };
}

function pngData(width: number, height: number): string {
  const bytes = Buffer.alloc(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

const muse = {
  id: 'agent:muse',
  label: 'muse',
  description: 'Muse can take the task.',
  roleIds: ['spec-reviewer'],
  lane: 'critical',
  openUnits: 0,
};
const dots = {
  id: 'agent:dots',
  label: 'dots',
  description: 'Dots wrote the unit.',
  roleIds: ['spec-reviewer'],
  lane: 'critical',
  openUnits: 0,
};

test('request uses liquid/d1.2-ultra, criteria records, and no provider pin', async () => {
  const logs: string[] = [];
  const { fetchImpl, calls } = scripted(() => jsonResponse(200, jevResponse({ waiting_on_external_reply: noul(0.1) })));
  const { ledger } = fakeLedger();
  const store = new MemoryJudgmentStore();
  const result = await decide({
    ...base(),
    fetchImpl,
    ledger,
    store,
    logger: line => logs.push(line),
  });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, DECISIONS_URL);
  assert.equal(call.method, 'POST');
  assert.equal(call.authorization, `Bearer ${KEY}`);
  assert.deepEqual(call.headerNames.sort(), ['Accept', 'Authorization', 'Content-Type']);
  assert.equal(call.headerNames.some(name => /danger/i.test(name)), false);
  assert.equal(call.body.includes(KEY), false);
  assert.equal(logs[0], call.body);
  const payload = JSON.parse(call.body) as {
    model: string;
    provider: { only: string[] };
    session_id: string;
    trace: Record<string, string>;
    questions: Record<string, { type: string; criteria?: unknown; options?: unknown }>;
  };
  assert.equal(payload.model, D1_ULTRA_REQUEST_MODEL);
  assert.equal(payload.provider, undefined);
  assert.equal(payload.session_id, 'unit-1');
  assert.deepEqual(Object.keys(payload.trace).sort(), ['trace_id', 'trace_name']);
  const question = payload.questions.waiting_on_external_reply;
  assert.ok(question);
  assert.equal(question.type, 'noul');
  assert.equal('options' in question, false);
  assert.deepEqual(Object.keys(question.criteria as object).sort(), ['false', 'true']);
  assert.equal(typeof (question.criteria as { true: string }).true, 'string');
  for (const forbidden of FORBIDDEN_DECISION_MODELS) assert.equal(call.body.includes(forbidden), false);
  assert.equal(result.provider_path, 'd1');
  assert.equal(result.routing_reason, 'within_d1_ultra');
  assert.equal(result.verdict, 'act');
  assert.equal(store.rows[0]?.request_payload_json, call.body);
  assert.equal(store.rows[0]?.model, SERVED);
  assert.equal(store.rows[0]?.routing_reason, 'within_d1_ultra');
  assert.equal(store.rows[0]?.source_watermark, 'evt-9');
  assert.equal(store.rows[0]?.cost_micro_usd, 38);
});

test('choice criteria is a record and score criteria is an array', () => {
  const choiceBody = buildJevRequest({
    state: { task: 'ship the patch' },
    questions: {
      fitting_candidate: {
        type: 'choice',
        instructions: 'Which candidate in `candidates` fits `task`?',
        criteria: { muse: 'Muse can take the task.' },
      },
    },
  }).payload;
  const choice = JSON.parse(choiceBody) as { questions: { fitting_candidate: { criteria: unknown } } };
  assert.deepEqual(choice.questions.fitting_candidate.criteria, { muse: 'Muse can take the task.' });
  assert.throws(() => buildJevRequest({
    state: 'x',
    questions: {
      fitting_candidate: {
        type: 'choice',
        instructions: 'Which candidate fits?',
        criteria: 'muse' as unknown as Record<string, string>,
      },
    },
  }), (error: unknown) => error instanceof JevClientError && error.errorClass === 'bad_request');
  const scoreBody = buildJevRequest({
    state: 'ticket',
    questions: {
      urgency: { type: 'score', instructions: 'How urgent is `ticket`?', criteria: ['It can wait.', 'It blocks the release.'] },
    },
  }).payload;
  const score = JSON.parse(scoreBody) as { questions: { urgency: { criteria: unknown } } };
  assert.deepEqual(score.questions.urgency.criteria, ['It can wait.', 'It blocks the release.']);
});

test('served model must use the jev-1.14 build prefix', () => {
  assert.equal(isServedJevModel('typesafe/jev-1.14-20261014'), true);
  assert.equal(isServedJevModel(JEV_REQUEST_MODEL), false);
  assert.equal(isServedJevModel('typesafe/jev-1.14-'), false);
  assert.equal(isServedJevModel('typesafe/jev-router'), false);
  assert.equal(isServedJevModel('~typesafe/jev-latest'), false);
});

test('a noul confidence field is tolerated and is not the gate', async () => {
  const { fetchImpl, calls } = scripted(() => jsonResponse(200, jevResponse({
    waiting_on_external_reply: { type: 'noul', noul: 0.1, confidence: 0.96 },
  })));
  const result = await decide({ ...base(), fetchImpl, ledger: fakeLedger().ledger });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, DECISIONS_URL);
  assert.equal(result.provider_path, 'd1');
  assert.equal(result.verdict, 'act');
  const waiting = result.answer?.waiting_on_external_reply;
  assert.equal(waiting?.type, 'noul');
  if (waiting?.type === 'noul') assert.equal(waiting.noul, 0.1);
});

test('thresholds use probability bands, including the unsettled row', () => {
  assert.equal(bandOf(0.7, { yesAt: 0.7, noAt: 0.3 }), 'yes');
  assert.equal(bandOf(0.3, { yesAt: 0.7, noAt: 0.3 }), 'no');
  assert.equal(bandOf(0.5, { yesAt: 0.7, noAt: 0.3 }), 'unsettled');
  assert.equal(bandOf(0.3000001, { yesAt: 0.7, noAt: 0.3 }), 'unsettled');
  assert.equal(bandOf(0.699999, { yesAt: 0.7, noAt: 0.3 }), 'unsettled');
  assert.equal(matchT4('unsettled', 'yes', 'yes'), 'unsettled');
  assert.equal(matchT4('yes', 'yes', 'yes'), 'reject');
  assert.equal(matchT4('no', 'unsettled', 'yes'), 'unsettled');
  assert.equal(matchT4('no', 'no', 'yes'), 'reject');
  assert.equal(matchT4('no', 'yes', 'ineligible'), 'reject');
  assert.equal(matchT4('no', 'yes', 'unsettled'), 'unsettled');
  assert.equal(matchT4('no', 'yes', 'no'), 'reject');
  assert.equal(matchT4('no', 'yes', 'yes'), 'act');
});

test('an unsettled jev answer does not call the chat model', async () => {
  const { fetchImpl, calls } = scripted(() => jsonResponse(200, jevResponse({ waiting_on_external_reply: noul(0.5) })));
  const result = await decide({ ...base(), fetchImpl, ledger: fakeLedger().ledger });
  assert.equal(calls.length, 1);
  assert.equal(result.verdict, 'unsettled');
  assert.equal(result.provider_path, 'd1');
  assert.equal(result.agreed, false);
});

test('per-action thresholds stay in code and can move one question', async () => {
  const { fetchImpl, calls } = scripted(() => jsonResponse(200, jevResponse({ waiting_on_external_reply: noul(0.9) })));
  const result = await decide({
    ...base(),
    fetchImpl,
    ledger: fakeLedger().ledger,
    thresholds: { waiting_on_external_reply: { yesAt: 0.95, noAt: 0.2 } },
  });
  assert.equal(result.verdict, 'unsettled');
  assert.equal(calls[0]?.body.includes('0.95'), false);
});

test('jev error falls through to the chat model, then the rule, and never to a decision model', async () => {
  const secret = 'user-secret';
  const { fetchImpl, calls } = scripted(url => {
    if (url === DECISIONS_URL) {
      return jsonResponse(400, { error: { message: `bad ${secret} criteria`, code: 'invalid_criteria', user_id: secret } });
    }
    if (url === CHAT_URL) throw new Error('llm down');
    throw new Error(`unexpected ${url}`);
  });
  const { ledger, log } = fakeLedger();
  const store = new MemoryJudgmentStore();
  const result = await decide({ ...base(), fetchImpl, ledger, store });
  assert.deepEqual(calls.map(call => call.url), [DECISIONS_URL, CHAT_URL]);
  assert.equal(calls.some(call => call.body.includes(DECIDER_SHADOW_MODEL) || call.body.includes('jev-router') || call.body.includes('jev-latest')), false);
  assert.equal(result.verdict, 'fallback_rule');
  assert.equal(result.provider_path, 'rule');
  assert.equal(result.answer, null);
  assert.equal(result.probs, null);
  const blob = JSON.stringify({ result, close: log.close, pending: log.pending, row: store.rows[0] });
  assert.equal(blob.includes(secret), false);
  assert.equal(log.close[0]?.evidence, 'decision:http_status:invalid_criteria');
  assert.equal(store.rows[0]?.answer_json, null);
});
test('a 500 is not stored as a noul no', async () => {
  const { fetchImpl, calls } = scripted(url => {
    if (url === DECISIONS_URL) return jsonResponse(500, { error: { message: 'upstream', code: 500 } });
    if (url === CHAT_URL) return jsonResponse(500, { error: { message: 'nope' } });
    throw new Error(url);
  });
  const { ledger, log } = fakeLedger();
  const result = await decide({ ...base(), fetchImpl, ledger });
  assert.equal(calls.length, 2);
  assert.equal(result.verdict, 'fallback_rule');
  assert.equal(result.answer, null);
  assert.equal(log.pending.some(row => row.reason.startsWith('decision:')), true);
  assert.equal(JSON.stringify(result).includes('"noul":0'), false);
});

test('a chat error carrying a generation remains held for reconciliation', async () => {
  const { fetchImpl } = scripted(url => {
    if (url === DECISIONS_URL) return jsonResponse(400, { error: { message: 'invalid', code: 'invalid_criteria' } });
    if (url === CHAT_URL) return jsonResponse(400, { id: 'gen-uncertain', error: { message: 'response failed' } });
    throw new Error(url);
  });
  const { ledger, log } = fakeLedger();
  const result = await decide({ ...base(), fetchImpl, ledger });
  const chatHold = log.reserve.find(row => row.attempt_id.endsWith('-llm'));
  assert.ok(chatHold);
  assert.equal(log.close.length, 1, 'only the separate failed decision request is released');
  assert.equal(log.pending.some(row => row.reason === 'llm_error'), true);
  assert.equal(result.verdict, 'fallback_rule');
});

test('chat text that fails zod is unsettled', async () => {
  const { fetchImpl, calls } = scripted(url => {
    if (url === DECISIONS_URL) return jsonResponse(400, { error: { message: 'no', code: 400 } });
    if (url === CHAT_URL) {
      return jsonResponse(200, { id: 'gen-llm', choices: [{ message: { content: 'not json' } }] });
    }
    assert.ok(url.startsWith(GENERATION_URL));
    return jsonResponse(200, { data: { id: 'gen-llm', total_cost: 0.0015, provider_name: 'Infermatic', model: 'z-ai/glm-5.3', tokens_prompt: 3, tokens_completion: 1 } });
  });
  const { ledger, log } = fakeLedger();
  const result = await decide({ ...base(), fetchImpl, ledger });
  assert.equal(calls.length, 3);
  assert.equal(result.verdict, 'unsettled');
  assert.equal(result.provider_path, 'llm');
  assert.equal(result.answer, null);
  assert.equal(log.settle[0]?.micro_usd, 1500);
  assert.equal(log.settle[0]?.model, 'z-ai/glm-5.3');
});

test('hard filters run first and a jev choice cannot add a dropped candidate', async () => {
  const blocked = scripted(() => jsonResponse(200, jevResponse({ waiting_on_external_reply: noul(0.1) })));
  const fresh = await decide({
    ...base(),
    fetchImpl: blocked.fetchImpl,
    ledger: fakeLedger().ledger,
    filter: { dispatchGate: true, sourceStatus: 'STALE', intentStatus: 'VALID' },
    candidates: [muse],
  });
  assert.equal(blocked.calls.length, 0);
  assert.equal(fresh.verdict, 'reject');
  assert.equal(fresh.provider_path, 'rule');

  const filtered = runHardFilters({
    unitId: 'unit-9',
    unitClass: 'build',
    verifyingRoleId: 'spec-reviewer',
    authorId: 'agent:dots',
    requiredLane: 'critical',
    capacity: 2,
    concurrencyLimit: 2,
    candidates: [
      dots,
      muse,
      { ...muse, id: 'agent:bulk', label: 'bulk', lane: 'bulk', description: 'Bulk lane candidate.' },
      { ...muse, id: 'agent:full', label: 'full', openUnits: 2, description: 'Full candidate.' },
    ],
  });
  assert.deepEqual(filtered.eligible.map(row => row.id), ['agent:muse']);
  assert.equal(filtered.dropped.some(row => row.id === 'agent:dots' && row.code === 'author_is_verifier'), true);
  assert.equal(filtered.dropped.some(row => row.id === 'agent:bulk' && row.code === 'lane'), true);
  const verifier = selectVerifier({
    catalog: SEED_ROLE_CATALOG,
    unitClass: 'build',
    roleId: 'spec-reviewer',
    unitId: 'unit-9',
    authorId: 'agent:dots',
    candidates: [dots, muse].map(row => ({ agentId: row.id, roleIds: row.roleIds ?? [] })),
  });
  assert.equal(verifier.ok, true);
  if (verifier.ok) assert.equal(filtered.eligible.some(row => row.id === verifier.value.assigneeId), true);

  const { fetchImpl, calls } = scripted(() => jsonResponse(200, jevResponse({
    diff_touches_critical_path: noul(0.1),
    any_candidate_suitable: noul(0.9),
    fitting_candidate: choice('dots', { dots: 0.95 }),
  })));
  const result = await decide({
    point: 't4.rebalance',
    unit_id: 'unit-9',
    state: { task: 'Fix the lease.', diff: 'src/orch/lease.ts', critical_path_modules: ['src/orch/lease.ts'], candidates: ['Muse'] },
    questions: POINT_QUESTIONS['t4.rebalance'],
    candidates: [dots, muse],
    filter: { unitClass: 'build', verifyingRoleId: 'spec-reviewer', authorId: 'agent:dots', requiredLane: 'critical' },
    apiKey: KEY,
    fetchImpl,
    ledger: fakeLedger().ledger,
    timeoutMs: 1000,
    recordId: 'jdg_filter',
  });
  const body = JSON.parse(calls[0]?.body ?? '{}') as { questions: Record<string, { criteria?: Record<string, string> }> };
  assert.deepEqual(Object.keys(body.questions), [...POINT_QUESTIONS['t4.rebalance']]);
  assert.deepEqual(Object.keys(body.questions.fitting_candidate?.criteria ?? {}), ['muse']);
  assert.equal(result.verdict, 'reject');
  assert.equal(result.provider_path, 'd1');
  assert.equal(result.answer?.fitting_candidate && result.answer.fitting_candidate.type === 'choice' ? result.answer.fitting_candidate.choice : '', 'dots');
});

test('a loosened hard_filter_result cannot put the author back', async () => {
  const { fetchImpl, calls } = scripted(() => jsonResponse(200, jevResponse({
    diff_touches_critical_path: noul(0.1),
    any_candidate_suitable: noul(0.92),
    fitting_candidate: choice('muse', { muse: 0.88 }),
  })));
  await decide({
    point: 't4.rebalance',
    unit_id: 'unit-9',
    state: { task: 'Fix the lease.' },
    questions: [...POINT_QUESTIONS['t4.rebalance']],
    candidates: [dots, muse],
    filter: { unitClass: 'build', verifyingRoleId: 'spec-reviewer', authorId: 'agent:dots' },
    hard_filter_result: { blocked: false, eligible: [dots, muse], dropped: [] },
    apiKey: KEY,
    fetchImpl,
    ledger: fakeLedger().ledger,
    timeoutMs: 1000,
    recordId: 'jdg_tighten',
  });
  const body = JSON.parse(calls[0]?.body ?? '{}') as { questions: { fitting_candidate: { criteria: Record<string, string> } } };
  assert.deepEqual(Object.keys(body.questions.fitting_candidate.criteria), ['muse']);
});

test('choice probability gates, not confidence, and a critical-path yes blocks', async () => {
  const low = scripted(() => jsonResponse(200, jevResponse({
    diff_touches_critical_path: noul(0.1),
    any_candidate_suitable: noul(0.9),
    fitting_candidate: choice('muse', { muse: 0.5 }, 0.99),
  })));
  const unsettled = await decide({
    point: 't4.rebalance',
    unit_id: 'unit-4',
    state: { task: 'notes', diff: 'docs/readme.md', critical_path_modules: ['src/server/worker.ts'] },
    questions: POINT_QUESTIONS['t4.rebalance'],
    candidates: [muse],
    apiKey: KEY,
    fetchImpl: low.fetchImpl,
    ledger: fakeLedger().ledger,
    timeoutMs: 1000,
    recordId: 'jdg_prob',
  });
  assert.equal(unsettled.verdict, 'unsettled');
  assert.equal(unsettled.probs?.['fitting_candidate.muse'], 0.5);
  assert.equal(low.calls.length, 1);

  const critical = scripted(() => jsonResponse(200, jevResponse({
    diff_touches_critical_path: noul(0.91),
    any_candidate_suitable: noul(0.95),
    fitting_candidate: choice('muse', { muse: 0.95 }, 0.2),
  })));
  const blocked = await decide({
    point: 't4.rebalance',
    unit_id: 'unit-4',
    state: { task: 'lease', diff: 'src/orch/lease.ts', critical_path_modules: ['src/orch/lease.ts'] },
    questions: POINT_QUESTIONS['t4.rebalance'],
    candidates: [muse],
    apiKey: KEY,
    fetchImpl: critical.fetchImpl,
    ledger: fakeLedger().ledger,
    timeoutMs: 1000,
    recordId: 'jdg_critical',
  });
  assert.equal(blocked.verdict, 'reject');
  assert.equal(critical.calls.length, 1);
  const keys = Object.keys((JSON.parse(critical.calls[0]?.body ?? '{}') as { questions: object }).questions);
  assert.deepEqual(keys, [...POINT_QUESTIONS['t4.rebalance']]);
});

test('shadow mode does not change the current outcome', async () => {
  const { fetchImpl } = scripted(() => jsonResponse(200, jevResponse({ waiting_on_external_reply: noul(0.95) })));
  const ledger = fakeLedger().ledger;
  const current = { route: 'legacy' };
  const shadow = await decide({ ...base({ recordId: 'jdg_shadow' }), fetchImpl, ledger, mode: 'shadow' });
  assert.equal(shadow.verdict, 'reject');
  assert.equal(shadow.applied, false);
  assert.deepEqual(applyOutcome(current, shadow), { value: current, applied: false });
  const liveOff = await decide({ ...base({ recordId: 'jdg_live_off' }), fetchImpl, ledger, mode: 'live' });
  assert.equal(DECISION_LIVE_ENABLED, false);
  assert.equal(liveOff.applied, false);
  assert.equal(applyOutcome(current, liveOff).value, current);
  const liveOn = await decide({
    ...base({ recordId: 'jdg_live_on' }),
    fetchImpl,
    ledger,
    mode: 'live',
    config: { live: true },
  });
  assert.equal(liveOn.applied, true);
  assert.equal(applyOutcome(current, liveOn).value.route, 'legacy');
});

test('verification does not become a PASS and does not call a model', async () => {
  const { fetchImpl, calls } = scripted(() => {
    throw new Error('called');
  });
  const result = await decide({
    point: 'verify.independent',
    unit_id: 'unit-v',
    state: { receipt: 'looks good' },
    questions: [],
    candidates: [muse],
    apiKey: KEY,
    fetchImpl,
    ledger: fakeLedger().ledger,
  });
  assert.equal(calls.length, 0);
  assert.equal(result.verdict, 'reject');
  assert.equal(result.provider_path, 'rule');
  assert.equal(result.answer, null);
  assert.equal(Object.hasOwn(result, 'pass'), false);
});

test('a different question set is refused before any call', async () => {
  const { fetchImpl, calls } = scripted(() => {
    throw new Error('called');
  });
  await assert.rejects(() => decide({
    ...base(),
    questions: ['owner_question_in_recent_events'] as unknown as readonly QuestionId[],
    fetchImpl,
    ledger: fakeLedger().ledger,
  }), (error: unknown) => error instanceof DecisionInputError && error.code === 'question_set');
  assert.equal(calls.length, 0);
});

test('an unchanged sweep hash skips every model call', async () => {
  const sweeps = new MapSweepMemory();
  assert.equal(shouldSkipSweep(null, stateHash({ recent_events: ['hello'] })), false);
  assert.equal(shouldSkipSweep('abc', 'abc'), true);
  const seen: string[] = [];
  const fetchImpl: FetchLike = async () => {
    seen.push('call');
    return jsonResponse(200, jevResponse({ owner_question_in_recent_events: noul(0.2) }));
  };
  const { ledger, log } = fakeLedger();
  const first = await decide({
    point: 'sweep.owner_question',
    unit_id: 'unit-s',
    state: { recent_events: ['hello'] },
    questions: POINT_QUESTIONS['sweep.owner_question'],
    candidates: [],
    apiKey: KEY,
    fetchImpl,
    ledger,
    sweeps,
    timeoutMs: 1000,
    recordId: 'jdg_sweep_1',
  });
  assert.equal(first.provider_path, 'd1');
  assert.equal(first.verdict, 'reject');
  const reserves = log.reserve.length;
  const second = await decide({
    point: 'sweep.owner_question',
    unit_id: 'unit-s',
    state: { recent_events: ['hello'] },
    questions: POINT_QUESTIONS['sweep.owner_question'],
    candidates: [],
    apiKey: KEY,
    fetchImpl,
    ledger,
    sweeps,
    timeoutMs: 1000,
    recordId: 'jdg_sweep_2',
  });
  assert.equal(seen.length, 1);
  assert.equal(log.reserve.length, reserves);
  assert.equal(second.verdict, 'fallback_rule');
  assert.equal(second.rule_baseline, 'unchanged_state');
  assert.equal(second.provider_path, 'rule');
  const third = await decide({
    point: 'sweep.owner_question',
    unit_id: 'unit-s',
    state: { recent_events: ['a new question for the owner'] },
    questions: POINT_QUESTIONS['sweep.owner_question'],
    candidates: [],
    apiKey: KEY,
    fetchImpl,
    ledger,
    sweeps,
    timeoutMs: 1000,
    recordId: 'jdg_sweep_3',
  });
  assert.equal(seen.length, 2);
  assert.equal(third.provider_path, 'd1');
});

test('missing fetch does not touch the network and an over-budget hold does not call', async () => {
  const skipped = await decide({ ...base(), ledger: fakeLedger().ledger });
  assert.equal(skipped.verdict, 'fallback_rule');
  assert.equal(skipped.answer, null);
  const { fetchImpl, calls } = scripted(() => {
    throw new Error('called');
  });
  const denied = await decide({ ...base({ recordId: 'jdg_budget' }), fetchImpl, ledger: fakeLedger(false).ledger });
  assert.equal(calls.length, 0);
  assert.equal(denied.verdict, 'reject');
  assert.equal(denied.provider_path, 'rule');
});

test('decider v1.2 is recorded and is not the verdict', async () => {
  let step = 0;
  const { fetchImpl, calls } = scripted(() => {
    step += 1;
    if (step === 1) return jsonResponse(200, jevResponse({ waiting_on_external_reply: noul(0.1) }));
    return jsonResponse(200, {
      ...jevResponse({ waiting_on_external_reply: noul(0.92) }, { model: 'perplexity/pplx-decider-v1.2', provider: 'Perplexity' }),
      id: 'gen-decider',
    });
  });
  const store = new MemoryJudgmentStore();
  const result = await decide({
    ...base({ recordId: 'jdg_shadow_decider' }),
    fetchImpl,
    ledger: fakeLedger().ledger,
    store,
    mode: 'shadow',
    shadowDecider: true,
  });
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0]?.body ?? '{}').model, D1_ULTRA_REQUEST_MODEL);
  assert.equal(JSON.parse(calls[1]?.body ?? '{}').model, DECIDER_SHADOW_MODEL);
  assert.equal(JSON.parse(calls[1]?.body ?? '{}').provider, undefined);
  assert.equal(result.verdict, 'act');
  assert.equal(result.provider_path, 'd1');
  const shadow = JSON.parse(store.rows[0]?.shadow_decider_json ?? 'null') as { response: { answers: { waiting_on_external_reply: { noul: number } } } };
  assert.equal(shadow.response.answers.waiting_on_external_reply.noul, 0.92);
});
test('usage.cost settles on the openrouter ledger', async () => {
  const { fetchImpl } = scripted(() => jsonResponse(200, jevResponse({ waiting_on_external_reply: noul(0.1) })));
  const { ledger, log } = fakeLedger();
  const result = await decide({
    ...base({ recordId: 'jdg_ledger' }),
    fetchImpl,
    ledger,
    project: 'test',
  });
  assert.equal(result.provider_path, 'd1');
  assert.equal(log.settle.length, 1);
  assert.equal(log.settle[0]?.micro_usd, 38);
  assert.equal(log.settle[0]?.cost_field, 'usage');
});

test('image bounds reject a short side and a too-small area', () => {
  assert.equal(imageWithinBounds(256, 307), true);
  assert.equal(imageWithinBounds(256, 256), false);
  assert.equal(imageWithinBounds(100, 800), false);
  assert.equal(imageWithinBounds(1700, 256), false);
  assert.throws(() => buildJevRequest({
    state: ['photo', { type: 'image_url', image_url: { url: pngData(256, 256) } }],
    questions: { has_mark: { type: 'noul', instructions: 'Is there a mark in the photo?' } },
  }), (error: unknown) => error instanceof JevClientError && error.errorClass === 'image_rejected');
  const payload = buildJevRequest({
    state: ['photo', { type: 'image_url', image_url: { url: pngData(256, 307) } }],
    questions: { has_mark: { type: 'noul', instructions: 'Is there a mark in the photo?' } },
  }).payload;
  assert.equal(payload.includes('TypeSafe-Danger'), false);
});

test('400 response user_id is not copied onto the client error', async () => {
  const secret = 'user-secret';
  const { fetchImpl } = scripted(() => jsonResponse(400, {
    error: { message: `bad ${secret} criteria`, code: 400, user_id: secret },
  }));
  await assert.rejects(() => postJevDecision({
    state: { task: 'x' },
    questions: { waiting_on_external_reply: { type: 'noul', instructions: 'Is `task` waiting?' } },
    apiKey: KEY,
    fetchImpl,
    timeoutMs: 1000,
  }), (error: unknown) => {
    assert.ok(error instanceof JevClientError);
    assert.equal(error.errorClass, 'http_status');
    assert.equal(error.retryable, false);
    const blob = `${error.message} ${JSON.stringify(error)}`;
    assert.equal(blob.includes(secret), false);
    return true;
  });
});

test('judgments migration is separate from 0055 and accepts a decide insert', async () => {
  const sql = await readFile('migrations/0078_judgments.sql', 'utf8');
  const decisions = await readFile('migrations/0055_decisions.sql', 'utf8');
  assert.match(sql, /CREATE TABLE judgments\b/);
  assert.match(decisions, /CREATE TABLE decisions\b/);
  assert.doesNotMatch(sql, /CREATE TABLE decisions\b/);
  const registry = await readFile('migrations/REGISTRY.md', 'utf8');
  assert.match(registry, /^\| 0078 \| .* \| used \|$/m);
  assert.match(registry, /^merge_order:.*\b0078\b/m);
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(null) } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: 'judgments-' + crypto.randomUUID() },
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  try {
    const db = await mf.getD1Database('DB') as Database;
    const statements = sql.trim().split(/;\s*\n/).filter(statement => statement.trim()).map(statement => db.prepare(statement));
    await db.batch(statements);
    const columns = await db.prepare("SELECT name FROM pragma_table_info('judgments') ORDER BY cid").all<{ name: string }>();
    assert.deepEqual(columns.results.map(column => column.name), [...JUDGMENT_COLUMNS]);
    const { fetchImpl } = scripted(() => jsonResponse(200, jevResponse({ waiting_on_external_reply: noul(0.1) })));
    const result = await decide({
      ...base({ recordId: 'jdg_d1' }),
      fetchImpl,
      ledger: fakeLedger().ledger,
      store: createD1JudgmentStore(db),
    });
    const row = await db.prepare('SELECT id, provider_path, routing_reason, model, verdict, cost_micro_usd, consumed_by FROM judgments WHERE id = ?')
      .bind(result.record_id).first<{ id: string; provider_path: string; routing_reason: string; model: string; verdict: string; cost_micro_usd: number; consumed_by: string | null }>();
    assert.equal(row?.provider_path, 'd1');
    assert.equal(row?.routing_reason, 'within_d1_ultra');
    assert.equal(row?.model, SERVED);
    assert.equal(row?.verdict, 'act');
    assert.equal(row?.cost_micro_usd, 38);
    assert.equal(row?.consumed_by, null);
    await assert.rejects(() => db.prepare(`INSERT INTO judgments (${JUDGMENT_COLUMNS.join(', ')}) VALUES (${JUDGMENT_COLUMNS.map(() => '?').join(', ')})`).bind(
      'jdg_bad', 't2.rebalance', 'unit-1', 'hash', null, null, null, 'jev', null, 'typesafe/jev-router',
      null, null, 'reject', null, 'hold', 1, 0, null, 0, '2026-11-17T00:00:00.000Z', null,
    ).all(), /CHECK|constraint/i);
  } finally {
    await mf.dispose();
  }
});

test('token limits route before the call and a d1 error does not call jev', () => {
  const config = resolveDecisionConfig();
  assert.equal(config.primary.requestModel, D1_ULTRA_REQUEST_MODEL);
  assert.equal(config.primary.contextTokens, 65_536);
  assert.equal(config.primary.usdPerMillionInput, 0.042);
  assert.equal(config.largeContext.requestModel, JEV_REQUEST_MODEL);
  assert.equal(config.largeContext.contextTokens, JEV_CONTEXT_TOKENS);
  assert.equal(config.safetyMarginTokens, 2_048);
  assert.deepEqual(routeBySize(63_488, config), { route: 'd1', reason: 'within_d1_ultra' });
  assert.deepEqual(routeBySize(63_489, config), { route: 'jev', reason: 'size_over_d1_ultra' });
  assert.deepEqual(routeBySize(260_096, config), { route: 'jev', reason: 'size_over_d1_ultra' });
  assert.deepEqual(routeBySize(260_097, config), { route: 'none', reason: 'size_over_both' });
});

test('under the d1 limit the request uses liquid/d1.2-ultra', async () => {
  const { fetchImpl, calls } = scripted(() => jsonResponse(200, jevResponse({ waiting_on_external_reply: noul(0.1) })));
  const result = await decide({
    ...base({ recordId: 'jdg_under' }),
    fetchImpl,
    ledger: fakeLedger().ledger,
    config: { safetyMarginTokens: 0, primary: { contextTokens: 5_000_000 }, largeContext: { contextTokens: 5_000_000 } },
  });
  assert.equal(JSON.parse(calls[0]?.body ?? '{}').model, D1_ULTRA_REQUEST_MODEL);
  assert.equal(result.provider_path, 'd1');
  assert.equal(result.routing_reason, 'within_d1_ultra');
});

test('over the d1 limit and under jev the request uses jev-1.14', async () => {
  const { fetchImpl, calls } = scripted(() => jsonResponse(200, jevResponse(
    { waiting_on_external_reply: noul(0.1) },
    { model: JEV_SERVED, provider: 'TypeSafe' },
  )));
  const result = await decide({
    ...base({ recordId: 'jdg_over_d1' }),
    fetchImpl,
    ledger: fakeLedger().ledger,
    config: { safetyMarginTokens: 0, primary: { contextTokens: 1 }, largeContext: { contextTokens: 5_000_000 } },
  });
  const body = JSON.parse(calls[0]?.body ?? '{}') as { model: string; provider: { only: string[] } };
  assert.equal(calls.length, 1);
  assert.equal(body.model, JEV_REQUEST_MODEL);
  assert.deepEqual(body.provider, { only: ['TypeSafe'] });
  assert.equal(result.provider_path, 'jev');
  assert.equal(result.routing_reason, 'size_over_d1_ultra');
  assert.equal(result.verdict, 'act');
});

test('over both context limits skips decision models and uses the chat model', async () => {
  const { fetchImpl, calls } = scripted(url => {
    if (url === DECISIONS_URL) throw new Error('decision model called');
    if (url === CHAT_URL) {
      return jsonResponse(200, {
        id: 'gen-llm',
        choices: [{ message: { content: JSON.stringify({ answers: { waiting_on_external_reply: { type: 'noul', noul: 0.1 } } }) } }],
      });
    }
    return jsonResponse(200, { data: { id: 'gen-llm', total_cost: 0.001, provider_name: 'Infermatic', model: 'z-ai/glm-5.3', tokens_prompt: 4, tokens_completion: 2 } });
  });
  const store = new MemoryJudgmentStore();
  const result = await decide({
    ...base({ recordId: 'jdg_over_both' }),
    fetchImpl,
    ledger: fakeLedger().ledger,
    store,
    config: { safetyMarginTokens: 0, primary: { contextTokens: 1 }, largeContext: { contextTokens: 1 } },
  });
  assert.equal(calls.some(call => call.url === DECISIONS_URL), false);
  assert.equal(calls[0]?.url, CHAT_URL);
  assert.equal(result.provider_path, 'llm');
  assert.equal(result.routing_reason, 'size_over_both');
  assert.equal(store.rows[0]?.routing_reason, 'size_over_both');
});

test('a d1.2-ultra error falls through to the chat model and not to jev', async () => {
  const { fetchImpl, calls } = scripted(url => {
    if (url === DECISIONS_URL) return jsonResponse(500, { error: { message: 'upstream', code: 500 } });
    if (url === CHAT_URL) {
      return jsonResponse(200, {
        id: 'gen-llm',
        choices: [{ message: { content: JSON.stringify({ answers: { waiting_on_external_reply: { type: 'noul', noul: 0.1 } } }) } }],
      });
    }
    return jsonResponse(200, { data: { id: 'gen-llm', total_cost: 0.001, provider_name: 'Infermatic', model: 'z-ai/glm-5.3', tokens_prompt: 4, tokens_completion: 2 } });
  });
  const result = await decide({ ...base({ recordId: 'jdg_d1_error' }), fetchImpl, ledger: fakeLedger().ledger });
  assert.equal(calls.filter(call => call.url === DECISIONS_URL).length, 1);
  assert.equal(JSON.parse(calls[0]?.body ?? '{}').model, D1_ULTRA_REQUEST_MODEL);
  assert.equal(calls.some(call => call.body.includes(JEV_REQUEST_MODEL) || call.body.includes('jev-latest') || call.body.includes('jev-router')), false);
  assert.equal(calls[1]?.url, CHAT_URL);
  assert.equal(result.provider_path, 'llm');
  assert.equal(result.routing_reason, 'within_d1_ultra');
  assert.equal(result.verdict, 'act');
});

test('a jev size-route error does not retry on d1', async () => {
  const { fetchImpl, calls } = scripted(url => {
    if (url === DECISIONS_URL) return jsonResponse(500, { error: { message: 'upstream', code: 500 } });
    if (url === CHAT_URL) {
      return jsonResponse(200, {
        id: 'gen-llm',
        choices: [{ message: { content: JSON.stringify({ answers: { waiting_on_external_reply: { type: 'noul', noul: 0.2 } } }) } }],
      });
    }
    return jsonResponse(200, { data: { id: 'gen-llm', total_cost: 0.001, provider_name: 'Infermatic', model: 'z-ai/glm-5.3', tokens_prompt: 4, tokens_completion: 2 } });
  });
  const result = await decide({
    ...base({ recordId: 'jdg_jev_error' }),
    fetchImpl,
    ledger: fakeLedger().ledger,
    config: { safetyMarginTokens: 0, primary: { contextTokens: 1 }, largeContext: { contextTokens: 5_000_000 } },
  });
  assert.equal(calls.filter(call => call.url === DECISIONS_URL).length, 1);
  assert.equal(JSON.parse(calls[0]?.body ?? '{}').model, JEV_REQUEST_MODEL);
  assert.equal(calls.some(call => call.body.includes(D1_ULTRA_REQUEST_MODEL)), false);
  assert.equal(result.provider_path, 'llm');
  assert.equal(result.routing_reason, 'size_over_d1_ultra');
});

test('decision code does not read the environment or the global fetch, and only the shadow worker imports it', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (path.endsWith('.ts')) out.push(path);
    }
    return out;
  }
  for (const file of walk('src/decision')) {
    const text = readFileSync(file, 'utf8');
    assert.equal(text.includes('globalThis.fetch'), false, file);
    assert.equal(text.includes('process.env'), false, file);
  }
  assert.equal(readFileSync('src/decision/sweep.ts', 'utf8').includes('openrouter'), false);
  assert.equal(readFileSync('src/decision/llm-fallback.ts', 'utf8').includes('node:fs'), false);
  assert.equal(readFileSync('src/decision/config.ts', 'utf8').includes('DECISION_LIVE_ENABLED = false'), true);
  const shadowPath = join('src', 'server', 'decision-shadow.ts');
  for (const file of walk('src')) {
    if (file.includes(`${sep}decision${sep}`)) continue;
    if (file === shadowPath) continue;
    assert.equal(readFileSync(file, 'utf8').includes('/decision/'), false, file);
  }
  const shadow = readFileSync(shadowPath, 'utf8');
  assert.equal(shadow.includes("mode: 'shadow'"), true);
  assert.equal(shadow.includes('live: false'), true);
  assert.equal(shadow.includes("mode: 'live'"), false);
});

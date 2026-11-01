import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { openLedger } from '../src/or-harness/ledger.ts';
import {
  chatOnce,
  defaultIds,
  DEFAULT_COST_DELAY_MS,
  DEFAULT_COST_RETRIES,
  dispatch,
  estimateMicroUsd,
  getGenerationCost,
  loadRoster,
  OpenRouterError,
  reservationMicroUsd,
  roundUsdToMicro,
  type FetchLike,
  type Ledger,
  type ReserveInput,
  type SettleInput,
} from '../src/or-harness/client.ts';

const KEY = 'test-key';
const MODEL = 'z-ai/glm-5.3-flash';
const originalFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async () => {
    throw new Error('unexpected network');
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

interface LedgerLog {
  reserve: ReserveInput[];
  pending: { reservation_id: string; reason: string; extra?: { generation_id?: string; provider_account?: string | null; model?: string } }[];
  settle: { reservation_id: string; actual: SettleInput }[];
  summary: string[];
}

function fakeLedger(result?: { ok: false; reason: string; remaining: number } | { ok: true; reservation_id: string }, summary: unknown = { remaining_micro_usd: 5_000_000 }): { ledger: Ledger; log: LedgerLog } {
  const log: LedgerLog = { reserve: [], pending: [], settle: [], summary: [] };
  const ledger: Ledger = {
    reserve(input) {
      log.reserve.push(input);
      return result ?? { ok: true, reservation_id: 'res-1' };
    },
    markPending(reservation_id, reason, extra) {
      log.pending.push({ reservation_id, reason, extra });
    },
    settle(reservation_id, actual) {
      log.settle.push({ reservation_id, actual });
    },
    summary(project) {
      log.summary.push(project);
      return summary;
    },
  };
  return { ledger, log };
}

interface Call { url: string; method: string; authOk: boolean; body: string }

function header(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers || headers instanceof Headers || Array.isArray(headers)) return null;
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find(item => item.toLowerCase() === name);
  return key ? record[key] ?? null : null;
}

function scripted(steps: Array<{ status: number; body: unknown } | { throw: true }>): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    const step = steps[index++];
    const auth = header(init, 'authorization');
    calls.push({
      url: String(input),
      method: init?.method ?? '',
      authOk: auth === `Bearer ${KEY}`,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    if (!step) throw new Error('unexpected fetch');
    if ('throw' in step) throw new Error('ECONNRESET');
    return new Response(JSON.stringify(step.body), { status: step.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

function assertQuiet(calls: Call[]): void {
  const blob = JSON.stringify(calls.map(call => ({ url: call.url, method: call.method, authOk: call.authOk })));
  assert.equal(blob.includes(KEY), false);
  assert.equal(blob.includes('Bearer'), false);
  assert.equal(blob.includes('Authorization'), false);
  assert.ok(calls.every(call => call.authOk));
}

const chatOk = {
  status: 200,
  body: {
    id: 'gen-ok',
    choices: [{ message: { role: 'assistant', content: 'hello from model' } }],
    usage: { prompt_tokens: 17, completion_tokens: 4, total_tokens: 21 },
  },
};

const costOk = {
  status: 200,
  body: {
    data: {
      id: 'gen-ok',
      total_cost: 0.0015,
      usage: 0.009,
      upstream_inference_cost: 0.001,
      provider_name: 'Infermatic',
      model: MODEL,
      tokens_prompt: 17,
      tokens_completion: 4,
    },
  },
};

test('loadRoster reads per-token prices for the flash model', () => {
  const roster = loadRoster();
  const row = roster.models.find(model => model.id === MODEL);
  assert.ok(row);
  assert.equal(row.price_usd_per_token.prompt, '0.00000015');
  assert.equal(row.price_usd_per_token.completion, '0.0000005');
  assert.equal(roster.snapshot_utc, '2026-10-23T17:30:00Z');
});

test('estimateMicroUsd ceils prompt tokens and fractional micro-USD', () => {
  // glm-5.3-flash: 150 nano prompt, 500 nano completion.
  // 0 chars → 16 prompt tokens → 2400 nano → ceil to 3 micro (round would be 2).
  assert.equal(estimateMicroUsd(MODEL, 0, 0), 3);
  // 3 chars → 17 prompt tokens; 10 completion → 17*150 + 10*500 = 7550 nano → 8 micro.
  assert.equal(estimateMicroUsd(MODEL, 3, 10), 8);
  // glm-5.3: 79 nano prompt, 1400 nano completion. 1 char → 17 tokens. 17*79+1400 = 2743 nano → 3.
  assert.equal(estimateMicroUsd('z-ai/glm-5.3', 1, 1), 3);
  assert.throws(() => estimateMicroUsd('deepseek/deepseek-v4.1-flash-1017', 1, 1), /model not in roster/);
});

test('reservation is 1.5x with at least 200 micro headroom', () => {
  assert.equal(reservationMicroUsd(0), 200);
  assert.equal(reservationMicroUsd(8), 208);
  assert.equal(reservationMicroUsd(400), 600);
  assert.equal(reservationMicroUsd(401), 602);
  assert.equal(reservationMicroUsd(1000), 1500);
  assert.equal(roundUsdToMicro(0.0015), 1500);
  assert.equal(roundUsdToMicro(0.0000015), 2);
});

test('default run and attempt ids are a deterministic hash prefix', () => {
  const prompt = 'same prompt';
  const first = defaultIds(MODEL, 'test', prompt);
  const second = defaultIds(MODEL, 'test', prompt);
  const hex = createHash('sha256').update(`${MODEL}|test|${prompt}`).digest('hex').slice(0, 12);
  assert.deepEqual(first, second);
  assert.equal(first.run_id, `run-${hex}`);
  assert.equal(first.attempt_id, `${first.run_id}-a1`);
  assert.notEqual(defaultIds(MODEL, 'test', 'other').run_id, first.run_id);
});

test('deny path reserves and does not call the provider', async () => {
  const { ledger, log } = fakeLedger({ ok: false, reason: 'cap', remaining: 10 });
  const { fetchImpl, calls } = scripted([]);
  const report = await dispatch({
    model: MODEL, project: 'test', prompt: 'hi', maxTokens: 50, ledger, fetchImpl, apiKey: KEY, costDelayMs: 0,
  });
  assert.equal(calls.length, 0);
  assert.equal(log.reserve.length, 1);
  assert.equal(log.pending.length, 0);
  assert.equal(log.settle.length, 0);
  assert.equal(report.state, 'denied');
  assert.equal(report.reason, 'cap');
  assert.equal(report.remaining, 10);
  assert.equal(report.generation_id, null);
  assert.equal(log.reserve[0]?.est_micro_usd, reservationMicroUsd(estimateMicroUsd(MODEL, 2, 50)));
  assert.equal(log.reserve[0]?.run_id, report.run_id);
  assert.equal(log.reserve[0]?.attempt_id, `${report.run_id}-a1`);
  assert.equal(log.reserve[0]?.pricing_snapshot.price_usd_per_token.prompt, '0.00000015');
});

test('explicit ids are kept and repeated inputs stay idempotent', async () => {
  const prompt = 'idempotent prompt';
  const first = fakeLedger({ ok: false, reason: 'cap', remaining: 0 });
  const second = fakeLedger({ ok: false, reason: 'cap', remaining: 0 });
  const fetchImpl: FetchLike = async () => { throw new Error('unexpected network'); };
  const a = await dispatch({ model: MODEL, project: 'test', prompt, maxTokens: 4, ledger: first.ledger, fetchImpl, apiKey: KEY });
  const b = await dispatch({ model: MODEL, project: 'test', prompt, maxTokens: 4, ledger: second.ledger, fetchImpl, apiKey: KEY });
  assert.equal(a.run_id, b.run_id);
  assert.equal(a.attempt_id, b.attempt_id);
  assert.equal(a.run_id, defaultIds(MODEL, 'test', prompt).run_id);
  const custom = fakeLedger({ ok: false, reason: 'cap', remaining: 1 });
  const report = await dispatch({
    model: MODEL, project: 'test', prompt, maxTokens: 4, run_id: 'run-fixed', attempt_id: 'run-fixed-a2',
    ledger: custom.ledger, fetchImpl, apiKey: KEY,
  });
  assert.equal(report.run_id, 'run-fixed');
  assert.equal(report.attempt_id, 'run-fixed-a2');
  assert.equal(custom.log.reserve[0]?.attempt_id, 'run-fixed-a2');
});

test('unknown model rejects before reserve or fetch', async () => {
  const { ledger, log } = fakeLedger();
  const { fetchImpl, calls } = scripted([]);
  await assert.rejects(
    () => dispatch({ model: 'not/a-model', project: 'test', prompt: 'x', maxTokens: 10, ledger, fetchImpl, apiKey: KEY }),
    /model not in roster/,
  );
  assert.equal(log.reserve.length, 0);
  assert.equal(calls.length, 0);
});

test('chatOnce posts one completion and aborts on timeout', async () => {
  const seen: { signal: boolean; body: string } = { signal: false, body: '' };
  const fetchImpl: FetchLike = async (input, init) => {
    seen.signal = init?.signal instanceof AbortSignal;
    seen.body = String(init?.body ?? '');
    assert.equal(String(input), 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(init?.method, 'POST');
    assert.equal(header(init, 'authorization') === `Bearer ${KEY}`, true);
    return new Response(JSON.stringify(chatOk.body), { status: 200 });
  };
  const result = await chatOnce({ model: MODEL, prompt: 'hi', maxTokens: 50, timeoutMs: 1_000, fetchImpl, apiKey: KEY });
  assert.equal(result.generation_id, 'gen-ok');
  assert.equal(result.text, 'hello from model');
  assert.equal(result.usage.total_tokens, 21);
  assert.equal(seen.signal, true);
  assert.deepEqual(JSON.parse(seen.body), { model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 });

  const hanging: FetchLike = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  await assert.rejects(
    () => chatOnce({ model: MODEL, prompt: 'hi', maxTokens: 5, timeoutMs: 20, fetchImpl: hanging, apiKey: KEY }),
    (error: unknown) => error instanceof OpenRouterError && error.reason === 'timeout' && !error.retryable,
  );
});

test('dispatch retains the hold after one uncertain POST instead of retrying into success', async () => {
  const { fetchImpl, calls } = scripted([{ throw: true }, { throw: true }, chatOk, costOk]);
  const { ledger, log } = fakeLedger();
  const report = await dispatch({
    model: MODEL, project: 'test', prompt: 'retry me', maxTokens: 50,
    ledger, fetchImpl, apiKey: KEY, timeoutMs: 1_000, costRetries: 1, costDelayMs: 0,
  });
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(calls.filter(call => call.method === 'GET').length, 0);
  assert.equal(log.reserve.length, 1);
  assert.equal(log.pending.length, 1);
  assert.equal(log.pending[0]?.reason, 'transport');
  assert.equal(log.settle.length, 0);
  assert.equal(report.state, 'pending_actual');
  assert.equal(report.generation_id, null);
  assert.equal(report.micro_usd, null);
  assertQuiet(calls);

  const exhausted = scripted([{ throw: true }, { throw: true }, { throw: true }, chatOk]);
  const held = fakeLedger();
  const pending = await dispatch({
    model: MODEL, project: 'test', prompt: 'give up', maxTokens: 10,
    ledger: held.ledger, fetchImpl: exhausted.fetchImpl, apiKey: KEY, timeoutMs: 1_000, costDelayMs: 0,
  });
  assert.equal(exhausted.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(exhausted.calls.filter(call => call.method === 'GET').length, 0);
  assert.equal(held.log.pending.length, 1);
  assert.equal(held.log.pending[0]?.reason, 'transport');
  assert.equal(held.log.settle.length, 0);
  assert.equal(pending.state, 'pending_actual');
  assert.equal(pending.reservation_id, 'res-1');
});

test('4xx is not retried and a generation id blocks a second provider call', async () => {
  const denied = scripted([{ status: 400, body: { error: { message: 'bad' } } }, chatOk]);
  const { ledger, log } = fakeLedger();
  const report = await dispatch({
    model: MODEL, project: 'test', prompt: 'bad request', maxTokens: 8,
    ledger, fetchImpl: denied.fetchImpl, apiKey: KEY, timeoutMs: 1_000, costDelayMs: 0,
  });
  assert.equal(denied.calls.length, 1);
  assert.equal(log.pending[0]?.reason, 'http_400');
  assert.equal(log.settle.length, 0);
  assert.equal(report.state, 'pending_actual');

  const limited = scripted([{ status: 429, body: { error: 'slow' } }, chatOk]);
  const limitLedger = fakeLedger();
  await dispatch({
    model: MODEL, project: 'test', prompt: 'rate', maxTokens: 8,
    ledger: limitLedger.ledger, fetchImpl: limited.fetchImpl, apiKey: KEY, timeoutMs: 1_000, costDelayMs: 0,
  });
  assert.equal(limited.calls.length, 1);
  assert.equal(limitLedger.log.pending[0]?.reason, 'http_429');

  const identified = scripted([
    { status: 502, body: { id: 'gen-late', choices: [{ message: { content: 'partial' } }] } },
    costOk,
  ]);
  const late = fakeLedger();
  const settled = await dispatch({
    model: MODEL, project: 'test', prompt: 'late id', maxTokens: 8,
    ledger: late.ledger, fetchImpl: identified.fetchImpl, apiKey: KEY, timeoutMs: 1_000, costRetries: 1, costDelayMs: 0,
  });
  assert.equal(identified.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(identified.calls[1]?.url, 'https://openrouter.ai/api/v1/generation?id=gen-late');
  assert.equal(settled.generation_id, 'gen-late');
  assert.equal(settled.text, 'partial');
  assert.equal(settled.state, 'settled');
  assert.equal(late.log.settle.length, 1);
  assert.equal(late.log.pending.length, 0);
});

test('successful generation cost settles total_cost and ignores upstream cost', async () => {
  const { fetchImpl, calls } = scripted([chatOk, costOk]);
  const { ledger, log } = fakeLedger(undefined, { project: 'test', remaining_micro_usd: 4_000_000 });
  const report = await dispatch({
    model: MODEL, project: 'test', prompt: 'bill me', maxTokens: 50,
    ledger, fetchImpl, apiKey: KEY, timeoutMs: 1_000, costRetries: 3, costDelayMs: 0,
  });
  assert.equal(report.state, 'settled');
  assert.equal(report.micro_usd, 1500);
  assert.equal(report.cost_field, 'total_cost');
  assert.equal(report.text, 'hello from model');
  assert.equal(log.settle.length, 1);
  assert.equal(log.pending.length, 0);
  const actual = log.settle[0]?.actual;
  assert.equal(actual?.generation_id, 'gen-ok');
  assert.equal(actual?.micro_usd, 1500);
  assert.equal(actual?.cost_field, 'total_cost');
  assert.equal(actual?.provider_account, 'Infermatic');
  assert.equal(actual?.model, MODEL);
  assert.deepEqual(actual?.tokens, { prompt: 17, completion: 4, total: 21 });
  assert.deepEqual(report.summary, { project: 'test', remaining_micro_usd: 4_000_000 });
  assertQuiet(calls);
});

test('getGenerationCost falls back to usage, prefers zero total_cost, and returns null when missing', async () => {
  const usageOnly = scripted([{
    status: 200,
    body: { data: { usage: 0.0000015, upstream_inference_cost: 0.004, provider_name: 'DeepInfra', tokens_prompt: 2, tokens_completion: 3, model: MODEL } },
  }]);
  const usage = await getGenerationCost('gen-u', { fetchImpl: usageOnly.fetchImpl, apiKey: KEY, retries: 3, delayMs: 0 });
  assert.equal(usage?.micro_usd, 2);
  assert.equal(usage?.cost_field, 'usage');
  assert.equal(usage?.provider_name, 'DeepInfra');
  assert.deepEqual(usage?.tokens, { prompt: 2, completion: 3, total: 5 });

  const zero = scripted([{ status: 200, body: { data: { total_cost: 0, usage: 0.01, provider_name: 'P', tokens_prompt: 1, tokens_completion: 1 } } }]);
  const zeroCost = await getGenerationCost('gen-z', { fetchImpl: zero.fetchImpl, apiKey: KEY, retries: 2, delayMs: 0 });
  assert.equal(zeroCost?.micro_usd, 0);
  assert.equal(zeroCost?.cost_field, 'total_cost');

  let hits = 0;
  const flaky: FetchLike = async () => {
    hits += 1;
    if (hits < 3) return new Response('', { status: 404 });
    return new Response(JSON.stringify({ data: { total_cost: 0.002, provider_name: 'P', tokens_prompt: 1, tokens_completion: 1 } }), { status: 200 });
  };
  const recovered = await getGenerationCost('gen-r', { fetchImpl: flaky, apiKey: KEY, retries: 6, delayMs: 0 });
  assert.equal(recovered?.micro_usd, 2000);
  assert.equal(hits, 3);

  const missing = scripted([
    { status: 404, body: { error: 'not yet' } },
    { status: 200, body: { data: { id: 'gen-m' } } },
    { status: 404, body: {} },
  ]);
  const absent = await getGenerationCost('gen-m', { fetchImpl: missing.fetchImpl, apiKey: KEY, retries: 3, delayMs: 0 });
  assert.equal(absent, null);
  assert.equal(missing.calls.length, 3);
  assert.ok(missing.calls.every(call => call.url === 'https://openrouter.ai/api/v1/generation?id=gen-m' && call.method === 'GET'));
});

test('cost lookup null marks the hold pending and does not call the provider again', async () => {
  const { fetchImpl, calls } = scripted([
    chatOk,
    { status: 404, body: { error: 'missing' } },
    { status: 404, body: { error: 'missing' } },
  ]);
  const { ledger, log } = fakeLedger();
  const logs: string[] = [];
  const previous = console.log;
  console.log = (...parts: unknown[]) => { logs.push(parts.map(part => String(part)).join(' ')); };
  try {
    const report = await dispatch({
      model: MODEL, project: 'test', prompt: 'where is the cost', maxTokens: 20,
      ledger, fetchImpl, apiKey: KEY, timeoutMs: 1_000, costRetries: 2, costDelayMs: 0,
    });
    assert.equal(report.state, 'pending_actual');
    assert.equal(report.reason, 'cost_unknown');
    assert.equal(report.generation_id, 'gen-ok');
    assert.equal(report.micro_usd, null);
    assert.equal(report.text, 'hello from model');
  } finally {
    console.log = previous;
  }
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(calls.filter(call => call.method === 'GET').length, 2);
  assert.equal(log.settle.length, 0);
  assert.equal(log.pending.length, 1);
  assert.equal(log.pending[0]?.reservation_id, 'res-1');
  assert.equal(log.pending[0]?.reason, 'cost_unknown');
  assert.deepEqual(log.pending[0]?.extra, { generation_id: 'gen-ok', model: MODEL });
  assert.equal(logs.length, 0);
  assertQuiet(calls);
});

test('getGenerationCost defaults to 10 attempts and a 2000ms delay', async () => {
  assert.equal(DEFAULT_COST_RETRIES, 10);
  assert.equal(DEFAULT_COST_DELAY_MS, 2_000);
  let hits = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    hits += 1;
    assert.equal(String(input), 'https://openrouter.ai/api/v1/generation?id=gen-default');
    assert.equal(init?.method, 'GET');
    assert.equal(header(init, 'authorization') === `Bearer ${KEY}`, true);
    return new Response('', { status: 404 });
  };
  const absent = await getGenerationCost('gen-default', { fetchImpl, apiKey: KEY, delayMs: 0 });
  assert.equal(absent, null);
  assert.equal(hits, 10);
});

test('dry-run estimates and checks remaining without reserve or network', async () => {
  const { ledger, log } = fakeLedger(undefined, { remaining_micro_usd: 100 });
  const { fetchImpl, calls } = scripted([chatOk]);
  const report = await dispatch({
    model: MODEL, project: 'test', prompt: 'plan only', maxTokens: 50, ledger, fetchImpl, dryRun: true,
  });
  assert.equal(calls.length, 0);
  assert.equal(log.reserve.length, 0);
  assert.equal(log.pending.length, 0);
  assert.equal(report.state, 'dry_run');
  assert.equal(report.estimate_micro_usd, estimateMicroUsd(MODEL, 'plan only'.length, 50));
  assert.equal(report.reserve_micro_usd, reservationMicroUsd(report.estimate_micro_usd));
  assert.equal(report.micro_usd, report.estimate_micro_usd);
  assert.equal(report.reservation_ok, false);
  assert.equal(report.generation_id, null);

  const open = fakeLedger(undefined, { remaining_micro_usd: 9_000_000 });
  const allowed = await dispatch({
    model: MODEL, project: 'test', prompt: 'plan only', maxTokens: 50, ledger: open.ledger, fetchImpl, dryRun: true,
  });
  assert.equal(allowed.reservation_ok, true);
  assert.equal(open.log.reserve.length, 0);
});

test('real ledger records a settled cost and a cost_unknown hold', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'or-client-'));
  const ledger = openLedger(join(dir, 'ledger.json'));
  try {
    const settledFetch = scripted([chatOk, costOk]);
    const settled = await dispatch({
      model: MODEL, project: 'test', prompt: 'ledger settle', maxTokens: 20,
      ledger, fetchImpl: settledFetch.fetchImpl, apiKey: KEY, timeoutMs: 1_000, costRetries: 1, costDelayMs: 0,
    });
    assert.equal(settled.state, 'settled');
    assert.equal(settled.micro_usd, 1500);
    assert.equal(settled.cost_field, 'total_cost');
    const afterSettle = await ledger.summary('test');
    assert.equal(afterSettle.spent, 1500);
    assert.equal(afterSettle.held, 0);

    const missingFetch = scripted([
      chatOk,
      { status: 404, body: { error: 'missing' } },
      { status: 404, body: { error: 'missing' } },
    ]);
    const pending = await dispatch({
      model: MODEL, project: 'test', prompt: 'ledger pending', maxTokens: 20,
      ledger, fetchImpl: missingFetch.fetchImpl, apiKey: KEY, timeoutMs: 1_000, costRetries: 2, costDelayMs: 0,
    });
    assert.equal(pending.reason, 'cost_unknown');
    assert.equal(pending.state, 'pending_actual');
    assert.equal(pending.generation_id, 'gen-ok');
    assert.equal(missingFetch.calls.filter(call => call.method === 'POST').length, 1);
    const stored = JSON.parse(await readFile(join(dir, 'ledger.json'), 'utf8')) as {
      rows: Array<{ kind: string; state?: string; generation_id?: string | null }>;
    };
    const pendingRow = stored.rows.find(row => row.kind === 'reservation' && row.state === 'pending_actual');
    assert.equal(pendingRow?.generation_id, 'gen-ok');
    const afterPending = await ledger.summary('test');
    assert.equal(afterPending.spent, 1500);
    assert.equal(afterPending.held, pending.reserve_micro_usd);
    assert.equal(afterPending.remaining, afterPending.cap - 1500 - pending.reserve_micro_usd);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

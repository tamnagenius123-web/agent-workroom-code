import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import {
  chatOnce, dispatch, OpenRouterError, settlePending,
  type FetchLike, type Ledger, type PendingMark, type SettleInput,
} from '../src/or-harness/client.ts';
import { openLedger } from '../src/or-harness/ledger.ts';

const MODEL = 'z-ai/glm-5.3-flash';
const KEY = 'synthetic-offline-fixture';
const originalFetch = globalThis.fetch;
before(() => { globalThis.fetch = async () => { throw new Error('unexpected external fetch'); }; });
after(() => { globalThis.fetch = originalFetch; });

function fixture() {
  const pending: { id: string; reason: string; extra?: PendingMark }[] = [];
  const actual: SettleInput[] = [];
  let reserves = 0;
  const ledger: Ledger = {
    reserve() { reserves++; return { ok: true, reservation_id: 'held-fixture' }; },
    markPending(id, reason, extra) { pending.push({ id, reason, extra }); },
    settle(_id, cost) { actual.push(cost); },
    summary() { return { held: 10_000, remaining: 20_000 }; },
  };
  return { ledger, pending, actual, reserves: () => reserves };
}
const input = { model: MODEL, project: 'test', prompt: 'offline acceptance fixture', maxTokens: 8,
  run_id: 'run-fixture', attempt_id: 'run-fixture-a1', apiKey: KEY, timeoutMs: 30, costRetries: 3, costDelayMs: 0 };

test('invisible provider acceptance then transport loss sends one POST and retains unknown cost', async () => {
  const f = fixture(); let accepted = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    assert.equal(init?.method, 'POST'); accepted++;
    throw new TypeError('fixture: response lost after provider accepted');
  };
  const report = await dispatch({ ...input, ledger: f.ledger, fetchImpl });
  assert.equal(accepted, 1);
  assert.equal(f.reserves(), 1); assert.equal(f.pending.length, 1); assert.equal(f.actual.length, 0);
  assert.equal(report.state, 'pending_actual'); assert.equal(report.reason, 'transport');
  assert.equal(report.generation_id, null); assert.equal(report.micro_usd, null); assert.equal(report.cost_field, null);
  assert.equal(report.reservation_id, 'held-fixture'); assert.equal(report.usage, null);
});

test('first POST accepted invisibly then deadline AbortError never resends', async () => {
  const f = fixture(); let accepted = 0; let aborts = 0;
  const fetchImpl: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
    assert.equal(init?.method, 'POST'); accepted++;
    init!.signal!.addEventListener('abort', () => { aborts++; reject(new DOMException('fixture cancelled response', 'AbortError')); }, { once: true });
  });
  const report = await dispatch({ ...input, ledger: f.ledger, fetchImpl, timeoutMs: 5 });
  assert.equal(accepted, 1); assert.equal(aborts, 1);
  assert.equal(report.state, 'pending_actual'); assert.equal(report.reason, 'timeout');
  assert.equal(report.micro_usd, null); assert.equal(report.generation_id, null); assert.equal(f.actual.length, 0);
  assert.equal(f.pending[0]?.reason, 'timeout');
});

test('chat errors never advertise POST retry, including abort and unidentifiable 5xx', async () => {
  for (const errorName of ['AbortError', 'TimeoutError', 'TypeError']) {
    const fetchImpl: FetchLike = async () => { const error = new Error('fixture'); error.name = errorName; throw error; };
    await assert.rejects(() => chatOnce({ ...input, fetchImpl }),
      (error: unknown) => error instanceof OpenRouterError && !error.retryable
        && error.reason === (errorName === 'TypeError' ? 'transport' : 'timeout'));
  }
  await assert.rejects(() => chatOnce({ ...input, fetchImpl: async () => Response.json({ error: 'unknown acceptance' }, { status: 502 }) }),
    (error: unknown) => error instanceof OpenRouterError && error.reason === 'http_502' && !error.retryable && error.generation_id === null);
});

test('body-read cancellation after headers is uncertain and never retries chat', async () => {
  const f = fixture(); let posts = 0;
  const fetchImpl: FetchLike = async () => {
    posts++;
    const response = new Response();
    response.text = async () => { throw new DOMException('fixture body cancelled', 'AbortError'); };
    return response;
  };
  const report = await dispatch({ ...input, ledger: f.ledger, fetchImpl });
  assert.equal(posts, 1); assert.equal(report.state, 'pending_actual'); assert.equal(report.reason, 'timeout');
  assert.equal(report.micro_usd, null); assert.equal(f.actual.length, 0);
});

test('unidentified server failure is pending after exactly one chat', async () => {
  const f = fixture(); let posts = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    assert.equal(init?.method, 'POST'); posts++;
    return Response.json({ error: 'fixture response without generation id' }, { status: 503 });
  };
  const report = await dispatch({ ...input, ledger: f.ledger, fetchImpl });
  assert.equal(posts, 1); assert.equal(report.state, 'pending_actual'); assert.equal(report.reason, 'http_503');
  assert.equal(report.micro_usd, null); assert.equal(f.actual.length, 0);
});

test('known generation on 502 permits only safe GET polling and measured settlement', async () => {
  const f = fixture(); const methods: string[] = []; let gets = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    methods.push(init!.method!);
    if (init?.method === 'POST') return Response.json({ id: 'gen-known', choices: [{ message: { content: 'partial fixture' } }] }, { status: 502 });
    assert.equal(String(url), 'https://openrouter.ai/api/v1/generation?id=gen-known'); gets++;
    if (gets === 1) return new Response(null, { status: 500 });
    if (gets === 2) return new Response(null, { status: 404 });
    return Response.json({ data: { id: 'gen-known', total_cost: 0.000021, model: MODEL } });
  };
  const report = await dispatch({ ...input, ledger: f.ledger, fetchImpl });
  assert.deepEqual(methods, ['POST', 'GET', 'GET', 'GET']);
  assert.equal(report.state, 'settled'); assert.equal(report.generation_id, 'gen-known'); assert.equal(report.text, 'partial fixture');
  assert.equal(report.micro_usd, 21); assert.equal(f.actual.length, 1); assert.equal(f.pending.length, 0);
});

test('unknown hold survives ledger reopen and GET-only recovery skips missing generation id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'or-unknown-'));
  try {
    const path = join(dir, 'ledger.json'); const ledger = openLedger(path); let posts = 0;
    const report = await dispatch({ ...input, ledger, fetchImpl: async () => { posts++; throw new TypeError('fixture accepted then disconnected'); } });
    assert.equal(posts, 1); assert.equal(report.state, 'pending_actual');
    const reopened = openLedger(path); const before = await reopened.summary('test');
    const recovery = await settlePending({ ledger: reopened, apiKey: KEY, fetchImpl: async () => { throw new Error('unknown id must not be looked up or resent'); } });
    assert.equal(recovery.settled, 0); assert.equal(recovery.checked, 0);
    assert.deepEqual(await reopened.summary('test'), before);
    assert.equal(before.spent, 0); assert.equal(before.held, report.reserve_micro_usd); assert.ok(before.held > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pending persistence failure propagates without another physical POST', async () => {
  const f = fixture(); let posts = 0;
  f.ledger.markPending = () => { throw new Error('fixture ledger unavailable'); };
  await assert.rejects(() => dispatch({ ...input, ledger: f.ledger, fetchImpl: async () => { posts++; throw new TypeError('fixture accepted'); } }), /fixture ledger unavailable/);
  assert.equal(posts, 1); assert.equal(f.reserves(), 1); assert.equal(f.actual.length, 0);
});

test('concurrent distinct invocations retain separate uncertain holds with one POST each', async () => {
  const a = fixture(), b = fixture(); let posts = 0;
  const fetchImpl: FetchLike = async () => { posts++; await Promise.resolve(); throw new TypeError('fixture acceptance hidden'); };
  const reports = await Promise.all([
    dispatch({ ...input, ledger: a.ledger, fetchImpl }),
    dispatch({ ...input, attempt_id: 'run-fixture-a2', ledger: b.ledger, fetchImpl }),
  ]);
  assert.equal(posts, 2); assert.ok(reports.every(r => r.state === 'pending_actual' && r.micro_usd === null));
  assert.equal(a.pending.length, 1); assert.equal(b.pending.length, 1);
});

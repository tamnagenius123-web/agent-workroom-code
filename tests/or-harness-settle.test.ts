import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { main } from '../scripts/or-call.ts';
import {
  dispatch,
  settlePending,
  type FetchLike,
} from '../src/or-harness/client.ts';
import { openLedger, type Ledger } from '../src/or-harness/ledger.ts';

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

interface Call { url: string; method: string; authOk: boolean }

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
    });
    if (!step) throw new Error('unexpected fetch');
    if ('throw' in step) throw new Error('ECONNRESET');
    return new Response(JSON.stringify(step.body), { status: step.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

function assertGenerationOnly(calls: Call[]): void {
  const blob = JSON.stringify(calls);
  assert.equal(blob.includes(KEY), false);
  assert.equal(blob.includes('Bearer'), false);
  assert.equal(blob.includes('Authorization'), false);
  assert.ok(calls.every(call => call.authOk));
  assert.ok(calls.every(call => call.method === 'GET' && call.url.startsWith('https://openrouter.ai/api/v1/generation?id=')));
  assert.equal(calls.some(call => call.url.includes('chat/completions')), false);
}

function tempLedger(): { ledger: Ledger; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'or-settle-'));
  const path = join(dir, 'ledger.json');
  return {
    ledger: openLedger(path),
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

interface StoredDoc {
  rows: Array<{
    kind: string;
    state?: string;
    generation_id?: string | null;
    reservation_id?: string;
    provider_account?: string | null;
    micro_usd?: number;
  }>;
}

function readDoc(path: string): StoredDoc {
  return JSON.parse(readFileSync(path, 'utf8')) as StoredDoc;
}

const costBody = {
  data: {
    id: 'gen-settle-1',
    total_cost: 0.0015,
    usage: 0.009,
    upstream_inference_cost: 0.004,
    provider_name: 'Infermatic',
    model: MODEL,
    tokens_prompt: 3,
    tokens_completion: 4,
  },
};

test('a late /generation cost settles the hold that kept its generation id', async () => {
  const { ledger, path, cleanup } = tempLedger();
  try {
    const chat = {
      status: 200,
      body: {
        id: 'gen-settle-1',
        choices: [{ message: { content: 'later' } }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      },
    };
    const missing = scripted([chat, { status: 500, body: { error: 'later' } }, { status: 500, body: { error: 'later' } }]);
    const pending = await dispatch({
      model: MODEL,
      project: 'test',
      prompt: 'cost arrives later',
      maxTokens: 20,
      ledger,
      fetchImpl: missing.fetchImpl,
      apiKey: KEY,
      timeoutMs: 1_000,
      costRetries: 2,
      costDelayMs: 0,
    });
    assert.equal(pending.state, 'pending_actual');
    assert.equal(pending.reason, 'cost_http_500');
    assert.equal(pending.generation_id, 'gen-settle-1');
    assert.equal(missing.calls.filter(call => call.method === 'POST').length, 1);
    const held = readDoc(path).rows.find(row => row.kind === 'reservation' && row.state === 'pending_actual');
    assert.equal(held?.generation_id, 'gen-settle-1');
    assert.equal((await ledger.summary('test')).held, pending.reserve_micro_usd);
    assert.equal((await ledger.summary('test')).spent, 0);

    const visible = scripted([{ status: 200, body: costBody }]);
    const report = await settlePending({
      ledger,
      fetchImpl: visible.fetchImpl,
      apiKey: KEY,
      costRetries: 1,
      costDelayMs: 0,
    });
    assert.equal(report.mode, 'settle-pending');
    assert.equal(report.checked, 1);
    assert.equal(report.settled, 1);
    assert.equal(report.still_pending, 0);
    assert.equal(report.results[0]?.state, 'settled');
    assert.equal(report.results[0]?.micro_usd, 1500);
    assert.equal(report.results[0]?.cost_field, 'total_cost');
    assert.equal(report.results[0]?.generation_id, 'gen-settle-1');
    assertGenerationOnly(visible.calls);
    const summary = await ledger.summary('test');
    assert.equal(summary.spent, 1500);
    assert.equal(summary.held, 0);
    const actual = readDoc(path).rows.find(row => row.kind === 'actual');
    assert.equal(actual?.generation_id, 'gen-settle-1');
    assert.equal(actual?.provider_account, 'Infermatic');
    assert.equal(actual?.micro_usd, 1500);
    const again = await settlePending({
      ledger,
      fetchImpl: scripted([]).fetchImpl,
      apiKey: KEY,
      costRetries: 1,
      costDelayMs: 0,
    });
    assert.equal(again.checked, 0);
    assert.equal((await ledger.summary('test')).spent, 1500);
  } finally {
    cleanup();
  }
});

test('settle-pending leaves the hold when cost is still missing and skips holds with no id', async () => {
  const { ledger, path, cleanup } = tempLedger();
  try {
    const hidden = await ledger.reserve({
      project: 'test',
      run_id: 'run-hide',
      attempt_id: 'run-hide-a1',
      model: MODEL,
      est_micro_usd: 80_000,
      pricing_snapshot: { model: MODEL },
    });
    const bare = await ledger.reserve({
      project: 'test',
      run_id: 'run-bare',
      attempt_id: 'run-bare-a1',
      model: MODEL,
      est_micro_usd: 20_000,
      pricing_snapshot: { model: MODEL },
    });
    assert.equal(hidden.ok, true);
    assert.equal(bare.ok, true);
    if (!hidden.ok || !bare.ok) throw new Error('unreachable');
    await ledger.markPending(hidden.reservation_id, 'cost_unknown', { generation_id: 'gen-hide', model: MODEL });
    await ledger.markPending(bare.reservation_id, 'timeout');

    const missing = scripted([{ status: 404, body: {} }, { status: 404, body: {} }]);
    const report = await settlePending({
      ledger,
      fetchImpl: missing.fetchImpl,
      apiKey: KEY,
      costRetries: 2,
      costDelayMs: 0,
    });
    assert.equal(report.checked, 1);
    assert.equal(report.settled, 0);
    assert.equal(report.still_pending, 1);
    assert.equal(report.results[0]?.reason, 'cost_unknown');
    assert.equal(report.results[0]?.state, 'pending_actual');
    assert.equal(report.results[0]?.generation_id, 'gen-hide');
    assert.deepEqual(missing.calls.map(call => call.url), [
      'https://openrouter.ai/api/v1/generation?id=gen-hide',
      'https://openrouter.ai/api/v1/generation?id=gen-hide',
    ]);
    assertGenerationOnly(missing.calls);
    const summary = await ledger.summary('test');
    assert.equal(summary.spent, 0);
    assert.equal(summary.held, 100_000);
    assert.equal(readDoc(path).rows.some(row => row.kind === 'actual'), false);
    assert.equal(readDoc(path).rows.find(row => row.generation_id === 'gen-hide')?.state, 'pending_actual');
  } finally {
    cleanup();
  }
});

test('settle-pending settles an unknown hold and keeps a still-hidden sibling', async () => {
  const { ledger, path, cleanup } = tempLedger();
  try {
    const known = await ledger.reserve({
      project: 'test',
      run_id: 'run-known',
      attempt_id: 'run-known-a1',
      model: MODEL,
      est_micro_usd: 50_000,
      pricing_snapshot: { model: MODEL },
    });
    const waiting = await ledger.reserve({
      project: 'test',
      run_id: 'run-wait',
      attempt_id: 'run-wait-a1',
      model: MODEL,
      est_micro_usd: 30_000,
      pricing_snapshot: { model: MODEL },
    });
    assert.equal(known.ok && waiting.ok, true);
    if (!known.ok || !waiting.ok) throw new Error('unreachable');
    await ledger.markPending(known.reservation_id, 'cost_unknown', {
      generation_id: 'gen-known',
      provider_account: 'stored-account',
      model: MODEL,
    });
    await ledger.markPending(waiting.reservation_id, 'cost_unknown', { generation_id: 'gen-wait', model: MODEL });
    const doc = readDoc(path);
    const knownRow = doc.rows.find(row => row.reservation_id === known.reservation_id);
    if (!knownRow) throw new Error('missing hold');
    knownRow.state = 'unknown';
    writeFileSync(path, JSON.stringify(doc));

    const calls = scripted([
      {
        status: 200,
        body: {
          data: {
            total_cost: 0.000002,
            usage: 0.01,
            upstream_inference_cost: 0.009,
            model: MODEL,
            tokens_prompt: 1,
            tokens_completion: 1,
          },
        },
      },
      { status: 404, body: { error: 'not yet' } },
    ]);
    const report = await settlePending({
      ledger,
      fetchImpl: calls.fetchImpl,
      apiKey: KEY,
      costRetries: 1,
      costDelayMs: 0,
    });
    assert.deepEqual(report.results.map(row => ({ id: row.generation_id, state: row.state, micro_usd: row.micro_usd })), [
      { id: 'gen-known', state: 'settled', micro_usd: 2 },
      { id: 'gen-wait', state: 'pending_actual', micro_usd: null },
    ]);
    assert.equal(report.settled, 1);
    assert.equal(report.still_pending, 1);
    assertGenerationOnly(calls.calls);
    const summary = await ledger.summary('test');
    assert.equal(summary.spent, 2);
    assert.equal(summary.held, 30_000);
    const actual = readDoc(path).rows.find(row => row.kind === 'actual');
    assert.equal(actual?.provider_account, 'stored-account');
    assert.equal(actual?.generation_id, 'gen-known');
    assert.equal(readDoc(path).rows.find(row => row.generation_id === 'gen-wait')?.state, 'pending_actual');
  } finally {
    cleanup();
  }
});

test('a generation lookup error does not release the hold or call chat', async () => {
  const { ledger, cleanup } = tempLedger();
  try {
    const reserved = await ledger.reserve({
      project: 'test',
      run_id: 'run-err',
      attempt_id: 'run-err-a1',
      model: MODEL,
      est_micro_usd: 15_000,
      pricing_snapshot: { model: MODEL },
    });
    assert.equal(reserved.ok, true);
    if (!reserved.ok) throw new Error('unreachable');
    await ledger.markPending(reserved.reservation_id, 'cost_unknown', { generation_id: 'gen-err', model: MODEL });
    const denied = scripted([{ status: 400, body: { error: 'bad id' } }]);
    const report = await settlePending({
      ledger,
      fetchImpl: denied.fetchImpl,
      apiKey: KEY,
      costRetries: 4,
      costDelayMs: 0,
    });
    assert.equal(denied.calls.length, 1);
    assert.equal(report.still_pending, 1);
    assert.equal(report.results[0]?.reason, 'cost_http_400');
    assert.equal((await ledger.summary('test')).held, 15_000);
    assert.equal((await ledger.summary('test')).spent, 0);
    assertGenerationOnly(denied.calls);

    const dropped = scripted([{ throw: true }, { throw: true }]);
    const again = await settlePending({
      ledger,
      fetchImpl: dropped.fetchImpl,
      apiKey: KEY,
      costRetries: 2,
      costDelayMs: 0,
    });
    assert.equal(again.results[0]?.reason, 'cost_transport');
    assert.equal(dropped.calls.length, 2);
    assert.equal((await ledger.summary('test')).held, 15_000);
    assertGenerationOnly(dropped.calls);
  } finally {
    cleanup();
  }
});

test('cli --settle-pending settles from /generation and does not require a prompt', async () => {
  const { ledger, path, cleanup } = tempLedger();
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousExit = process.exitCode;
  const previousWrite = process.stdout.write;
  const chunks: string[] = [];
  process.env.OPENROUTER_API_KEY = KEY;
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), callback?: (err?: Error | null) => void) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return previousWrite.call(process.stdout, chunk, encoding as BufferEncoding, callback);
  }) as typeof process.stdout.write;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const auth = header(init, 'authorization');
    calls.push({ url: String(input), method: init?.method ?? '', authOk: auth === `Bearer ${KEY}` });
    return new Response(JSON.stringify({
      data: { total_cost: 0.0015, provider_name: 'Infermatic', model: MODEL, tokens_prompt: 2, tokens_completion: 2 },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const reserved = await ledger.reserve({
      project: 'test',
      run_id: 'run-cli',
      attempt_id: 'run-cli-a1',
      model: MODEL,
      est_micro_usd: 40_000,
      pricing_snapshot: { model: MODEL },
    });
    assert.equal(reserved.ok, true);
    if (!reserved.ok) throw new Error('unreachable');
    await ledger.markPending(reserved.reservation_id, 'cost_unknown', { generation_id: 'gen cli/id', model: MODEL });

    await assert.rejects(() => main(['--settle-pending', '--dry-run', '--ledger', path]), /usage: --settle-pending/);
    await assert.rejects(() => main(['--settle-pending', '--model', MODEL, '--ledger', path]), /usage: --settle-pending/);
    await assert.rejects(() => main(['--settle-pending', '--settle-pending', '--ledger', path]), /repeated flag/);
    assert.equal(calls.length, 0);

    await main(['--settle-pending', '--ledger', path]);
    const output = chunks.map(chunk => chunk.trim()).find(chunk => chunk.startsWith('{'));
    assert.ok(output);
    assert.equal(output.includes(KEY), false);
    assert.equal(output.includes('Bearer'), false);
    assert.equal(output.includes('Authorization'), false);
    const report = JSON.parse(output) as { mode: string; settled: number; still_pending: number; results: Array<{ generation_id: string; micro_usd: number }> };
    assert.equal(report.mode, 'settle-pending');
    assert.equal(report.settled, 1);
    assert.equal(report.still_pending, 0);
    assert.equal(report.results[0]?.generation_id, 'gen cli/id');
    assert.equal(report.results[0]?.micro_usd, 1500);
    assert.equal(process.exitCode, 0);
    assertGenerationOnly(calls);
    assert.equal(calls[0]?.url, 'https://openrouter.ai/api/v1/generation?id=gen%20cli%2Fid');
    assert.equal((await ledger.summary('test')).spent, 1500);
    assert.equal((await ledger.summary('test')).held, 0);
  } finally {
    process.stdout.write = previousWrite;
    process.exitCode = previousExit;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    globalThis.fetch = (async () => {
      throw new Error('unexpected network');
    }) as typeof fetch;
    cleanup();
  }
});

test('cli --settle-pending without a key does not call the provider', async () => {
  const { path, cleanup } = tempLedger();
  const previousKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error('unexpected network');
  }) as typeof fetch;
  try {
    await assert.rejects(() => main(['--settle-pending', '--ledger', path]), /OPENROUTER_API_KEY is not set/);
    assert.equal(fetches, 0);
    const emptyKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = KEY;
    const previousExit = process.exitCode;
    const previousWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), callback?: (err?: Error | null) => void) => {
      return previousWrite.call(process.stdout, chunk, encoding as BufferEncoding, callback);
    }) as typeof process.stdout.write;
    try {
      await main(['--settle-pending', '--ledger', path]);
      assert.equal(fetches, 0);
      assert.equal(process.exitCode, 0);
    } finally {
      process.stdout.write = previousWrite;
      process.exitCode = previousExit;
      if (emptyKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = emptyKey;
    }
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    globalThis.fetch = (async () => {
      throw new Error('unexpected network');
    }) as typeof fetch;
    cleanup();
  }
});

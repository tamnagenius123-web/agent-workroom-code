import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  chatOnce, dispatch, getGenerationCost, loadRoster, OpenRouterError, type Ledger,
} from '../src/or-harness/client.ts';

const MODEL = 'z-ai/glm-5.3-flash';
const CHAT = 'https://openrouter.ai/api/v1/chat/completions';
const GENERATION = 'https://openrouter.ai/api/v1/generation';

function ledger(): Ledger & { reserves: number; settles: number } {
  return {
    reserves: 0,
    settles: 0,
    async reserve() {
      this.reserves += 1;
      return { ok: true, reservation_id: 'res-1' };
    },
    async markPending() { /* hold stays pending */ },
    async settle() { this.settles += 1; },
    async summary() { return { remaining_micro_usd: 1_000_000 }; },
  };
}

test('an unset key does not reserve or fetch', async () => {
  let fetches = 0;
  const book = ledger();
  const fetchImpl = async () => {
    fetches += 1;
    throw new Error('fetch must not run');
  };
  await assert.rejects(
    () => dispatch({
      model: MODEL, project: 'test', prompt: 'hello', maxTokens: 16,
      ledger: book, fetchImpl, apiKey: '',
    }),
    (error: unknown) => error instanceof OpenRouterError && error.reason === 'missing_api_key',
  );
  await assert.rejects(
    () => chatOnce({ model: MODEL, prompt: 'hello', maxTokens: 16, timeoutMs: 1000, fetchImpl, apiKey: '   ' }),
    (error: unknown) => error instanceof OpenRouterError && error.reason === 'missing_api_key',
  );
  assert.equal(fetches, 0);
  assert.equal(book.reserves, 0);
  assert.equal(book.settles, 0);
});

test('a configured dispatch posts once and settles from the mock generation', async () => {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (method === 'POST' && url === CHAT) {
      return Response.json({
        id: 'gen-test',
        choices: [{ message: { content: 'mocked' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    }
    if (method === 'GET' && url.startsWith(GENERATION)) {
      return Response.json({ data: { id: 'gen-test', total_cost: 0.000021, tokens_prompt: 3, tokens_completion: 1, provider_name: 'mock', model: MODEL } });
    }
    throw new Error('unexpected url ' + url);
  };
  const book = ledger();
  const report = await dispatch({
    model: MODEL, project: 'test', prompt: 'hello', maxTokens: 16,
    ledger: book, fetchImpl, apiKey: 'test-key', run_id: 'run-1', attempt_id: 'run-1-a1',
    costRetries: 1, costDelayMs: 0, timeoutMs: 1000,
  });
  assert.equal(report.state, 'settled');
  assert.equal(report.text, 'mocked');
  assert.equal(report.micro_usd, 21);
  assert.equal(report.generation_id, 'gen-test');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(calls.filter(call => call.method === 'GET').length, 1);
  assert.equal(book.reserves, 1);
  assert.equal(book.settles, 1);
  assert.equal(loadRoster().models.some(row => row.id === MODEL), true);
});

test('the build receipt names this source and the dispatch provider module', () => {
  assert.equal(existsSync('dist/provider-receipt.json'), true, 'npm run build must write dist/provider-receipt.json');
  const receipt = JSON.parse(readFileSync('dist/provider-receipt.json', 'utf8')) as {
    source_sha: string; provider_module: string; provider: string; decision_chat_once: string;
  };
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(receipt.source_sha, head);
  assert.equal(receipt.provider_module, 'src/or-harness/client.ts');
  assert.equal(receipt.provider, 'openrouter');
  assert.equal(receipt.decision_chat_once, 'src/decision/llm-fallback.ts');
  const bundle = readFileSync('dist/worker.mjs', 'utf8');
  assert.equal(bundle.includes(CHAT), true);
});

test('generation cost lookup retries 404s with backoff and then returns the cost', async () => {
  let gets = 0;
  const fetchImpl = async () => {
    gets += 1;
    if (gets < 3) return new Response(null, { status: 404 });
    return Response.json({
      data: { id: 'gen-retry', total_cost: 0.000018, tokens_prompt: 4, tokens_completion: 8, provider_name: 'mock', model: MODEL },
    });
  };
  const started = Date.now();
  const cost = await getGenerationCost('gen-retry', {
    fetchImpl, apiKey: 'test-key', retries: 3, delayMs: 20, timeoutMs: 1000, backoffFactor: 2, maxDelayMs: 80,
  });
  const elapsed = Date.now() - started;
  assert.equal(cost?.micro_usd, 18);
  assert.equal(cost?.cost_field, 'total_cost');
  assert.equal(gets, 3);
  assert.ok(elapsed >= 60, 'expected 20ms then 40ms backoff, got ' + elapsed);
});

test('generation cost lookup persists reasoning vs content token split when reported', async () => {
  const fetchImpl = async () => Response.json({
    data: {
      id: 'gen-reason',
      total_cost: 0.00002805,
      tokens_prompt: 8,
      tokens_completion: 137,
      native_tokens_prompt: 18,
      native_tokens_completion: 112,
      native_tokens_reasoning: 100,
      provider_name: 'Wafer',
      model: 'z-ai/glm-5.3-flash-20260826',
    },
  });
  const cost = await getGenerationCost('gen-reason', {
    fetchImpl, apiKey: 'test-key', retries: 1, delayMs: 0, timeoutMs: 1000,
  });
  assert.deepEqual(cost?.tokens, {
    prompt: 8,
    completion: 137,
    total: 145,
    reasoning: 100,
    content: 12,
    native_prompt: 18,
    native_completion: 112,
  });
});

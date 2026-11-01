// Body read after headers (src/or-harness/registry.ts completeChat).
// fetchImpl can resolve ok:true and then fail inside response.text().
// An abort during that read is OpenRouterError code `timeout` (reason, status null).
// Any other body-read error is OpenRouterError code `transport`. That error's
// message, String(error), and JSON.stringify of its own properties omit the api key.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { OpenRouterError, type FetchLike } from '../src/or-harness/client.ts';
import { createOpenRouterAgentRegistry } from '../src/or-harness/registry.ts';

const KEY = 'synthetic-body-read-sentinel';
const MODEL = 'example/builder-peer';
const SYSTEM = 'You write code in the workroom.';
const TASK = 'Read the completion body.';
const ASSISTANT = 'patched the registry';

let savedFetch: typeof fetch;
let blockedCalls = 0;

const blockedFetch: typeof fetch = async () => {
  blockedCalls += 1;
  throw new Error('network disabled');
};

before(() => {
  savedFetch = globalThis.fetch;
  globalThis.fetch = blockedFetch;
});

after(() => {
  globalThis.fetch = savedFetch;
});

function agent() {
  return createOpenRouterAgentRegistry([
    { model: MODEL, roles: ['builder'], max_tokens: 64 },
  ]).resolve(`openrouter:${MODEL}`);
}

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({
    id: 'gen-body',
    model: MODEL,
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function expectCode(error: unknown, code: string): void {
  assert.ok(error instanceof OpenRouterError, `expected OpenRouterError code ${code}`);
  assert.equal(error.reason, code);
  assert.equal(error.status, null);
}

function hidesKey(error: unknown): void {
  assert.ok(error !== null && typeof error === 'object');
  const message = error instanceof Error ? error.message : '';
  assert.equal(message.includes(KEY), false, 'error.message contains the api key sentinel');
  assert.equal(String(error).includes(KEY), false, 'String(error) contains the api key sentinel');
  const ownProps = JSON.stringify(error, Object.getOwnPropertyNames(error));
  assert.equal(ownProps.includes(KEY), false, 'JSON.stringify of own props contains the api key sentinel');
}

test('a body read aborted after the timeout becomes a typed timeout error', async () => {
  const started = blockedCalls;
  let ok = false;
  let aborted = false;
  const fetchImpl: FetchLike = async (_input, init) => {
    const response = chatResponse(ASSISTANT);
    ok = response.ok;
    response.text = () => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('missing abort signal'));
        return;
      }
      const failAbort = () => {
        aborted = true;
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (signal.aborted) failAbort();
      else signal.addEventListener('abort', failAbort, { once: true });
    });
    return response;
  };
  const outcome = await Promise.race([
    agent().complete({
      system: SYSTEM, task: TASK, maxTokens: 32, fetchImpl, apiKey: KEY, timeoutMs: 20,
    }).then(
      (value) => ({ kind: 'value' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    ),
    new Promise<{ kind: 'hung' }>((resolve) => setTimeout(() => resolve({ kind: 'hung' }), 400)),
  ]);
  assert.equal(blockedCalls, started);
  assert.equal(ok, true);
  assert.equal(aborted, true);
  assert.notEqual(outcome.kind, 'hung');
  assert.equal(outcome.kind, 'error');
  if (outcome.kind === 'error') expectCode(outcome.error, 'timeout');
});

test('a body-read failure becomes a typed transport error and hides the api key', async () => {
  const started = blockedCalls;
  let ok = false;
  const fetchImpl: FetchLike = async () => {
    const response = chatResponse(ASSISTANT);
    ok = response.ok;
    response.text = async () => {
      throw new Error(`body read failed: ${KEY}`);
    };
    return response;
  };
  const outcome = await agent().complete({
    system: SYSTEM, task: TASK, maxTokens: 32, fetchImpl, apiKey: KEY, timeoutMs: 1_000,
  }).then(
    (value) => ({ kind: 'value' as const, value }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  );
  assert.equal(blockedCalls, started);
  assert.equal(ok, true);
  assert.equal(outcome.kind, 'error');
  if (outcome.kind === 'error') {
    expectCode(outcome.error, 'transport');
    hidesKey(outcome.error);
  }
});

test('a successful body read still returns the assistant text', async () => {
  const started = blockedCalls;
  const fetchImpl: FetchLike = async () => chatResponse(ASSISTANT);
  const result = await agent().complete({
    system: SYSTEM, task: TASK, maxTokens: 32, fetchImpl, apiKey: KEY, timeoutMs: 1_000,
  });
  assert.equal(blockedCalls, started);
  assert.equal(result.text, ASSISTANT);
});

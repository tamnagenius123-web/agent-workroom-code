// OPENROUTER-AGENTS registry contract (src/or-harness/registry.ts).
// createOpenRouterAgentRegistry(rows) maps each config row to kind `openrouter:<model>`.
// resolve(kind) returns { kind, model, roles, maxTokensCap, complete(input) }.
// complete posts one chat completion through the injected fetch and apiKey.
// Wire body: { model, messages: [system, user task], max_tokens } with max_tokens
// clamped to the row cap (the cap is used when maxTokens is omitted).
// Failures throw OpenRouterError from src/or-harness/client.ts:
// http_<status> (status set), timeout (status null), unknown_kind, same_agent, role_mismatch.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { OpenRouterError, type FetchLike } from '../src/or-harness/client.ts';

const KEY = 'test-key';
const ENV_MARKER = 'env-sentinel-not-for-use';
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODULE_SPECIFIER = '../src/or-harness/registry.ts';
const BUILDER_MODEL = 'example/builder-peer';
const VERIFIER_MODEL = 'example/verifier-peer';
const BOTH_MODEL = 'example/both-roles';
const SYSTEM = 'You write code in the workroom.';
const TASK = 'Add the registry module.';

type AgentRole = 'builder' | 'verifier';

interface AgentRow {
  model: string;
  roles: readonly AgentRole[];
  max_tokens: number;
}

interface AgentResult {
  text: string;
  usage: { prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null };
  model: string;
}

interface CompleteInput {
  system: string;
  task: string;
  maxTokens?: number;
  fetchImpl: FetchLike;
  apiKey: string;
  timeoutMs?: number;
}

interface OpenRouterAgent {
  kind: string;
  model: string;
  roles: readonly AgentRole[];
  maxTokensCap: number;
  complete(input: CompleteInput): Promise<AgentResult>;
}

interface AgentRegistry {
  resolve(kind: string): OpenRouterAgent;
  assertDistinctRoles(workerKind: string, verifierKind: string): void;
}

interface RegistryModule {
  createOpenRouterAgentRegistry?: (rows: readonly AgentRow[]) => AgentRegistry;
}

type CreateRegistry = (rows: readonly AgentRow[]) => AgentRegistry;

let savedKey: string | undefined;
let savedFetch: typeof fetch;
let blockedCalls = 0;

const blockedFetch: typeof fetch = async () => {
  blockedCalls += 1;
  throw new Error('network disabled');
};

before(() => {
  savedKey = process.env.OPENROUTER_API_KEY;
  savedFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = ENV_MARKER;
  globalThis.fetch = blockedFetch;
});

after(() => {
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKey;
  globalThis.fetch = savedFetch;
});

function rows(): readonly AgentRow[] {
  return [
    { model: BUILDER_MODEL, roles: ['builder'], max_tokens: 64 },
    { model: VERIFIER_MODEL, roles: ['verifier'], max_tokens: 32 },
    { model: BOTH_MODEL, roles: ['builder', 'verifier'], max_tokens: 16 },
  ];
}

function kindOf(model: string): string {
  return `openrouter:${model}`;
}

function isMissingRegistry(error: unknown): boolean {
  const parts: string[] = [];
  const stack = [error];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if ('code' in current && current.code != null) parts.push(String(current.code));
    if (current instanceof Error) parts.push(current.message);
    if ('cause' in current) stack.push(current.cause);
  }
  const text = parts.join('\n');
  const missing = text.includes('ERR_MODULE_NOT_FOUND') || text.includes('Cannot find module');
  return missing && (text.includes('registry.ts') || text.includes('or-harness/registry'));
}

function loadFailureLabel(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error && error.code != null ? String(error.code) : '';
  const name = error instanceof Error ? error.name : 'Error';
  return `registry module did not load (${name}${code ? ` ${code}` : ''})`;
}

let loaded: Promise<RegistryModule> | undefined;

function loadModule(): Promise<RegistryModule> {
  loaded ??= (async () => {
    try {
      const imported: unknown = await import(MODULE_SPECIFIER);
      if (!imported || typeof imported !== 'object') return {};
      return imported as RegistryModule;
    } catch (error) {
      assert.equal(isMissingRegistry(error), true, loadFailureLabel(error));
      return {};
    }
  })();
  return loaded;
}

async function loadCreate(): Promise<CreateRegistry> {
  const mod = await loadModule();
  const create = mod.createOpenRouterAgentRegistry;
  assert.equal(typeof create, 'function', 'createOpenRouterAgentRegistry(rows) must be exported from src/or-harness/registry.ts');
  return create as CreateRegistry;
}

function mentionsKey(value: unknown, seen = new WeakSet<object>(), depth = 0): boolean {
  if (depth > 6 || value == null) return false;
  if (typeof value === 'string') return value.includes(KEY);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value).includes(KEY);
  if (typeof value !== 'object' && typeof value !== 'function') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (typeof value === 'function') return value.name.includes(KEY);
  const names = value instanceof Error ? Object.getOwnPropertyNames(value) : Object.keys(value);
  for (const name of names) {
    if (name === 'stack') continue;
    if (name.includes(KEY)) return true;
    try {
      if (mentionsKey((value as Record<string, unknown>)[name], seen, depth + 1)) return true;
    } catch {
      // Getter threw; that property is not a leaked key.
    }
  }
  return false;
}

function expectReason(error: unknown, reason: string, status: number | null): void {
  assert.ok(error instanceof OpenRouterError);
  assert.equal(error.reason, reason);
  assert.equal(error.status, status);
  assert.equal(mentionsKey(error), false);
}

function header(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  const want = name.toLowerCase();
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const found = headers.find((pair) => pair[0].toLowerCase() === want);
    return found ? found[1] : null;
  }
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((item) => item.toLowerCase() === want);
  return key ? record[key] ?? null : null;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return '';
}

interface ChatBody {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens: number;
}

function readChatBody(raw: string): ChatBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  assert.ok(parsed !== undefined && parsed !== null && typeof parsed === 'object', 'request body is JSON');
  const body = parsed as Record<string, unknown>;
  assert.equal(typeof body.model, 'string');
  assert.equal(typeof body.max_tokens, 'number');
  assert.ok(Array.isArray(body.messages));
  return {
    model: body.model as string,
    max_tokens: body.max_tokens as number,
    messages: body.messages as { role: string; content: string }[],
  };
}

function assertAuth(authorization: string | null): void {
  assert.equal(authorization === `Bearer ${ENV_MARKER}`, false);
  assert.equal(authorization, `Bearer ${KEY}`);
}

interface Posted {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  raw: string;
  body: ChatBody;
}

async function posted(agent: OpenRouterAgent, maxTokens: number | undefined): Promise<Posted> {
  const started = blockedCalls;
  let captured: { url: string; init: RequestInit | undefined } | undefined;
  const fetchImpl: FetchLike = async (input, init) => {
    captured = { url: requestUrl(input), init };
    return new Response(JSON.stringify({
      id: 'gen-shape',
      model: BUILDER_MODEL,
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const input: CompleteInput = { system: SYSTEM, task: TASK, fetchImpl, apiKey: KEY, timeoutMs: 1_000 };
  if (maxTokens !== undefined) input.maxTokens = maxTokens;
  await agent.complete(input);
  assert.equal(blockedCalls, started);
  assert.ok(captured, 'complete calls the injected fetch');
  const raw = bodyText(captured.init?.body);
  return {
    url: captured.url,
    method: captured.init?.method ?? '',
    authorization: header(captured.init, 'authorization'),
    contentType: header(captured.init, 'content-type'),
    raw,
    body: readChatBody(raw),
  };
}

function statusResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('a config row registers an openrouter kind without a code change per model', async () => {
  const create = await loadCreate();
  const started = blockedCalls;
  const registry = create(rows());
  assert.equal(typeof registry.resolve, 'function');
  const builder = registry.resolve(kindOf(BUILDER_MODEL));
  const verifier = registry.resolve(kindOf(VERIFIER_MODEL));
  const both = registry.resolve(kindOf(BOTH_MODEL));
  assert.equal(builder.kind, kindOf(BUILDER_MODEL));
  assert.equal(builder.model, BUILDER_MODEL);
  assert.deepEqual([...builder.roles], ['builder']);
  assert.equal(builder.maxTokensCap, 64);
  assert.equal(verifier.kind, kindOf(VERIFIER_MODEL));
  assert.equal(verifier.model, VERIFIER_MODEL);
  assert.deepEqual([...verifier.roles], ['verifier']);
  assert.equal(verifier.maxTokensCap, 32);
  assert.equal(both.kind, kindOf(BOTH_MODEL));
  assert.equal(both.model, BOTH_MODEL);
  assert.deepEqual([...both.roles], ['builder', 'verifier']);
  assert.equal(both.maxTokensCap, 16);
  assert.equal(blockedCalls, started);
});

test('an unknown kind is rejected', async () => {
  const create = await loadCreate();
  const registry = create(rows());
  for (const kind of ['openrouter:example/missing', BUILDER_MODEL, 'openrouter:', 'claude:opus', '']) {
    assert.throws(
      () => registry.resolve(kind),
      (error: unknown) => {
        expectReason(error, 'unknown_kind', null);
        return true;
      },
    );
  }
});

test('the chat request sends the model, the injected key, and the max_tokens cap', async () => {
  const create = await loadCreate();
  const registry = create(rows());
  const agent = registry.resolve(kindOf(BUILDER_MODEL));
  assert.equal(typeof agent.complete, 'function');

  const over = await posted(agent, 1_000);
  assert.equal(over.url, CHAT_URL);
  assert.equal(over.method.toUpperCase(), 'POST');
  assertAuth(over.authorization);
  assert.equal(over.contentType?.toLowerCase().includes('application/json'), true);
  assert.equal(over.body.model, BUILDER_MODEL);
  assert.deepEqual(over.body.messages, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: TASK },
  ]);
  assert.equal(over.body.max_tokens, 64);
  assert.equal(over.raw.includes(KEY), false);
  assert.equal(over.raw.includes(ENV_MARKER), false);

  const under = await posted(agent, 10);
  assert.equal(under.body.max_tokens, 10);
  assert.equal(under.body.model, BUILDER_MODEL);

  const omitted = await posted(agent, undefined);
  assert.equal(omitted.body.max_tokens, 64);
});

test('a successful reply parses into text, usage, and model', async () => {
  const create = await loadCreate();
  const agent = create(rows()).resolve(kindOf(BUILDER_MODEL));
  const started = blockedCalls;
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    calls.push(requestUrl(input));
    return statusResponse(200, {
      id: 'gen-ok',
      model: BUILDER_MODEL,
      choices: [{ message: { role: 'assistant', content: 'patched the registry' } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
  };
  const result = await agent.complete({ system: SYSTEM, task: TASK, maxTokens: 32, fetchImpl, apiKey: KEY, timeoutMs: 1_000 });
  assert.equal(blockedCalls, started);
  assert.deepEqual(calls, [CHAT_URL]);
  assert.equal(result.text, 'patched the registry');
  assert.deepEqual(result.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  assert.equal(result.model, BUILDER_MODEL);
  assert.equal(mentionsKey(result), false);
});

test('HTTP 429 and 500 become typed errors', async () => {
  const create = await loadCreate();
  const agent = create(rows()).resolve(kindOf(BUILDER_MODEL));
  const started = blockedCalls;
  await assert.rejects(
    () => agent.complete({
      system: SYSTEM, task: TASK, maxTokens: 16, apiKey: KEY, timeoutMs: 1_000,
      fetchImpl: async () => statusResponse(429, { error: { message: 'rate limited' } }),
    }),
    (error: unknown) => {
      expectReason(error, 'http_429', 429);
      return true;
    },
  );
  await assert.rejects(
    () => agent.complete({
      system: SYSTEM, task: TASK, maxTokens: 16, apiKey: KEY, timeoutMs: 1_000,
      fetchImpl: async () => statusResponse(500, { error: { message: 'unavailable' } }),
    }),
    (error: unknown) => {
      expectReason(error, 'http_500', 500);
      return true;
    },
  );
  assert.equal(blockedCalls, started);
});

test('a timed-out call becomes a typed timeout error', async () => {
  const create = await loadCreate();
  const agent = create(rows()).resolve(kindOf(BUILDER_MODEL));
  const started = blockedCalls;
  const hanging: FetchLike = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  const outcome = await Promise.race([
    agent.complete({ system: SYSTEM, task: TASK, maxTokens: 8, fetchImpl: hanging, apiKey: KEY, timeoutMs: 20 }).then(
      (value) => ({ kind: 'value' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    ),
    new Promise<{ kind: 'hung' }>((resolve) => setTimeout(() => resolve({ kind: 'hung' }), 400)),
  ]);
  assert.equal(blockedCalls, started);
  assert.notEqual(outcome.kind, 'hung');
  assert.equal(outcome.kind, 'error');
  if (outcome.kind === 'error') expectReason(outcome.error, 'timeout', null);
});

test('errors redact the injected api key', async () => {
  const create = await loadCreate();
  const agent = create(rows()).resolve(kindOf(BUILDER_MODEL));
  const leaked = {
    error: { message: `rejected ${KEY}`, metadata: { authorization: `Bearer ${KEY}` } },
  };
  await assert.rejects(
    () => agent.complete({
      system: SYSTEM, task: TASK, maxTokens: 16, apiKey: KEY, timeoutMs: 1_000,
      fetchImpl: async () => new Response(JSON.stringify(leaked), {
        status: 429,
        headers: { 'content-type': 'application/json', 'x-request-id': KEY },
      }),
    }),
    (error: unknown) => {
      expectReason(error, 'http_429', 429);
      return true;
    },
  );
  await assert.rejects(
    () => agent.complete({
      system: SYSTEM, task: TASK, maxTokens: 16, apiKey: KEY, timeoutMs: 1_000,
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: KEY } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    (error: unknown) => {
      expectReason(error, 'http_500', 500);
      return true;
    },
  );
});

test('the worker kind and the verifier kind must differ', async () => {
  const create = await loadCreate();
  const registry = create(rows());
  assert.equal(typeof registry.assertDistinctRoles, 'function');
  const builder = registry.resolve(kindOf(BUILDER_MODEL));
  const verifier = registry.resolve(kindOf(VERIFIER_MODEL));
  assert.deepEqual([...builder.roles], ['builder']);
  assert.deepEqual([...verifier.roles], ['verifier']);
  assert.doesNotThrow(() => registry.assertDistinctRoles(kindOf(BUILDER_MODEL), kindOf(VERIFIER_MODEL)));
  assert.doesNotThrow(() => registry.assertDistinctRoles(kindOf(BUILDER_MODEL), kindOf(BOTH_MODEL)));
  assert.doesNotThrow(() => registry.assertDistinctRoles(kindOf(BOTH_MODEL), kindOf(VERIFIER_MODEL)));
  assert.throws(
    () => registry.assertDistinctRoles(kindOf(BOTH_MODEL), kindOf(BOTH_MODEL)),
    (error: unknown) => {
      expectReason(error, 'same_agent', null);
      return true;
    },
  );
  assert.throws(
    () => registry.assertDistinctRoles(kindOf(BUILDER_MODEL), kindOf(BUILDER_MODEL)),
    (error: unknown) => {
      expectReason(error, 'same_agent', null);
      return true;
    },
  );
  assert.throws(
    () => registry.assertDistinctRoles(kindOf(VERIFIER_MODEL), kindOf(BUILDER_MODEL)),
    (error: unknown) => {
      expectReason(error, 'role_mismatch', null);
      return true;
    },
  );
  assert.throws(
    () => registry.assertDistinctRoles(kindOf(BOTH_MODEL), kindOf(BUILDER_MODEL)),
    (error: unknown) => {
      expectReason(error, 'role_mismatch', null);
      return true;
    },
  );
});

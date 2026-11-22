import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../scripts/local-harness.ts';
import { READ_TOOLS } from '../src/server/app.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import { dispatchWithGate, type DispatchGate } from '../src/server/dispatch-wire.ts';
import { Workroom } from '../src/server/domain.ts';
import { aggregateUnitCosts, recordUnitCost } from '../src/server/unit-cost.ts';

const ALPHA = 'local-alpha-fixture';
const BETA = 'local-beta-fixture';
const READER = 'local-reader-fixture';
const OUTSIDER = 'local-outsider-fixture';
const ALPHA_ID = 'synthetic:alpha';
const BETA_ID = 'synthetic:beta';
const KEY = 'test-openrouter-key';
const CHAT = 'https://openrouter.ai/api/v1/chat/completions';
const GENERATION = 'https://openrouter.ai/api/v1/generation';
const MODEL = 'z-ai/glm-5.3-flash';

type App = Awaited<ReturnType<typeof harness>>;
interface Call { url: string; method: string; authOk: boolean }
interface Envelope { ok: boolean; data: Record<string, unknown>; error?: { code: string; message: string }; meta: { replayed?: boolean } }
interface Rpc { ok?: boolean; error?: { code: string }; result?: { isError: boolean; structuredContent: Envelope; tools?: { name: string; annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } }[] } }

function assertNoSecret(text: string): void {
  if (text.includes(KEY)) throw new Error('secret leaked into dispatch state');
}

function scriptedOutbound(): { calls: Call[]; outboundService: (request: Request) => Promise<Response> } {
  const calls: Call[] = [];
  let generation = 0;
  const outboundService = async (request: Request) => {
    const auth = request.headers.get('authorization');
    calls.push({ url: request.url, method: request.method, authOk: auth === 'Bearer ' + KEY });
    if (request.method === 'POST' && request.url === CHAT) {
      const body = await request.json() as { messages?: { content?: string }[] };
      const prompt = body.messages?.[0]?.content ?? '';
      const id = prompt.includes('PENDING') ? 'gen-pending' : 'gen-' + (++generation);
      return Response.json({
        id,
        choices: [{ message: { content: 'hello from model' } }],
        usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
      });
    }
    if (request.method === 'GET' && request.url.startsWith(GENERATION + '?')) {
      const id = new URL(request.url).searchParams.get('id');
      if (id === 'gen-pending') return new Response(null, { status: 404 });
      return Response.json({
        data: {
          id, total_cost: 0.000021, tokens_prompt: 11, tokens_completion: 4,
          provider_name: 'stub-provider', model: MODEL,
        },
      });
    }
    return new Response('outbound blocked', { status: 599 });
  };
  return { calls, outboundService };
}

async function rpc(target: App, token: string, method: string, params: Record<string, unknown>): Promise<{ status: number; body: Rpc }> {
  const response = await target.mf.dispatchFetch('http://127.0.0.1/mcp', { method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': method, ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
  return { status: response.status, body: await response.json() as Rpc };
}
const call = (target: App, token: string, name: string, args: object) => rpc(target, token, 'tools/call', { name, arguments: { schema_version: '1', room: 'room_main', ...args } });

function ok(res: { body: Rpc }): Envelope {
  assert.equal(res.body.result?.isError, false, JSON.stringify(res.body));
  assert.equal(res.body.result?.structuredContent.ok, true);
  assertNoSecret(JSON.stringify(res.body));
  return res.body.result!.structuredContent;
}
function codeOf(res: { body: Rpc }): string {
  if (res.body.error) return 'RPC:' + res.body.error.code;
  assert.equal(res.body.result?.isError, true, JSON.stringify(res.body));
  return res.body.result?.structuredContent.error?.code ?? '';
}

async function rest(target: App, token: string, method: string, path: string, key?: string, body?: unknown): Promise<{ status: number; body: Envelope }> {
  const headers: Record<string, string> = { Authorization: 'Bearer ' + token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const response = await target.mf.dispatchFetch('http://127.0.0.1' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const parsed = await response.json() as Envelope;
  assertNoSecret(JSON.stringify(parsed));
  return { status: response.status, body: parsed };
}

function costInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1',
    consumer: 'P4',
    provenance: { kind: 'synthetic_fixture', producer_id: 'producer_p4', source_ref: 'fixture:unit-cost' },
    proof_mode: 'synthetic',
    unit_id: 'unit_p4_001',
    tool: 'grok',
    model: 'grok-4.7',
    tokens_in: 120,
    tokens_out: 30,
    category: 'subscription',
    cost_usd_micros: 'UNKNOWN',
    ...over,
  };
}

function mustRecord(over: Record<string, unknown> = {}) {
  const parsed = recordUnitCost(costInput(over));
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join(' | '));
  if (!parsed.ok) throw new Error('record failed');
  return parsed.value;
}

test('unit cost and agent dispatch persist through REST and MCP', async () => {
  const network = scriptedOutbound();
  const app = await harness({
    through: 9999,
    bindings: { OPENROUTER_API_KEY: KEY },
    outboundService: network.outboundService,
  });
  try {
    assert.equal(READ_TOOLS.has('workroom_unit_cost_summary'), true);
    assert.equal(READ_TOOLS.has('workroom_unit_cost_record'), false);
    assert.equal(READ_TOOLS.has('workroom_agent_dispatch'), false);
    const listed = await rpc(app, ALPHA, 'tools/list', {});
    const tools = listed.body.result?.tools ?? [];
    const recordTool = tools.find(tool => tool.name === 'workroom_unit_cost_record');
    const summaryTool = tools.find(tool => tool.name === 'workroom_unit_cost_summary');
    const dispatchTool = tools.find(tool => tool.name === 'workroom_agent_dispatch');
    assert.ok(recordTool);
    assert.ok(summaryTool);
    assert.ok(dispatchTool);
    assert.equal(recordTool?.annotations?.readOnlyHint, false);
    assert.equal(recordTool?.annotations?.idempotentHint, true);
    assert.equal(summaryTool?.annotations?.readOnlyHint, true);
    assert.equal(dispatchTool?.annotations?.readOnlyHint, false);
    assert.equal(dispatchTool?.annotations?.idempotentHint, true);
    assert.equal(dispatchTool?.annotations?.openWorldHint, true);
    assert.equal((await app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='budget_reservations'").first<{ name: string }>())?.name, 'budget_reservations');
    assert.equal((await app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='budget_actuals'").first<{ name: string }>())?.name, 'budget_actuals');
    assert.equal((await app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='unit_cost_records'").first<{ name: string }>())?.name, 'unit_cost_records');

    const emptyRest = await rest(app, READER, 'GET', '/api/v1/rooms/room_main/unit-costs');
    assert.equal(emptyRest.status, 200, JSON.stringify(emptyRest.body));
    const emptyPure = aggregateUnitCosts([]);
    assert.equal(emptyPure.ok, true);
    if (!emptyPure.ok) return;
    assert.deepEqual(emptyRest.body.data.aggregate, emptyPure.value);
    assert.equal(emptyRest.body.data.room_id, 'room_main');
    const outsider = await rest(app, OUTSIDER, 'GET', '/api/v1/rooms/room_main/unit-costs');
    assert.equal(outsider.status, 403);
    assert.equal(outsider.body.error?.code, 'FORBIDDEN');
    const outsiderMcp = await call(app, OUTSIDER, 'workroom_unit_cost_summary', {});
    assert.equal(outsiderMcp.status, 403);

    const subscription = costInput();
    const recordedRest = await rest(app, ALPHA, 'POST', '/api/v1/rooms/room_main/unit-costs', 'unit-cost-sub-0001', subscription);
    assert.equal(recordedRest.status, 200, JSON.stringify(recordedRest.body));
    assert.equal(recordedRest.body.data.principal_id, ALPHA_ID);
    assert.equal(recordedRest.body.data.replayed, false);
    assert.equal(recordedRest.body.data.category, 'subscription');
    assert.equal(recordedRest.body.data.cost_usd_micros, 'UNKNOWN');
    const replayRest = await rest(app, ALPHA, 'POST', '/api/v1/rooms/room_main/unit-costs', 'unit-cost-sub-0001', subscription);
    assert.equal(replayRest.status, 200, JSON.stringify(replayRest.body));
    assert.equal(replayRest.body.data.replayed, true);
    assert.equal(replayRest.body.data.id, recordedRest.body.data.id);
    const conflict = await rest(app, ALPHA, 'POST', '/api/v1/rooms/room_main/unit-costs', 'unit-cost-sub-0001', costInput({ tokens_in: 121 }));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error?.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(Number((await app.db.prepare('SELECT count(*) AS n FROM unit_cost_records WHERE idempotency_key=?').bind('unit-cost-sub-0001').first<{ n: number }>())?.n), 1);

    const zero = await rest(app, ALPHA, 'POST', '/api/v1/rooms/room_main/unit-costs', 'unit-cost-zero-001', costInput({ cost_usd_micros: 0 }));
    assert.equal(zero.status, 400);
    assert.equal(zero.body.error?.code, 'INVALID_INPUT');
    assert.match(zero.body.error?.message ?? '', /never 0/);
    assert.match(zero.body.error?.message ?? '', /UNKNOWN/);
    assert.equal(Number((await app.db.prepare('SELECT count(*) AS n FROM unit_cost_records WHERE idempotency_key=?').bind('unit-cost-zero-001').first<{ n: number }>())?.n), 0);

    const smuggled = await rest(app, ALPHA, 'POST', '/api/v1/rooms/room_main/unit-costs', 'unit-cost-smuggle01', { ...subscription, principal_id: BETA_ID });
    assert.equal(smuggled.status, 400);
    assert.match(smuggled.body.error?.message ?? '', /body/);
    const readerWrite = await rest(app, READER, 'POST', '/api/v1/rooms/room_main/unit-costs', 'unit-cost-reader01', subscription);
    assert.equal(readerWrite.status, 403);
    assert.equal(readerWrite.body.error?.code, 'FORBIDDEN');

    const openrouter = costInput({
      unit_id: 'unit_or_001', tool: 'openrouter', model: MODEL, category: 'openrouter',
      cost_usd_micros: 21000, tokens_in: 10, tokens_out: 4,
    });
    const recordedMcp = ok(await call(app, BETA, 'workroom_unit_cost_record', { ...openrouter, idempotency_key: 'unit-cost-or-00001' }));
    assert.equal(recordedMcp.data.principal_id, BETA_ID);
    assert.equal(recordedMcp.data.replayed, false);
    const mcpSmuggle = await call(app, ALPHA, 'workroom_unit_cost_record', { ...openrouter, idempotency_key: 'unit-cost-or-smug1', principal_id: BETA_ID });
    assert.equal(codeOf(mcpSmuggle), 'INVALID_INPUT');
    assert.match(JSON.stringify(mcpSmuggle.body), /principal_id/);
    assert.equal(Number((await app.db.prepare('SELECT count(*) AS n FROM unit_cost_records WHERE idempotency_key=?').bind('unit-cost-or-smug1').first<{ n: number }>())?.n), 0);
    const readerMcp = await call(app, READER, 'workroom_unit_cost_record', { ...subscription, idempotency_key: 'unit-cost-reader02' });
    assert.equal(codeOf(readerMcp), 'FORBIDDEN');

    const expected = aggregateUnitCosts([mustRecord(), mustRecord({
      unit_id: 'unit_or_001', tool: 'openrouter', model: MODEL, category: 'openrouter',
      cost_usd_micros: 21000, tokens_in: 10, tokens_out: 4,
    })]);
    assert.equal(expected.ok, true);
    if (!expected.ok) return;
    const summary = ok(await call(app, READER, 'workroom_unit_cost_summary', {}));
    assert.deepEqual(summary.data.aggregate, expected.value);
    assert.equal(summary.data.room_id, 'room_main');
    assert.equal(network.calls.length, 0);

    const identity = await rest(app, ALPHA, 'POST', '/api/v1/rooms/room_main/dispatch', 'dispatch-ident-001', {
      schema_version: '1', model: MODEL, prompt: 'Reply with hello', max_tokens: 32, principal_id: BETA_ID,
    });
    assert.equal(identity.status, 400);
    assert.match(identity.body.error?.message ?? '', /body/);
    assert.equal(Number((await app.db.prepare('SELECT count(*) AS n FROM dispatch_calls WHERE idempotency_key=?').bind('dispatch-ident-001').first<{ n: number }>())?.n), 0);

    const mcpIdentity = await call(app, ALPHA, 'workroom_agent_dispatch', {
      idempotency_key: 'dispatch-ident-002', model: MODEL, prompt: 'Reply with hello', max_tokens: 32, principal_id: BETA_ID,
    });
    assert.equal(mcpIdentity.body.result?.isError, true, JSON.stringify(mcpIdentity.body));
    assert.equal(Number((await app.db.prepare('SELECT count(*) AS n FROM dispatch_calls WHERE idempotency_key=?').bind('dispatch-ident-002').first<{ n: number }>())?.n), 0);

    const callsAfterModel = network.calls.length;
    const readerDispatch = await call(app, READER, 'workroom_agent_dispatch', {
      idempotency_key: 'dispatch-reader01', model: MODEL, prompt: 'Reply with hello', max_tokens: 32,
    });
    assert.equal(codeOf(readerDispatch), 'FORBIDDEN');
    const readerRest = await rest(app, READER, 'POST', '/api/v1/rooms/room_main/dispatch', 'dispatch-reader02', {
      schema_version: '1', model: MODEL, prompt: 'Reply with hello', max_tokens: 32,
    });
    assert.equal(readerRest.status, 403);
    assert.equal(network.calls.length, callsAfterModel);
  } finally { await app.close(); }
});

test('missing OpenRouter key does not reserve or call the network', async () => {
  const network = scriptedOutbound();
  const app = await harness({ through: 9999, outboundService: network.outboundService });
  try {
    const response = await rest(app, ALPHA, 'POST', '/api/v1/rooms/room_main/dispatch', 'dispatch-nokey-001', {
      schema_version: '1', model: MODEL, prompt: 'Reply with hello', max_tokens: 32,
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.error?.code, 'DISPATCH_NOT_CONFIGURED');
    const mcp = await call(app, ALPHA, 'workroom_agent_dispatch', {
      idempotency_key: 'dispatch-nokey-002', model: MODEL, prompt: 'Reply with hello', max_tokens: 32,
    });
    assert.equal(codeOf(mcp), 'DISPATCH_NOT_CONFIGURED');
    assert.equal(network.calls.length, 0);
    assert.equal(Number((await app.db.prepare('SELECT count(*) AS n FROM budget_reservations').first<{ n: number }>())?.n), 0);
    assert.equal(Number((await app.db.prepare('SELECT count(*) AS n FROM dispatch_calls').first<{ n: number }>())?.n), 0);
  } finally { await app.close(); }
});

test('missing budget tables are a clean not-available fault', async () => {
  const app = await harness({ through: 27, outboundService: async () => { throw new Error('unexpected network'); } });
  try {
    const summary = await call(app, ALPHA, 'workroom_unit_cost_summary', {});
    assert.equal(codeOf(summary), 'NOT_AVAILABLE');
    assert.equal(JSON.stringify(summary.body).includes('no such table'), false);
    const record = await call(app, ALPHA, 'workroom_unit_cost_record', { ...costInput(), idempotency_key: 'unit-cost-old-0001' });
    assert.equal(codeOf(record), 'NOT_AVAILABLE');
    assert.equal(JSON.stringify(record.body).includes('no such table'), false);
    const dispatched = await call(app, ALPHA, 'workroom_agent_dispatch', {
      idempotency_key: 'dispatch-old-00001', model: MODEL, prompt: 'Reply with hello', max_tokens: 32,
    });
    assert.equal(codeOf(dispatched), 'NOT_AVAILABLE');
    assert.equal(JSON.stringify(dispatched.body).includes('no such table'), false);
  } finally { await app.close(); }
});

test('a configured dispatch calls the mock provider once and settles', async () => {
  const network = scriptedOutbound();
  const app = await harness({
    through: 9999,
    bindings: { OPENROUTER_API_KEY: KEY },
    outboundService: network.outboundService,
  });
  try {
    const response = await rest(app, ALPHA, 'POST', '/api/v1/rooms/room_main/dispatch', 'dispatch-live-0001', {
      schema_version: '1', model: MODEL, prompt: 'Reply with hello', max_tokens: 32,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.state, 'settled');
    assert.equal(response.body.data.text, 'hello from model');
    assert.equal(response.body.data.micro_usd, 21);
    assert.equal(network.calls.length, 2);
    assert.equal(network.calls[0]?.method, 'POST');
    assert.equal(network.calls[0]?.url, CHAT);
    assert.equal(network.calls[0]?.authOk, true);
    assert.equal(network.calls[1]?.method, 'GET');
    assert.equal(network.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(JSON.stringify(response.body).includes('boundary unavailable'), false);
    assert.equal(Number((await app.db.prepare('SELECT count(*) AS n FROM dispatch_calls').first<{ n: number }>())?.n), 1);
    assert.equal(Number((await app.db.prepare("SELECT count(*) AS n FROM budget_reservations WHERE state='settled'").first<{ n: number }>())?.n), 1);
  } finally { await app.close(); }
});

test('a gate double settles once and a replay does not call it again', async () => {
  const app = await harness({ through: 9999 });
  try {
    const service = new Workroom(app.db as unknown as Database, ALPHA_ID);
    let calls = 0;
    const gate: DispatchGate = {
      estimateMicroUsd: () => 10,
      dispatch: async () => {
        calls += 1;
        return {
          model: MODEL, generation_id: null, state: 'settled', micro_usd: null, text: 'from the gate double',
          summary: null, reason: null, run_id: 'run-double', attempt_id: 'attempt-double', reservation_id: null,
          estimate_micro_usd: 10, reserve_micro_usd: 10, remaining: null, cost_field: null, reservation_ok: null, usage: null,
        };
      },
    };
    const input = {
      schema_version: '1' as const, room: 'room_main', idempotency_key: 'dispatch-double01',
      model: MODEL, prompt: 'Reply with hello', max_tokens: 32, project: 'test',
    };
    const first = await dispatchWithGate(service, { OPENROUTER_API_KEY: KEY }, input, gate);
    assert.equal(calls, 1);
    assert.equal(first.data.replayed, false);
    assert.equal((first.data as { text?: string }).text, 'from the gate double');
    assert.equal(typeof first.data.message_id, 'string');
    const replay = await dispatchWithGate(service, { OPENROUTER_API_KEY: KEY }, input, gate);
    assert.equal(calls, 1);
    assert.equal(replay.data.replayed, true);
    assert.equal(replay.data.message_id, first.data.message_id);
    await assert.rejects(
      () => dispatchWithGate(service, { OPENROUTER_API_KEY: KEY }, { ...input, prompt: 'A different prompt' }, gate),
      (error: unknown) => error instanceof Fault && error.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.equal(calls, 1);
    const message = await app.db.prepare('SELECT actor_id, text FROM messages WHERE id=?').bind(first.data.message_id).first<{ actor_id: string; text: string }>();
    assert.deepEqual(message, { actor_id: ALPHA_ID, text: 'from the gate double' });
  } finally { await app.close(); }
});

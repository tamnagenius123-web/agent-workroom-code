import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { READ_TOOLS } from '../src/server/app.ts';
import { harness } from '../scripts/local-harness.ts';

const ALPHA = 'local-alpha-fixture';
const READER = 'local-reader-fixture';
const OUTSIDER = 'local-outsider-fixture';
const TOOL = 'workroom_research_applicability';

type App = Awaited<ReturnType<typeof harness>>;
interface Rpc { ok?: boolean; error?: { code: string }; result?: { isError?: boolean; structuredContent?: Envelope; tools?: Tool[] } }
interface Tool { name: string; annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean } }
interface Envelope { ok: boolean; data?: Applicability; error?: { code: string; message: string }; meta?: { note?: string } }
interface Applicability {
  applicability?: string;
  reason?: string;
  consumer?: string;
  hypothesis?: string;
  discriminator?: string;
  edvBand?: string;
  frontierClass?: string;
}

const DETERMINISTIC = {
  applicability: 'not_applicable',
  reason: 'Deterministic ledger write; research is not a prerequisite.',
};
const RESEARCH = {
  applicability: 'required',
  consumer: 'agent:muse',
  hypothesis: 'A named consumer raises closure rate.',
  discriminator: 'consumer present vs absent',
  edvBand: 'HIGH',
  frontierClass: 'ONE_DISCRIMINATOR_AWAY',
};

let app: App;
before(async () => { app = await harness({ through: 9999 }); });
after(async () => { await app?.close(); });

async function rpc(target: App, token: string, method: string, params: Record<string, unknown>): Promise<{ status: number; body: Rpc }> {
  const response = await target.mf.dispatchFetch('http://127.0.0.1/mcp', { method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': method, ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
  return { status: response.status, body: await response.json() as Rpc };
}
const call = (target: App, token: string, args: object) => rpc(target, token, 'tools/call', { name: TOOL, arguments: { schema_version: '1', room: 'room_main', ...args } });
function ok(res: { body: Rpc }): Envelope {
  assert.equal(res.body.result?.isError, false, JSON.stringify(res.body));
  assert.equal(res.body.result?.structuredContent?.ok, true);
  return res.body.result!.structuredContent!;
}
function codeOf(res: { body: Rpc }): string {
  if (res.body.error) return 'RPC:' + res.body.error.code;
  assert.equal(res.body.result?.isError, true, JSON.stringify(res.body));
  return res.body.result?.structuredContent?.error?.code ?? '';
}
function messageOf(res: { body: Rpc }): string {
  return res.body.result?.structuredContent?.error?.message ?? JSON.stringify(res.body);
}

test('MCP deterministic task returns not_applicable and keeps EDV fields off that path', async () => {
  assert.equal(READ_TOOLS.has(TOOL), true);
  const listed = await rpc(app, ALPHA, 'tools/list', {});
  const tool = (listed.body.result?.tools ?? []).find(item => item.name === TOOL);
  assert.ok(tool, JSON.stringify((listed.body.result?.tools ?? []).map(item => item.name)));
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.equal(tool.annotations?.idempotentHint, true);

  const before = Number((await app.db.prepare('SELECT count(*) AS n FROM operations').first<{ n: number }>())?.n);
  const deterministic = ok(await call(app, ALPHA, { task: DETERMINISTIC }));
  assert.deepEqual(deterministic.data, DETERMINISTIC);
  assert.equal(deterministic.data?.applicability, 'not_applicable');
  for (const key of ['consumer', 'hypothesis', 'discriminator', 'edvBand', 'frontierClass', 'edv_band', 'frontier_class']) {
    assert.equal(Object.hasOwn(deterministic.data ?? {}, key), false, key);
  }
  assert.match(deterministic.meta?.note ?? '', /not applicable/i);

  const reader = ok(await call(app, READER, { task: DETERMINISTIC }));
  assert.deepEqual(reader.data, DETERMINISTIC);

  const extra = await call(app, ALPHA, { task: { ...DETERMINISTIC, hypothesis: 'should not be here' } });
  assert.equal(codeOf(extra), 'INVALID_INPUT');
  assert.match(messageOf(extra), /hypothesis/);
  const blank = await call(app, ALPHA, { task: { applicability: 'not_applicable', reason: '   ' } });
  assert.equal(codeOf(blank), 'INVALID_INPUT');
  assert.match(messageOf(blank), /reason/);

  const outsider = await call(app, OUTSIDER, { task: DETERMINISTIC });
  assert.equal(outsider.status, 403);
  assert.equal(outsider.body.error?.code, 'FORBIDDEN');
  const after = Number((await app.db.prepare('SELECT count(*) AS n FROM operations').first<{ n: number }>())?.n);
  assert.equal(after, before);
});

test('MCP research task requires EDV fields and rejects a task without them', async () => {
  const missing = await call(app, ALPHA, { task: {
    applicability: 'required',
    consumer: 'agent:muse',
    hypothesis: RESEARCH.hypothesis,
    discriminator: RESEARCH.discriminator,
  } });
  assert.equal(codeOf(missing), 'INVALID_INPUT');
  assert.match(messageOf(missing), /edvBand/);
  assert.match(messageOf(missing), /frontierClass/);

  const snake = await call(app, ALPHA, { task: {
    applicability: 'required',
    consumer: 'agent:muse',
    hypothesis: RESEARCH.hypothesis,
    discriminator: RESEARCH.discriminator,
    edv_band: 'HIGH',
    frontier_class: 'ONE_DISCRIMINATOR_AWAY',
  } });
  assert.equal(codeOf(snake), 'INVALID_INPUT');
  assert.match(messageOf(snake), /edv_band|edvBand/);

  const reward = await call(app, ALPHA, { task: { ...RESEARCH, reward: 12 } });
  assert.equal(codeOf(reward), 'INVALID_INPUT');
  assert.match(messageOf(reward), /R\(t\)/);

  const research = ok(await call(app, ALPHA, { task: RESEARCH }));
  assert.deepEqual(research.data, RESEARCH);
  assert.equal(research.data?.applicability, 'required');
  assert.equal(research.data?.edvBand, 'HIGH');
  assert.equal(research.data?.frontierClass, 'ONE_DISCRIMINATOR_AWAY');
  assert.match(research.meta?.note ?? '', /EDV/);
});

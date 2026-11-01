import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { READ_TOOLS } from '../src/server/app.ts';
import { renderContext, type ContextCandidate } from '../src/phase-contracts/context-budget.ts';
import { harness } from '../scripts/local-harness.ts';

const ALPHA = 'local-alpha-fixture';
const READER = 'local-reader-fixture';
const OUTSIDER = 'local-outsider-fixture';
const TOOL = 'workroom_context_compile';

type App = Awaited<ReturnType<typeof harness>>;
interface Rpc { ok?: boolean; error?: { code: number | string; message?: string }; result?: { isError?: boolean; structuredContent?: Envelope; tools?: Tool[] } }
interface Tool { name: string; annotations?: { readOnlyHint?: boolean } }
interface Envelope { ok: boolean; data?: CompileData; error?: { code: string; message: string } }
interface ManifestEntry {
  source: string;
  version: string;
  scope: string;
  actually_emitted: boolean;
  source_id: string;
  revision: string;
  id: string;
  selected: boolean;
  omission_reason?: string;
  freshness: string;
  mandatory: boolean;
  correction: boolean;
  coverage: string;
}
interface CompileData {
  budget: number;
  token_count: number;
  rendered: string;
  token_counter: string;
  manifest: ManifestEntry[];
}

let app: App;
before(async () => { app = await harness({ through: 9999 }); });
after(async () => { await app?.close(); });

function item(over: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    id: 'item-1',
    source_id: 'src_msg_1',
    revision: 'rev_1',
    scope: 'room_main',
    representation: 'src_msg_1:body',
    freshness: 'FRESH',
    coverage: 'body',
    text: 'body',
    token_cost: 1,
    mandatory: false,
    correction: false,
    ...over,
  };
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
  assert.equal(res.body.result?.structuredContent?.ok, true);
  return res.body.result!.structuredContent!;
}
function codeOf(res: { body: Rpc }): string {
  if (res.body.error) return 'RPC:' + res.body.error.code;
  assert.equal(res.body.result?.isError, true, JSON.stringify(res.body));
  return res.body.result?.structuredContent?.error?.code ?? '';
}
function entry(data: CompileData | undefined, id: string): ManifestEntry {
  const found = data?.manifest.find(row => row.id === id);
  assert.ok(found, JSON.stringify(data?.manifest));
  return found;
}

test('MCP context compile returns a manifest with source, version, scope, and actually_emitted', async () => {
  assert.equal(READ_TOOLS.has(TOOL), true);
  const listed = await rpc(app, ALPHA, 'tools/list', {});
  const tool = (listed.body.result?.tools ?? []).find(row => row.name === TOOL);
  assert.ok(tool, JSON.stringify((listed.body.result?.tools ?? []).map(row => row.name)));
  assert.equal(tool.annotations?.readOnlyHint, true);

  const evidence = item({
    id: 'ev-1', source_id: 'msg-2', revision: 'rev_2', scope: 'task-7',
    representation: 'msg-2:abstract', freshness: 'STALE', coverage: 'partial',
    text: 'Abstract of the source.', token_cost: 3, mandatory: true, correction: false,
  });
  const pointer = item({
    id: 'ptr-1', source_id: 'msg-p', revision: 'rev_p', scope: 'room_main',
    representation: 'msg-p:pointer', coverage: 'pointer_only', text: '', token_cost: 0, mandatory: false,
  });
  const selected = renderContext([evidence, pointer]);
  const compiled = ok(await call(app, READER, TOOL, { budget: selected.length, items: [evidence, pointer] }));
  assert.equal(compiled.data?.token_counter, 'utf16_code_units');
  assert.equal(compiled.data?.rendered, selected);
  assert.equal(compiled.data?.token_count, selected.length);
  assert.equal(compiled.data?.budget, selected.length);
  const emitted = entry(compiled.data, 'ev-1');
  assert.equal(emitted.source, 'msg-2');
  assert.equal(emitted.version, 'rev_2');
  assert.equal(emitted.scope, 'task-7');
  assert.equal(emitted.actually_emitted, true);
  assert.equal(emitted.source, emitted.source_id);
  assert.equal(emitted.version, emitted.revision);
  assert.equal(emitted.freshness, 'STALE');
  assert.equal(emitted.mandatory, true);
  assert.equal(emitted.selected, true);
  const pointed = entry(compiled.data, 'ptr-1');
  assert.equal(pointed.source, 'msg-p');
  assert.equal(pointed.version, 'rev_p');
  assert.equal(pointed.scope, 'room_main');
  assert.equal(pointed.actually_emitted, false);
  assert.equal(pointed.selected, true);
  assert.equal(pointed.coverage, 'pointer_only');
  assert.equal(Object.hasOwn(pointed, 'omission_reason'), false);

  const optional = item({
    id: 'opt-1', source_id: 'msg-o', revision: 'rev_9', scope: 'room_main',
    text: 'OPTIONAL-BODY', mandatory: false, correction: false,
  });
  const tight = renderContext([evidence]).length;
  assert.ok(renderContext([evidence, optional]).length > tight);
  const dropped = ok(await call(app, ALPHA, TOOL, { budget: tight, items: [evidence, optional] }));
  assert.equal(entry(dropped.data, 'ev-1').actually_emitted, true);
  const omitted = entry(dropped.data, 'opt-1');
  assert.equal(omitted.source, 'msg-o');
  assert.equal(omitted.version, 'rev_9');
  assert.equal(omitted.scope, 'room_main');
  assert.equal(omitted.actually_emitted, false);
  assert.equal(omitted.selected, false);
  assert.equal(omitted.omission_reason, 'over_budget');
  assert.equal(dropped.data?.rendered.includes('OPTIONAL-BODY'), false);

  const empty = ok(await call(app, ALPHA, TOOL, { budget: 0, items: [] }));
  assert.deepEqual(empty.data?.manifest, []);
  assert.equal(empty.data?.token_count, 0);
  assert.equal(empty.data?.rendered, '');

  const lied = await call(app, ALPHA, TOOL, { budget: selected.length, items: [{ ...evidence, actually_emitted: true }] });
  assert.equal(codeOf(lied), 'INVALID_INPUT');
  const spoofed = await call(app, ALPHA, TOOL, { budget: 0, items: [], count_tokens: 0 });
  assert.equal(codeOf(spoofed), 'INVALID_INPUT');
  assert.match(JSON.stringify(spoofed.body), /computed by the server/);
  const otherRoom = await call(app, ALPHA, TOOL, { room: 'other-room', budget: 0, items: [] });
  assert.equal(codeOf(otherRoom), 'FORBIDDEN');
  const outsider = await call(app, OUTSIDER, TOOL, { budget: 0, items: [] });
  assert.equal(outsider.status, 403);
  assert.equal(outsider.body.error?.code, 'FORBIDDEN');
});

test('MCP context compile returns an error when a mandatory source exceeds the budget', async () => {
  const correction = item({
    id: 'corr', source_id: 'msg-c', revision: 'rev_c', scope: 'room_main',
    text: 'KEEP-WHOLE-CORRECTION', mandatory: true, correction: true, token_cost: 1,
  });
  const evidence = item({
    id: 'ev', source_id: 'msg-e', revision: 'rev_e', scope: 'task-7',
    text: 'KEEP-WHOLE-EVIDENCE', mandatory: true, correction: false, token_cost: 1,
  });
  const bait = item({ id: 'bait', source_id: 'msg-b', revision: 'rev_b', text: 'x', token_cost: 0, mandatory: false });
  const items = [correction, evidence, bait];
  const tooSmall = renderContext([correction]).length;
  assert.ok(renderContext([correction, evidence]).length > tooSmall);
  const over = await call(app, ALPHA, TOOL, { budget: tooSmall, items });
  assert.equal(codeOf(over), 'MANDATORY_EXCEEDS_BUDGET');
  assert.match(over.body.result?.structuredContent?.error?.message ?? '', /MANDATORY_EXCEEDS_BUDGET/);
  assert.match(over.body.result?.structuredContent?.error?.message ?? '', /not dropped or truncated/);
  assert.equal(over.body.result?.structuredContent?.data, undefined);
  assert.equal(JSON.stringify(over.body).includes('KEEP-WHOLE-CORRECTION'), false);
  assert.equal(JSON.stringify(over.body).includes('"manifest"'), false);

  const enough = renderContext(items).length;
  const fit = ok(await call(app, ALPHA, TOOL, { budget: enough, items }));
  assert.equal(fit.data?.token_count, enough);
  assert.deepEqual(fit.data?.manifest.map(row => [row.source, row.version, row.scope, row.actually_emitted]), [
    ['msg-c', 'rev_c', 'room_main', true],
    ['msg-e', 'rev_e', 'task-7', true],
    ['msg-b', 'rev_b', 'room_main', true],
  ]);
  assert.equal(fit.data?.rendered.includes('KEEP-WHOLE-CORRECTION'), true);
  assert.equal(fit.data?.rendered.includes('KEEP-WHOLE-EVIDENCE'), true);
});

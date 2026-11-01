import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { READ_TOOLS } from '../src/server/app.ts';
import { validateIw01Status, type Iw01StatusRecord } from '../src/phase-contracts/iw01-status-fields.ts';
import { harness } from '../scripts/local-harness.ts';

const ALPHA = 'local-alpha-fixture';
const BETA = 'local-beta-fixture';
const READER = 'local-reader-fixture';
const OUTSIDER = 'local-outsider-fixture';
const ALPHA_ID = 'synthetic:alpha';

type App = Awaited<ReturnType<typeof harness>>;
interface Rpc { ok?: boolean; error?: { code: string }; result?: { isError?: boolean; structuredContent?: Envelope; tools?: Tool[] } }
interface Tool { name: string; annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean } }
interface Envelope { ok: boolean; data?: StatusData; error?: { code: string; message: string }; meta?: { replayed?: boolean; note?: string } }
interface StatusData {
  id: string;
  room_id: string;
  subject_id: string;
  principal_id: string;
  recorded_at: string;
  replayed: boolean;
  reviewSupport?: string;
  structuralGrade?: string;
  corpusLevel?: string;
  memoryTier?: number;
  promotionStage?: string;
  grade?: string;
  level?: string;
  tier?: number;
  stage?: string;
  kept?: boolean;
  applied?: boolean;
  effect?: boolean;
  status?: string;
  timestamps?: { recorded_at: { value: string; authority: string } };
  [key: string]: unknown;
}

const RECORD: Iw01StatusRecord = {
  reviewSupport: 'supported',
  structuralGrade: 'C',
  corpusLevel: 'L1',
  memoryTier: 2,
  promotionStage: 'shadow',
  kept: true,
  applied: false,
  effect: false,
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
async function rest(target: App, method: string, path: string, token: string, body?: object, key?: string): Promise<{ status: number; body: Envelope }> {
  const response = await target.mf.dispatchFetch('http://127.0.0.1' + path, { method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body ? JSON.stringify({ schema_version: '1', ...body }) : undefined });
  return { status: response.status, body: await response.json() as Envelope };
}
function separateAxes(data: StatusData): void {
  assert.equal(data.grade, 'C');
  assert.equal(data.level, 'L1');
  assert.equal(data.tier, 2);
  assert.equal(data.stage, 'shadow');
  assert.equal(data.structuralGrade, data.grade);
  assert.equal(data.corpusLevel, data.level);
  assert.equal(data.memoryTier, data.tier);
  assert.equal(data.promotionStage, data.stage);
  assert.equal(data.reviewSupport, 'supported');
  assert.notEqual(data.grade, data.level);
  assert.notEqual(String(data.tier), data.stage);
  assert.equal(Object.hasOwn(data, 'status'), false);
  assert.equal(data.kept, true);
  assert.equal(data.applied, false);
  assert.equal(data.effect, false);
}

test('MCP status read returns separate grade, level, tier, and stage fields', async () => {
  assert.equal(READ_TOOLS.has('workroom_status_read'), true);
  assert.equal(READ_TOOLS.has('workroom_status_record'), false);
  const listed = await rpc(app, ALPHA, 'tools/list', {});
  const tools = listed.body.result?.tools ?? [];
  const recordTool = tools.find(tool => tool.name === 'workroom_status_record');
  const readTool = tools.find(tool => tool.name === 'workroom_status_read');
  assert.ok(recordTool, JSON.stringify(tools.map(tool => tool.name)));
  assert.ok(readTool);
  assert.equal(recordTool?.annotations?.readOnlyHint, false);
  assert.equal(recordTool?.annotations?.idempotentHint, true);
  assert.equal(readTool?.annotations?.readOnlyHint, true);
  assert.equal((await app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='iw01_status_records'").first<{ name: string }>())?.name, 'iw01_status_records');

  const pure = validateIw01Status(RECORD);
  assert.equal(pure.ok, true);
  const first = ok(await call(app, ALPHA, 'workroom_status_record', { idempotency_key: 'iw01-record-0001', subject_id: 'skill-axis-1', record: RECORD }));
  assert.equal(first.data?.replayed, false);
  assert.equal(first.data?.principal_id, ALPHA_ID);
  assert.equal(first.data?.subject_id, 'skill-axis-1');
  assert.equal(first.data?.room_id, 'room_main');
  assert.equal(first.data?.timestamps?.recorded_at.authority, 'server');
  assert.equal(first.data?.recorded_at, first.data?.timestamps?.recorded_at.value);
  assert.ok(Math.abs(Date.parse(first.data!.recorded_at) - Date.now()) < 60_000);
  separateAxes(first.data!);
  assert.match(first.meta?.note ?? '', /kept/);
  const stored = await app.db.prepare('SELECT principal_id, kept, applied, effect, structural_grade, corpus_level, memory_tier, promotion_stage, record_json FROM iw01_status_records WHERE id=?')
    .bind(first.data!.id).first<{ principal_id: string; kept: number; applied: number; effect: number; structural_grade: string; corpus_level: string; memory_tier: number; promotion_stage: string; record_json: string }>();
  assert.equal(stored?.principal_id, ALPHA_ID);
  assert.equal(stored?.kept, 1);
  assert.equal(stored?.applied, 0);
  assert.equal(stored?.effect, 0);
  assert.equal(stored?.structural_grade, 'C');
  assert.equal(stored?.corpus_level, 'L1');
  assert.equal(stored?.memory_tier, 2);
  assert.equal(stored?.promotion_stage, 'shadow');
  const storedRecord = JSON.parse(stored?.record_json ?? '{}') as Record<string, unknown>;
  for (const alias of ['status', 'grade', 'level', 'tier', 'stage', 'state']) assert.equal(Object.hasOwn(storedRecord, alias), false, alias);

  const replay = ok(await call(app, ALPHA, 'workroom_status_record', { idempotency_key: 'iw01-record-0001', subject_id: 'skill-axis-1', record: RECORD }));
  assert.equal(replay.data?.replayed, true);
  assert.equal(replay.data?.id, first.data?.id);
  separateAxes(replay.data!);
  const viaRest = await rest(app, 'POST', '/api/v1/rooms/room_main/status-records', ALPHA, { subject_id: 'skill-axis-1', record: RECORD }, 'iw01-record-0001');
  assert.equal(viaRest.status, 200, JSON.stringify(viaRest.body));
  assert.equal(viaRest.body.data?.replayed, true);
  assert.equal(viaRest.body.data?.id, first.data?.id);
  const n = await app.db.prepare('SELECT count(*) AS n FROM iw01_status_records WHERE idempotency_key=?').bind('iw01-record-0001').first<{ n: number }>();
  assert.equal(Number(n?.n), 1);

  const changed = { ...RECORD, structuralGrade: 'A' as const };
  const conflict = await call(app, ALPHA, 'workroom_status_record', { idempotency_key: 'iw01-record-0001', subject_id: 'skill-axis-1', record: changed });
  assert.equal(codeOf(conflict), 'IDEMPOTENCY_CONFLICT');
  const conflictRest = await rest(app, 'POST', '/api/v1/rooms/room_main/status-records', ALPHA, { subject_id: 'skill-axis-1', record: changed }, 'iw01-record-0001');
  assert.equal(conflictRest.status, 409);
  assert.equal(conflictRest.body.error?.code, 'IDEMPOTENCY_CONFLICT');
  const still = await app.db.prepare('SELECT structural_grade FROM iw01_status_records WHERE id=?').bind(first.data!.id).first<{ structural_grade: string }>();
  assert.equal(still?.structural_grade, 'C');

  const again = await call(app, ALPHA, 'workroom_status_record', { idempotency_key: 'iw01-record-0002', subject_id: 'skill-axis-1', record: RECORD });
  assert.equal(codeOf(again), 'CONFLICT');
  const rows = await app.db.prepare('SELECT count(*) AS n FROM iw01_status_records WHERE subject_id=?').bind('skill-axis-1').first<{ n: number }>();
  assert.equal(Number(rows?.n), 1);

  const collapsed = await call(app, ALPHA, 'workroom_status_record', { idempotency_key: 'iw01-collapsed-01', subject_id: 'skill-axis-2', record: { ...RECORD, grade: 'C' } });
  assert.equal(codeOf(collapsed), 'INVALID_INPUT');
  assert.match(JSON.stringify(collapsed.body), /collapsed_field:grade/);
  const inferred = await call(app, ALPHA, 'workroom_status_record', { idempotency_key: 'iw01-inferred-001', subject_id: 'skill-axis-3', record: { ...RECORD, applied: undefined } });
  assert.equal(codeOf(inferred), 'INVALID_INPUT');
  assert.match(JSON.stringify(inferred.body), /missing_field:applied/);
  const statusAlias = await call(app, ALPHA, 'workroom_status_record', { idempotency_key: 'iw01-status-alias', subject_id: 'skill-axis-4', record: { ...RECORD, status: 'supported' } });
  assert.equal(codeOf(statusAlias), 'INVALID_INPUT');
  assert.match(JSON.stringify(statusAlias.body), /collapsed_field:status/);
  const emptyStored = await app.db.prepare("SELECT count(*) AS n FROM iw01_status_records WHERE subject_id IN ('skill-axis-2','skill-axis-3','skill-axis-4')").first<{ n: number }>();
  assert.equal(Number(emptyStored?.n), 0);

  const independent = ok(await call(app, BETA, 'workroom_status_record', {
    idempotency_key: 'iw01-independent1', subject_id: 'skill-axis-5',
    record: { ...RECORD, reviewSupport: 'none', structuralGrade: 'F', corpusLevel: 'L0', memoryTier: 0, promotionStage: 'candidate', kept: false, applied: true, effect: false },
  }));
  assert.equal(independent.data?.grade, 'F');
  assert.equal(independent.data?.level, 'L0');
  assert.equal(independent.data?.tier, 0);
  assert.equal(independent.data?.stage, 'candidate');
  assert.equal(independent.data?.kept, false);
  assert.equal(independent.data?.applied, true);
  assert.equal(independent.data?.effect, false);

  const got = ok(await call(app, READER, 'workroom_status_read', { id: first.data!.id }));
  assert.equal(got.data?.id, first.data?.id);
  assert.equal(got.data?.replayed, false);
  separateAxes(got.data!);
  const bySubject = ok(await call(app, READER, 'workroom_status_read', { subject_id: 'skill-axis-1' }));
  assert.equal(bySubject.data?.id, first.data?.id);
  separateAxes(bySubject.data!);
  const restGet = await rest(app, 'GET', '/api/v1/rooms/room_main/status-records/' + first.data!.id, READER);
  assert.equal(restGet.status, 200, JSON.stringify(restGet.body));
  separateAxes(restGet.body.data!);
  const restSubject = await rest(app, 'GET', '/api/v1/rooms/room_main/status-records?subject_id=skill-axis-1', BETA);
  assert.equal(restSubject.status, 200, JSON.stringify(restSubject.body));
  assert.equal(restSubject.body.data?.id, first.data?.id);

  const readerWrite = await call(app, READER, 'workroom_status_record', { idempotency_key: 'iw01-reader-0001', subject_id: 'skill-axis-6', record: RECORD });
  assert.equal(codeOf(readerWrite), 'FORBIDDEN');
  const outsider = await call(app, OUTSIDER, 'workroom_status_read', { id: first.data!.id });
  assert.equal(outsider.status, 403);
  assert.equal(outsider.body.error?.code, 'FORBIDDEN');
  const outsiderRest = await rest(app, 'GET', '/api/v1/rooms/room_main/status-records/' + first.data!.id, OUTSIDER);
  assert.equal(outsiderRest.status, 403);
  const missing = await call(app, ALPHA, 'workroom_status_read', { id: 'missing-status-record' });
  assert.equal(codeOf(missing), 'NOT_FOUND');
  const both = await call(app, ALPHA, 'workroom_status_read', { id: first.data!.id, subject_id: 'skill-axis-1' });
  assert.equal(codeOf(both), 'INVALID_INPUT');
  const neither = await call(app, ALPHA, 'workroom_status_read', {});
  assert.equal(codeOf(neither), 'INVALID_INPUT');
  const smuggled = await call(app, ALPHA, 'workroom_status_record', { idempotency_key: 'iw01-smuggle-0001', subject_id: 'skill-axis-7', principal_id: 'synthetic:beta', record: RECORD });
  assert.equal(codeOf(smuggled), 'INVALID_INPUT');
  assert.equal((await app.db.prepare('SELECT count(*) AS n FROM iw01_status_records WHERE subject_id=?').bind('skill-axis-7').first<{ n: number }>())?.n, 0);
  const echoed = await call(app, ALPHA, 'workroom_status_record', { idempotency_key: 'iw01-echo-000001', subject_id: 'skill-axis-8', record: got.data });
  assert.equal(codeOf(echoed), 'INVALID_INPUT');
  assert.match(JSON.stringify(echoed.body), /collapsed_field/);
  assert.equal(Number((await app.db.prepare('SELECT count(*) AS n FROM iw01_status_records WHERE subject_id=?').bind('skill-axis-8').first<{ n: number }>())?.n), 0);
  await assert.rejects(() => app.db.prepare('UPDATE iw01_status_records SET applied=1 WHERE id=?').bind(first.data!.id).all(), /immutable/);
  await assert.rejects(() => app.db.prepare('DELETE FROM iw01_status_records WHERE id=?').bind(first.data!.id).all(), /immutable/);
  const frozen = await app.db.prepare('SELECT applied FROM iw01_status_records WHERE id=?').bind(first.data!.id).first<{ applied: number }>();
  assert.equal(frozen?.applied, 0);
});

test('missing IW-01 status table is not a storage fault', async () => {
  const current = await harness({ through: 43 });
  try {
    const recorded = await call(current, ALPHA, 'workroom_status_record', { idempotency_key: 'iw01-old-0000001', subject_id: 'skill-old', record: RECORD });
    assert.equal(codeOf(recorded), 'NOT_AVAILABLE');
    assert.equal(JSON.stringify(recorded.body).includes('no such table'), false);
    const read = await call(current, ALPHA, 'workroom_status_read', { subject_id: 'skill-old' });
    assert.equal(codeOf(read), 'NOT_AVAILABLE');
    assert.equal(JSON.stringify(read.body).includes('no such table'), false);
    const restGet = await rest(current, 'GET', '/api/v1/rooms/room_main/status-records/missing-status-record', ALPHA);
    assert.equal(restGet.status, 400);
    assert.equal(restGet.body.error?.code, 'NOT_AVAILABLE');
    assert.equal(JSON.stringify(restGet.body).includes('no such table'), false);
  } finally { await current.close(); }
});

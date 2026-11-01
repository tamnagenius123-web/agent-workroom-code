import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { READ_TOOLS } from '../src/server/app.ts';
import { acceptHandoff } from '../src/server/handoff-receipt.ts';
import { evaluateVerifierReceipt, GATE_VERSION, type CaseRun, type ReceiptObservation } from '../src/server/verifier-receipt.ts';
import { RED_CASE_IDS } from '../src/phase-contracts/verifier-receipt.ts';
import { harness } from '../scripts/local-harness.ts';

const ALPHA = 'local-alpha-fixture';
const BETA = 'local-beta-fixture';
const READER = 'local-reader-fixture';
const OUTSIDER = 'local-outsider-fixture';
const ALPHA_ID = 'synthetic:alpha';
const BETA_ID = 'synthetic:beta';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const DIGEST = 'a'.repeat(64);
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'phase-contracts');

type App = Awaited<ReturnType<typeof harness>>;
interface Rpc { ok?: boolean; error?: { code: string; message?: string }; result?: { isError?: boolean; structuredContent?: Envelope; tools?: Tool[] } }
interface Tool { name: string; annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean } }
interface Envelope { ok: boolean; data?: ReceiptData; error?: { code: string; message: string; errors?: string[] }; meta?: { replayed?: boolean; note?: string } }
interface ReceiptData {
  id: string; principal_id: string; recorded_at: string; replayed: boolean; proven_live?: boolean;
  handoff_receipt?: { wake_stage_id: string; checkpoint_hash: string; consumer_id: string };
  receipt?: { injection_receipt_id?: string; acceptor_id?: string; verifier_id?: string; producer_id?: string; verdict?: string; proof_mode?: string; provenance?: { producer_id?: string } } | null;
  proof?: { provenance?: { producer_id?: string } };
  disposition?: string; reasons?: string[]; failure_packet?: { evidence?: string[] } | null;
  observation_report?: string; separate_gates?: string[];
  acceptor_id?: string; verifier_id?: string;
  observation?: { acceptor_id?: string; verifier_id?: string };
  timestamps?: { recorded_at: { value: string; authority: string } };
}

let app: App;
before(async () => { app = await harness({ through: 9999 }); });
after(async () => { await app?.close(); });

function load(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as Record<string, unknown>;
}
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
function handoffBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  const proof = load('wake-proof.valid.json');
  const receipt = load('handoff-receipt.valid.json');
  return {
    consumer_id: receipt.consumer, checkpoint_hash: receipt.sealed_checkpoint_hash,
    wake_stage_id: receipt.authenticated_exact_read_stage_id, proof, receipt, ...over,
  };
}
function liveBody(): Record<string, unknown> {
  const body = handoffBody();
  const proof = body.proof as Record<string, unknown>;
  const receipt = body.receipt as Record<string, unknown>;
  const provenance = { kind: 'server_observed', producer_id: 'producer_p0', source_ref: 'server:wake' };
  proof.provenance = provenance;
  proof.proof_mode = 'live';
  receipt.provenance = { ...provenance, source_ref: 'server:handoff' };
  receipt.proof_mode = 'live';
  receipt.injection_receipt_id = 'inj_wake_live_001';
  for (const key of ['relay_receipt', 'native_host_run', 'authenticated_exact_read']) {
    const stage = proof[key] as Record<string, unknown>;
    stage.evidence_source = 'server_observed';
    stage.evidence_ref = `evidence:${key}`;
    stage.observed_at = '2026-10-24T02:21:00.000Z';
  }
  return body;
}
function passingRuns(): CaseRun[] {
  return RED_CASE_IDS.map(case_id => {
    const evidence = `log ${case_id} retained`;
    return { case_id, evidence, evidence_sha256: sha256(evidence) };
  });
}
function verifierBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    consumer: 'P2', producer_id: 'agent_author', next_maker: 'agent_author',
    author_lineage: { method: 'author.impl', dependencies: ['pkg-a', 'pkg-b'] },
    verifier_lineage: { method: 'verifier.impl', dependencies: ['pkg-a', 'pkg-b'] },
    sha: SHA, observed_sha: SHA, claimed_gate_version: GATE_VERSION,
    task_id: 'task_p1', attempt_id: 'attempt_1', artifact_digest: DIGEST,
    lease: { epoch: 'lease_1', stale: false }, capability_label_as_authority: false,
    approval_events: ['accept'], observation_ok: true, runs: passingRuns(), ...over,
  };
}
function boundObservation(body: Record<string, unknown>, principal: string): ReceiptObservation {
  return { ...body, acceptor_id: principal, verifier_id: principal } as ReceiptObservation;
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
async function rest(target: App, method: string, path: string, token: string, body?: object, key?: string): Promise<{ status: number; body: Envelope }> {
  const response = await target.mf.dispatchFetch('http://127.0.0.1' + path, { method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body ? JSON.stringify({ schema_version: '1', ...body }) : undefined });
  return { status: response.status, body: await response.json() as Envelope };
}
async function count(table: string, key: string): Promise<number> {
  const row = await app.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE idempotency_key=?`).bind(key).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

test('handoff accept and get persist the pure decision under the caller principal', async () => {
  assert.equal(READ_TOOLS.has('workroom_handoff_get'), true);
  assert.equal(READ_TOOLS.has('workroom_handoff_accept'), false);
  const listed = await rpc(app, ALPHA, 'tools/list', {});
  const tools = listed.body.result?.tools ?? [];
  const accept = tools.find(tool => tool.name === 'workroom_handoff_accept');
  const get = tools.find(tool => tool.name === 'workroom_handoff_get');
  assert.ok(accept, JSON.stringify(tools.map(tool => tool.name)));
  assert.ok(get);
  assert.equal(accept?.annotations?.readOnlyHint, false);
  assert.equal(accept?.annotations?.idempotentHint, true);
  assert.equal(get?.annotations?.readOnlyHint, true);
  assert.equal((await app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='handoff_receipts'").first<{ name: string }>())?.name, 'handoff_receipts');

  const body = handoffBody();
  const pure = acceptHandoff({ consumer_id: body.consumer_id as string, checkpoint_hash: body.checkpoint_hash as string, wake_stage_id: body.wake_stage_id as string, proof: body.proof, receipt: body.receipt, seen_injection_ids: [] });
  if (!pure.ok) assert.fail(pure.errors.join('; '));
  const first = ok(await call(app, ALPHA, 'workroom_handoff_accept', { idempotency_key: 'handoff-accept-0001', ...body }));
  assert.equal(first.data?.replayed, false);
  assert.equal(first.data?.principal_id, ALPHA_ID);
  assert.equal(first.data?.timestamps?.recorded_at.authority, 'server');
  assert.equal(first.data?.recorded_at, first.data?.timestamps?.recorded_at.value);
  assert.notEqual(first.data?.recorded_at, '2026-10-24T02:21:00.000Z');
  assert.ok(Math.abs(Date.parse(first.data!.recorded_at) - Date.now()) < 60_000);
  assert.equal(first.data?.proven_live, false);
  assert.deepEqual(first.data?.handoff_receipt, pure.value.handoff_receipt);
  assert.equal(first.data?.receipt?.injection_receipt_id, pure.value.receipt.injection_receipt_id);
  assert.equal(first.data?.proof?.provenance?.producer_id, 'producer_p0');
  assert.match(first.meta?.note ?? '', /principal/);
  const stored = await app.db.prepare('SELECT principal_id, injection_receipt_id FROM handoff_receipts WHERE id=?').bind(first.data!.id).first<{ principal_id: string; injection_receipt_id: string }>();
  assert.equal(stored?.principal_id, ALPHA_ID);
  assert.equal(stored?.injection_receipt_id, pure.value.receipt.injection_receipt_id);

  const replay = ok(await call(app, ALPHA, 'workroom_handoff_accept', { idempotency_key: 'handoff-accept-0001', ...body }));
  assert.equal(replay.data?.replayed, true);
  assert.equal(replay.meta?.replayed, true);
  assert.equal(replay.data?.id, first.data?.id);
  assert.equal(replay.data?.recorded_at, first.data?.recorded_at);
  const viaRest = await rest(app, 'POST', '/api/v1/rooms/room_main/handoffs', ALPHA, body, 'handoff-accept-0001');
  assert.equal(viaRest.status, 200, JSON.stringify(viaRest.body));
  assert.equal(viaRest.body.data?.replayed, true);
  assert.equal(viaRest.body.data?.id, first.data?.id);
  assert.equal(await count('handoff_receipts', 'handoff-accept-0001'), 1);

  const changed = handoffBody({ checkpoint_hash: 'b'.repeat(64) });
  const conflict = await call(app, ALPHA, 'workroom_handoff_accept', { idempotency_key: 'handoff-accept-0001', ...changed });
  assert.equal(codeOf(conflict), 'IDEMPOTENCY_CONFLICT');
  const conflictRest = await rest(app, 'POST', '/api/v1/rooms/room_main/handoffs', ALPHA, changed, 'handoff-accept-0001');
  assert.equal(conflictRest.status, 409);
  assert.equal(conflictRest.body.error?.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(await count('handoff_receipts', 'handoff-accept-0001'), 1);
  const kept = await app.db.prepare('SELECT attempt_json FROM handoff_receipts WHERE id=?').bind(first.data!.id).first<{ attempt_json: string }>();
  assert.equal(JSON.parse(kept?.attempt_json ?? '{}').checkpoint_hash, body.checkpoint_hash);

  const freshKey = 'handoff-reject-0001';
  const rejected = await call(app, ALPHA, 'workroom_handoff_accept', { idempotency_key: freshKey, ...changed });
  assert.equal(codeOf(rejected), 'INVALID_INPUT');
  assert.match(rejected.body.result?.structuredContent?.error?.message ?? '', /handoff_receipt\.checkpoint_hash: does not match the sealed checkpoint/);
  assert.equal(await count('handoff_receipts', freshKey), 0);
  const recovered = ok(await call(app, ALPHA, 'workroom_handoff_accept', { idempotency_key: freshKey, ...handoffBody({ receipt: { ...load('handoff-receipt.valid.json'), injection_receipt_id: 'inj_wake_002' } }) }));
  assert.equal(recovered.data?.replayed, false);
  assert.notEqual(recovered.data?.id, first.data?.id);

  const duplicate = await call(app, BETA, 'workroom_handoff_accept', { idempotency_key: 'handoff-dup-beta-01', ...body });
  assert.equal(codeOf(duplicate), 'INVALID_INPUT');
  assert.match(duplicate.body.result?.structuredContent?.error?.message ?? '', /handoff_receipt\.injection_receipt_id: duplicate/);
  assert.equal(await count('handoff_receipts', 'handoff-dup-beta-01'), 0);
  const missingReceipt = await call(app, BETA, 'workroom_handoff_accept', { idempotency_key: 'handoff-missing-01', ...handoffBody({ receipt: null }) });
  assert.equal(codeOf(missingReceipt), 'INVALID_INPUT');
  assert.match(missingReceipt.body.result?.structuredContent?.error?.message ?? '', /handoff_receipt: required/);
  assert.equal(await count('handoff_receipts', 'handoff-missing-01'), 0);

  const smuggled = await call(app, ALPHA, 'workroom_handoff_accept', { idempotency_key: 'handoff-smuggle-01', principal_id: BETA_ID, ...body });
  assert.equal(smuggled.body.result?.isError, true, JSON.stringify(smuggled.body));
  assert.match(JSON.stringify(smuggled.body), /principal_id/);
  assert.equal(await count('handoff_receipts', 'handoff-smuggle-01'), 0);
  const seen = await rest(app, 'POST', '/api/v1/rooms/room_main/handoffs', ALPHA, { ...handoffBody({ receipt: { ...load('handoff-receipt.valid.json'), injection_receipt_id: 'inj_wake_003' } }), seen_injection_ids: [] }, 'handoff-seen-rest-1');
  assert.equal(seen.status, 400);
  assert.match(seen.body.error?.message ?? '', /seen_injection_ids/);
  assert.equal(await count('handoff_receipts', 'handoff-seen-rest-1'), 0);

  const got = ok(await call(app, READER, 'workroom_handoff_get', { id: first.data!.id }));
  assert.equal(got.data?.id, first.data?.id);
  assert.equal(got.data?.principal_id, ALPHA_ID);
  assert.equal(got.data?.replayed, false);
  const byInjection = await rest(app, 'GET', '/api/v1/rooms/room_main/handoffs?injection_receipt_id=' + pure.value.receipt.injection_receipt_id, READER);
  assert.equal(byInjection.status, 200, JSON.stringify(byInjection.body));
  assert.equal(byInjection.body.data?.id, first.data?.id);
  const readerWrite = await call(app, READER, 'workroom_handoff_accept', { idempotency_key: 'handoff-reader-0001', ...handoffBody({ receipt: { ...load('handoff-receipt.valid.json'), injection_receipt_id: 'inj_wake_reader' } }) });
  assert.equal(codeOf(readerWrite), 'FORBIDDEN');
  assert.equal(await count('handoff_receipts', 'handoff-reader-0001'), 0);
  const readerRest = await rest(app, 'POST', '/api/v1/rooms/room_main/handoffs', READER, handoffBody({ receipt: { ...load('handoff-receipt.valid.json'), injection_receipt_id: 'inj_wake_reader2' } }), 'handoff-reader-0002');
  assert.equal(readerRest.status, 403);
  assert.equal(readerRest.body.error?.code, 'FORBIDDEN');
  const outsider = await call(app, OUTSIDER, 'workroom_handoff_get', { id: first.data!.id });
  assert.equal(outsider.status, 403);
  assert.equal(outsider.body.error?.code, 'FORBIDDEN');

  const live = liveBody();
  const livePure = acceptHandoff({ consumer_id: live.consumer_id as string, checkpoint_hash: live.checkpoint_hash as string, wake_stage_id: live.wake_stage_id as string, proof: live.proof, receipt: live.receipt, seen_injection_ids: [] });
  if (!livePure.ok) assert.fail(livePure.errors.join('; '));
  const lived = ok(await call(app, BETA, 'workroom_handoff_accept', { idempotency_key: 'handoff-live-00001', ...live }));
  assert.equal(lived.data?.proven_live, true);
  assert.equal(lived.data?.principal_id, BETA_ID);
  assert.deepEqual(lived.data?.handoff_receipt, livePure.value.handoff_receipt);
});

test('verifier submit and get persist evaluateVerifierReceipt with transport identity', async () => {
  assert.equal(READ_TOOLS.has('workroom_verifier_receipt_get'), true);
  assert.equal(READ_TOOLS.has('workroom_verifier_receipt_submit'), false);
  const listed = await rpc(app, ALPHA, 'tools/list', {});
  const tools = listed.body.result?.tools ?? [];
  const submit = tools.find(tool => tool.name === 'workroom_verifier_receipt_submit');
  const get = tools.find(tool => tool.name === 'workroom_verifier_receipt_get');
  assert.ok(submit, JSON.stringify(tools.map(tool => tool.name)));
  assert.ok(get);
  assert.equal(submit?.annotations?.readOnlyHint, false);
  assert.equal(submit?.annotations?.idempotentHint, true);
  assert.equal(get?.annotations?.readOnlyHint, true);
  assert.equal((await app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='verifier_receipts'").first<{ name: string }>())?.name, 'verifier_receipts');

  const body = verifierBody();
  const expected = evaluateVerifierReceipt(boundObservation(body, ALPHA_ID));
  assert.equal(expected.disposition, 'PASS');
  const first = ok(await call(app, ALPHA, 'workroom_verifier_receipt_submit', { idempotency_key: 'verifier-pass-0001', ...body }));
  assert.equal(first.data?.replayed, false);
  assert.equal(first.data?.principal_id, ALPHA_ID);
  assert.equal(first.data?.acceptor_id, ALPHA_ID);
  assert.equal(first.data?.verifier_id, ALPHA_ID);
  assert.equal(first.data?.observation?.acceptor_id, ALPHA_ID);
  assert.equal(first.data?.observation?.verifier_id, ALPHA_ID);
  assert.equal(first.data?.disposition, expected.disposition);
  assert.deepEqual(first.data?.reasons, expected.reasons);
  assert.deepEqual(first.data?.failure_packet, expected.failure_packet);
  assert.equal(first.data?.observation_report, expected.observation_report);
  assert.deepEqual(first.data?.separate_gates, [...expected.separate_gates]);
  assert.equal(first.data?.receipt?.acceptor_id, ALPHA_ID);
  assert.equal(first.data?.receipt?.producer_id, 'agent_author');
  assert.equal(first.data?.receipt?.verdict, 'PASS');
  assert.equal(first.data?.receipt?.proof_mode, 'synthetic');
  assert.deepEqual(first.data?.receipt, expected.receipt);
  assert.equal(first.data?.timestamps?.recorded_at.authority, 'server');
  assert.match(first.meta?.note ?? '', /acceptor_id/);
  const row = await app.db.prepare('SELECT principal_id, disposition FROM verifier_receipts WHERE id=?').bind(first.data!.id).first<{ principal_id: string; disposition: string }>();
  assert.equal(row?.principal_id, ALPHA_ID);
  assert.equal(row?.disposition, 'PASS');

  const replay = ok(await call(app, ALPHA, 'workroom_verifier_receipt_submit', { idempotency_key: 'verifier-pass-0001', ...body }));
  assert.equal(replay.data?.replayed, true);
  assert.equal(replay.data?.id, first.data?.id);
  assert.equal(replay.data?.recorded_at, first.data?.recorded_at);
  const viaRest = await rest(app, 'POST', '/api/v1/rooms/room_main/verifier-receipts', ALPHA, body, 'verifier-pass-0001');
  assert.equal(viaRest.status, 200, JSON.stringify(viaRest.body));
  assert.equal(viaRest.body.data?.id, first.data?.id);
  assert.equal(viaRest.body.data?.replayed, true);
  assert.equal(await count('verifier_receipts', 'verifier-pass-0001'), 1);

  const heldBody = verifierBody({ observed_sha: OTHER_SHA });
  const heldExpected = evaluateVerifierReceipt(boundObservation(heldBody, ALPHA_ID));
  const held = ok(await call(app, ALPHA, 'workroom_verifier_receipt_submit', { idempotency_key: 'verifier-hold-0001', ...heldBody }));
  assert.equal(held.data?.disposition, 'HOLD');
  assert.deepEqual(held.data?.receipt, heldExpected.receipt);
  assert.ok(held.data?.reasons?.includes('sha_changed'));
  assert.ok(held.data?.failure_packet?.evidence?.includes('RC1 sha changed'));
  const conflict = await call(app, ALPHA, 'workroom_verifier_receipt_submit', { idempotency_key: 'verifier-pass-0001', ...heldBody });
  assert.equal(codeOf(conflict), 'IDEMPOTENCY_CONFLICT');
  assert.equal((await app.db.prepare('SELECT disposition FROM verifier_receipts WHERE idempotency_key=?').bind('verifier-pass-0001').first<{ disposition: string }>())?.disposition, 'PASS');

  const selfBody = verifierBody({ producer_id: ALPHA_ID });
  const selfExpected = evaluateVerifierReceipt(boundObservation(selfBody, ALPHA_ID));
  const self = ok(await call(app, ALPHA, 'workroom_verifier_receipt_submit', { idempotency_key: 'verifier-self-00001', ...selfBody }));
  assert.equal(self.data?.disposition, 'HOLD');
  assert.equal(self.data?.receipt, null);
  assert.deepEqual(self.data?.reasons, selfExpected.reasons);
  assert.ok(self.data?.reasons?.includes('acceptor_is_producer'));
  assert.equal(self.data?.acceptor_id, ALPHA_ID);

  const smuggled = await call(app, ALPHA, 'workroom_verifier_receipt_submit', { idempotency_key: 'verifier-smuggle-01', acceptor_id: BETA_ID, verifier_id: BETA_ID, ...body });
  assert.equal(smuggled.body.result?.isError, true, JSON.stringify(smuggled.body));
  assert.match(JSON.stringify(smuggled.body), /acceptor_id/);
  assert.equal(await count('verifier_receipts', 'verifier-smuggle-01'), 0);
  const principal = await rest(app, 'POST', '/api/v1/rooms/room_main/verifier-receipts', ALPHA, { ...verifierBody({ task_id: 'task_p1b' }), principal_id: BETA_ID }, 'verifier-principal-1');
  assert.equal(principal.status, 400);
  assert.match(principal.body.error?.message ?? '', /principal_id/);
  assert.equal(await count('verifier_receipts', 'verifier-principal-1'), 0);

  const fetched = await rest(app, 'GET', '/api/v1/rooms/room_main/verifier-receipts/' + first.data!.id, BETA);
  assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
  assert.equal(fetched.body.data?.principal_id, ALPHA_ID);
  assert.deepEqual(fetched.body.data?.receipt, expected.receipt);
  const byKey = ok(await call(app, ALPHA, 'workroom_verifier_receipt_get', { idempotency_key: 'verifier-pass-0001' }));
  assert.equal(byKey.data?.id, first.data?.id);
  const hidden = await call(app, BETA, 'workroom_verifier_receipt_get', { idempotency_key: 'verifier-pass-0001' });
  assert.equal(codeOf(hidden), 'NOT_FOUND');
  const readerWrite = await call(app, READER, 'workroom_verifier_receipt_submit', { idempotency_key: 'verifier-reader-001', ...verifierBody({ task_id: 'task_reader' }) });
  assert.equal(codeOf(readerWrite), 'FORBIDDEN');
  assert.equal(await count('verifier_receipts', 'verifier-reader-001'), 0);
  const outsider = await rest(app, 'GET', '/api/v1/rooms/room_main/verifier-receipts/' + first.data!.id, OUTSIDER);
  assert.equal(outsider.status, 403);
  assert.equal(outsider.body.error?.code, 'FORBIDDEN');
  const missing = await call(app, ALPHA, 'workroom_verifier_receipt_get', { id: 'missing-verifier-receipt' });
  assert.equal(codeOf(missing), 'NOT_FOUND');
});

test('missing receipt tables are not storage faults', async () => {
  const current = await harness({ through: 28 });
  try {
    const handoff = await call(current, ALPHA, 'workroom_handoff_accept', { idempotency_key: 'handoff-old-000001', ...handoffBody() });
    assert.equal(codeOf(handoff), 'NOT_AVAILABLE');
    assert.equal(JSON.stringify(handoff.body).includes('no such table'), false);
    const handoffGet = await call(current, ALPHA, 'workroom_handoff_get', { id: 'missing-handoff' });
    assert.equal(codeOf(handoffGet), 'NOT_AVAILABLE');
    assert.equal(JSON.stringify(handoffGet.body).includes('no such table'), false);
    const submit = await call(current, ALPHA, 'workroom_verifier_receipt_submit', { idempotency_key: 'verifier-old-00001', ...verifierBody() });
    assert.equal(codeOf(submit), 'NOT_AVAILABLE');
    assert.equal(JSON.stringify(submit.body).includes('no such table'), false);
    const read = await rest(current, 'GET', '/api/v1/rooms/room_main/verifier-receipts/missing-verifier-receipt', ALPHA);
    assert.equal(read.status, 400);
    assert.equal(read.body.error?.code, 'NOT_AVAILABLE');
    assert.equal(JSON.stringify(read.body).includes('no such table'), false);
  } finally { await current.close(); }
});

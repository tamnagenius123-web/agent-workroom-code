import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { READ_TOOLS } from '../src/server/app.ts';
import { WAKE_EVIDENCE_SOURCE } from '../src/server/wake.ts';
import { harness } from '../scripts/local-harness.ts';

const ALPHA = 'local-alpha-fixture';
const BETA = 'local-beta-fixture';
const READER = 'local-reader-fixture';
const OUTSIDER = 'local-outsider-fixture';
const BETA_ID = 'synthetic:beta';
const SOURCE = 'server: persisted/emitted; host-reported: relay_receipt/host_run/read_outcome';

type App = Awaited<ReturnType<typeof harness>>;
interface Stage { status: string; reasons: string[]; ids: { delivery_id?: string | null; event_id?: string | null; attempt?: number | null; message_id?: string | null; run_id?: string | null } }
interface ProofData {
  agent: string; message_id: string; verdict: string; notes: string[]; evidence_source: string;
  time_authority: { persisted: string; emitted: string; relay_receipt: string; host_run: string; read_outcome: string };
  stages: { persisted: Stage; emitted: Stage; relay_receipt: Stage; host_run: Stage; read_outcome: Stage };
}
interface ReportData {
  id: string; principal_id: string; recorded_at: string; replayed: boolean;
  payload: { received_at?: string; agent?: string };
  timestamps: { recorded_at: { value: string; authority: string }; claimed: { authority: string; server_verified: boolean; values: Record<string, string> } };
}
interface Envelope { ok: boolean; data: ProofData & ReportData; error?: { code: string; message: string }; meta: { note?: string; replayed?: boolean; evidence_source?: string } }
interface Rpc { ok?: boolean; error?: { code: string }; result?: { isError: boolean; structuredContent: Envelope; tools?: { name: string; annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean } }[] } }
interface Tool { name: string; annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean } }

let app: App;
before(async () => { app = await harness({ through: 9999 }); });
after(async () => { await app?.close(); });

const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

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
  return res.body.result!.structuredContent;
}
function codeOf(res: { body: Rpc }): string {
  if (res.body.error) return 'RPC:' + res.body.error.code;
  assert.equal(res.body.result?.isError, true, JSON.stringify(res.body));
  const envelope = res.body.result?.structuredContent;
  assert.ok(envelope, JSON.stringify(res.body));
  return envelope.error?.code ?? '';
}

async function post(key: string, text: string): Promise<{ id: string; created_at: string }> {
  const response = await app.mf.dispatchFetch('http://127.0.0.1/api/v1/rooms/room_main/messages', { method: 'POST',
    headers: { Authorization: 'Bearer ' + ALPHA, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ schema_version: '1', text }) });
  const body = await response.json() as { data: { message: { id: string; created_at: string } } };
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.data.message;
}

async function emit(messageId: string, createdAt: string, attempts: number, eventId?: string): Promise<{ id: string; eventId: string }> {
  const id = crypto.randomUUID();
  const at = Date.parse(createdAt) + 1000;
  const payload: Record<string, string> = { type: 'workroom.message', delivery_id: id, message_id: messageId, recipient: BETA_ID };
  if (eventId) payload.event_id = eventId;
  await app.db.prepare(`INSERT INTO webhook_outbox(id,principal_id,message_id,payload_json,status,attempts,next_at,created_at) VALUES (?,?,?,?,'delivered',?,?,?)`)
    .bind(id, BETA_ID, messageId, JSON.stringify(payload), attempts, at, at).run();
  return { id, eventId: eventId ?? id };
}

function relay(messageId: string, deliveryId: string, eventId: string, createdAt: string, source: 'webhook' | 'relay' | 'poll') {
  return { delivery_id: deliveryId, event_id: eventId, message_id: messageId, agent: BETA_ID, received_at: plus(createdAt, 2000), signature_verified: true, source };
}
function host(deliveryId: string, eventId: string, createdAt: string, cause: 'delivery' | 'schedule' | 'manual', runId: string) {
  return { run_id: runId, delivery_id: deliveryId, event_id: eventId, agent: BETA_ID, started_at: plus(createdAt, 3000), cause };
}
function read(messageId: string, createdAt: string, runId: string) {
  return { run_id: runId, message_id: messageId, agent: BETA_ID, read_at: plus(createdAt, 4000), principal_authenticated: true, outcome_ref: 'out-proven-1' };
}

async function chain(messageId: string, createdAt: string, deliveryId: string, eventId: string, prefix: string, source: 'webhook' | 'relay' | 'poll', cause: 'delivery' | 'schedule' | 'manual') {
  const runId = prefix + '-run';
  const reported = ok(await call(app, BETA, 'workroom_wake_report', { message_id: messageId, idempotency_key: prefix + '-relay-01', stage: 'relay_receipt', relay_receipt: relay(messageId, deliveryId, eventId, createdAt, source) }));
  assert.equal(reported.data.principal_id, BETA_ID);
  ok(await call(app, BETA, 'workroom_wake_report', { message_id: messageId, idempotency_key: prefix + '-host-001', stage: 'host_run', host_run: host(deliveryId, eventId, createdAt, cause, runId) }));
  ok(await call(app, BETA, 'workroom_wake_report', { message_id: messageId, idempotency_key: prefix + '-read-001', stage: 'read_outcome', read_outcome: read(messageId, createdAt, runId) }));
  return reported;
}

test('wake report and proof use server records and host-reported stages', async () => {
  assert.equal(READ_TOOLS.has('workroom_wake_proof'), true);
  assert.equal(READ_TOOLS.has('workroom_wake_report'), false);
  assert.equal(WAKE_EVIDENCE_SOURCE, SOURCE);
  const listed = await rpc(app, ALPHA, 'tools/list', {});
  const tools = (listed.body.result?.tools ?? []) as Tool[];
  const reportTool = tools.find(tool => tool.name === 'workroom_wake_report');
  const proofTool = tools.find(tool => tool.name === 'workroom_wake_proof');
  assert.ok(reportTool, JSON.stringify(tools.map(tool => tool.name)));
  assert.ok(proofTool);
  assert.equal(reportTool?.annotations?.readOnlyHint, false);
  assert.equal(reportTool?.annotations?.idempotentHint, true);
  assert.equal(proofTool?.annotations?.readOnlyHint, true);
  assert.equal((await app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wake_evidence'").first<{ name: string }>())?.name, 'wake_evidence');
  await app.db.prepare("INSERT INTO agent_aliases(alias, principal_id) VALUES ('beta-alias', 'synthetic:beta')").run();

  const message = await post('wake-post-proven-001', '@everyone wake chain');
  const eventId = 'evt-proven-0001';
  const delivery = await emit(message.id, message.created_at, 1, eventId);
  const first = await chain(message.id, message.created_at, delivery.id, delivery.eventId, 'wake-proven', 'webhook', 'delivery');
  assert.equal(first.data.replayed, false);
  assert.equal(first.data.timestamps.recorded_at.authority, 'server');
  assert.equal(first.data.timestamps.claimed.authority, 'host-reported');
  assert.equal(first.data.timestamps.claimed.server_verified, false);
  assert.equal(first.data.timestamps.claimed.values.received_at, plus(message.created_at, 2000));
  assert.notEqual(first.data.recorded_at, first.data.timestamps.claimed.values.received_at);
  assert.match(first.meta.note ?? '', /not server-verified/);
  assert.equal(first.data.payload.agent, BETA_ID);

  const proof = ok(await call(app, ALPHA, 'workroom_wake_proof', { message_id: message.id, agent: 'beta-alias' }));
  assert.equal(proof.data.agent, BETA_ID);
  assert.equal(proof.data.verdict, 'proven', JSON.stringify(proof.data));
  for (const name of ['persisted', 'emitted', 'relay_receipt', 'host_run', 'read_outcome'] as const) assert.equal(proof.data.stages[name].status, 'proven', name + JSON.stringify(proof.data.stages[name]));
  assert.equal(proof.data.stages.emitted.ids.delivery_id, delivery.id);
  assert.equal(proof.data.stages.emitted.ids.event_id, eventId);
  assert.equal(proof.data.stages.emitted.ids.attempt, 1);
  assert.equal(proof.data.evidence_source, SOURCE);
  assert.ok(proof.data.notes.includes(SOURCE));
  assert.equal(proof.data.time_authority.persisted, 'server');
  assert.equal(proof.data.time_authority.emitted, 'server');
  assert.equal(proof.data.time_authority.relay_receipt, 'host-reported');
  assert.equal(proof.data.time_authority.host_run, 'host-reported');
  assert.equal(proof.data.time_authority.read_outcome, 'host-reported');
  assert.equal(ok(await call(app, READER, 'workroom_wake_proof', { message_id: message.id, agent: BETA_ID })).data.verdict, 'proven');
  const outsider = await call(app, OUTSIDER, 'workroom_wake_proof', { message_id: message.id, agent: BETA_ID });
  assert.equal(outsider.status, 403);
  assert.equal(outsider.body.error?.code, 'FORBIDDEN');

  const replay = ok(await call(app, BETA, 'workroom_wake_report', { message_id: message.id, idempotency_key: 'wake-proven-relay-01', stage: 'relay_receipt', relay_receipt: relay(message.id, delivery.id, delivery.eventId, message.created_at, 'webhook') }));
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.id, first.data.id);
  assert.equal(replay.data.recorded_at, first.data.recorded_at);
  assert.equal(replay.meta.replayed, true);
  const changed = relay(message.id, delivery.id, delivery.eventId, message.created_at, 'webhook');
  changed.received_at = plus(message.created_at, 2500);
  assert.equal(codeOf(await call(app, BETA, 'workroom_wake_report', { message_id: message.id, idempotency_key: 'wake-proven-relay-01', stage: 'relay_receipt', relay_receipt: changed })), 'IDEMPOTENCY_CONFLICT');
  const stored = await app.db.prepare('SELECT count(*) AS n, payload_json FROM wake_evidence WHERE principal_id=? AND idempotency_key=?')
    .bind(BETA_ID, 'wake-proven-relay-01').first<{ n: number; payload_json: string }>();
  assert.equal(Number(stored?.n), 1);
  assert.equal(JSON.parse(stored?.payload_json ?? '{}').received_at, plus(message.created_at, 2000));
  assert.equal(ok(await call(app, ALPHA, 'workroom_wake_proof', { message_id: message.id, agent: BETA_ID })).data.verdict, 'proven');

  const cross = await call(app, ALPHA, 'workroom_wake_report', { message_id: message.id, idempotency_key: 'wake-cross-agent-01', stage: 'relay_receipt', relay_receipt: relay(message.id, delivery.id, delivery.eventId, message.created_at, 'webhook') });
  assert.equal(codeOf(cross), 'FORBIDDEN');
  assert.match(cross.body.result?.structuredContent.error?.message ?? '', /own wake evidence/);
  assert.equal(Number((await app.db.prepare('SELECT count(*) AS n FROM wake_evidence WHERE idempotency_key=?').bind('wake-cross-agent-01').first<{ n: number }>())?.n), 0);
  const smuggled = await call(app, ALPHA, 'workroom_wake_report', { message_id: message.id, idempotency_key: 'wake-cross-field-01', stage: 'relay_receipt', principal_id: BETA_ID, relay_receipt: { ...relay(message.id, delivery.id, delivery.eventId, message.created_at, 'webhook'), agent: 'synthetic:alpha' } });
  assert.equal(smuggled.body.result?.isError, true, JSON.stringify(smuggled.body));
  assert.match(JSON.stringify(smuggled.body), /principal_id/);
  assert.equal(Number((await app.db.prepare('SELECT count(*) AS n FROM wake_evidence WHERE idempotency_key=?').bind('wake-cross-field-01').first<{ n: number }>())?.n), 0);

  const polled = await post('wake-post-poll-00001', '@everyone poll wake');
  const pollDelivery = await emit(polled.id, polled.created_at, 1, 'evt-poll-0001');
  await chain(polled.id, polled.created_at, pollDelivery.id, pollDelivery.eventId, 'wake-poll', 'poll', 'delivery');
  const pollProof = ok(await call(app, BETA, 'workroom_wake_proof', { message_id: polled.id, agent: BETA_ID }));
  assert.equal(pollProof.data.verdict, 'partial', JSON.stringify(pollProof.data.stages));
  assert.ok(pollProof.data.stages.relay_receipt.reasons.includes('source_poll'));

  const scheduled = await post('wake-post-sched-0001', '@everyone schedule wake');
  const schedDelivery = await emit(scheduled.id, scheduled.created_at, 1, 'evt-sched-0001');
  await chain(scheduled.id, scheduled.created_at, schedDelivery.id, schedDelivery.eventId, 'wake-sched', 'webhook', 'schedule');
  const schedProof = ok(await call(app, BETA, 'workroom_wake_proof', { message_id: scheduled.id, agent: BETA_ID }));
  assert.equal(schedProof.data.verdict, 'partial', JSON.stringify(schedProof.data.stages));
  assert.ok(schedProof.data.stages.host_run.reasons.includes('cause_schedule'));

  const quiet = await post('wake-post-quiet-0001', 'status update for the room');
  const quietDelivery = await emit(quiet.id, quiet.created_at, 1, 'evt-quiet-0001');
  await chain(quiet.id, quiet.created_at, quietDelivery.id, quietDelivery.eventId, 'wake-quiet', 'webhook', 'delivery');
  const quietProof = ok(await call(app, ALPHA, 'workroom_wake_proof', { message_id: quiet.id, agent: BETA_ID }));
  assert.equal(quietProof.data.verdict, 'unproven', JSON.stringify(quietProof.data));
  assert.ok(quietProof.data.stages.persisted.reasons.includes('agent_not_mentioned'));
  assert.equal(quietProof.data.stages.emitted.status, 'proven');

  const plain = await post('wake-post-plain-0001', '@everyone plain delivery');
  const plainDelivery = await emit(plain.id, plain.created_at, 2);
  const plainProof = ok(await call(app, BETA, 'workroom_wake_proof', { message_id: plain.id, agent: BETA_ID }));
  assert.equal(plainProof.data.stages.emitted.status, 'proven', JSON.stringify(plainProof.data.stages.emitted));
  assert.equal(plainProof.data.stages.emitted.ids.delivery_id, plainDelivery.id);
  assert.equal(plainProof.data.stages.emitted.ids.event_id, plainDelivery.id);
  assert.equal(plainProof.data.stages.emitted.ids.attempt, 2);
  assert.equal(plainProof.data.verdict, 'partial');
});

test('missing wake tables are tolerated on proof and do not surface as storage faults', async () => {
  const current = await harness({ through: 25 });
  try {
    const created = '2026-10-24T00:00:00.000Z';
    const at = Date.parse(created) + 1000;
    await current.db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('wake-old-msg','room_main','synthetic:alpha','@everyone old','text',?)").bind(created).run();
    await current.db.prepare("INSERT INTO message_mentions(message_id,principal_id,via,seq) VALUES ('wake-old-msg','synthetic:beta','@everyone',1)").run();
    await current.db.prepare("INSERT INTO webhook_outbox(id,principal_id,message_id,payload_json,status,attempts,next_at,created_at) VALUES ('wake-old-del','synthetic:beta','wake-old-msg',?,'pending',1,?,?)")
      .bind(JSON.stringify({ type: 'workroom.message', delivery_id: 'wake-old-del', message_id: 'wake-old-msg' }), at, at).run();
    const proof = ok(await call(current, BETA, 'workroom_wake_proof', { message_id: 'wake-old-msg', agent: BETA_ID }));
    assert.equal(proof.data.verdict, 'partial', JSON.stringify(proof.data));
    assert.equal(proof.data.stages.persisted.status, 'proven');
    assert.equal(proof.data.stages.emitted.status, 'proven');
    assert.equal(proof.data.stages.relay_receipt.status, 'missing');
    assert.equal(proof.data.evidence_source, SOURCE);
    assert.equal(JSON.stringify(proof).includes('no such table'), false);
    const report = await call(current, BETA, 'workroom_wake_report', { message_id: 'wake-old-msg', idempotency_key: 'wake-old-report-1', stage: 'relay_receipt', relay_receipt: relay('wake-old-msg', 'wake-old-del', 'wake-old-del', created, 'webhook') });
    assert.equal(codeOf(report), 'NOT_AVAILABLE');
    assert.equal(JSON.stringify(report.body).includes('no such table'), false);
  } finally { await current.close(); }

  const older = await harness({ through: 8 });
  try {
    await older.db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('wake-ancient','room_main','synthetic:alpha','hello','text','2026-10-24T00:00:00.000Z')").run();
    const proof = ok(await call(older, ALPHA, 'workroom_wake_proof', { message_id: 'wake-ancient', agent: BETA_ID }));
    assert.equal(proof.data.verdict, 'unproven', JSON.stringify(proof.data));
    assert.ok(proof.data.stages.persisted.reasons.includes('agent_not_mentioned'));
    assert.equal(proof.data.stages.emitted.status, 'missing');
    assert.equal(JSON.stringify(proof).includes('no such table'), false);
  } finally { await older.close(); }
});

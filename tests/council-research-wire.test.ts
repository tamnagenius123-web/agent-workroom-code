import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { READ_TOOLS } from '../src/server/app.ts';
import {
  appendCouncilCorrection, openAgenda, sealBlindRound, sealChair, sealCrossRound, setOwnerAccepted,
  type CouncilRecord, type SeatNote,
} from '../src/server/council-record.ts';
import { incorporateResearchPacket, openResearchPacket, type ResearchPacket } from '../src/server/research-packet.ts';
import { harness } from '../scripts/local-harness.ts';

const ALPHA = 'local-alpha-fixture';
const BETA = 'local-beta-fixture';
const READER = 'local-reader-fixture';
const OUTSIDER = 'local-outsider-fixture';
const ALPHA_ID = 'synthetic:alpha';
const BETA_ID = 'synthetic:beta';
const READ_NAMES = ['workroom_council_get', 'workroom_research_get'] as const;
const WRITE_NAMES = [
  'workroom_council_agenda_open', 'workroom_council_blind_seal', 'workroom_council_cross_seal',
  'workroom_council_chair_seal', 'workroom_council_correct', 'workroom_council_owner_accept',
  'workroom_research_open', 'workroom_research_incorporate',
] as const;

const provenance = { kind: 'synthetic_fixture' as const, producer_id: 'producer_p2', source_ref: 'fixture:council-research' };
const EXECUTED = '2026-10-24T02:21:00.000Z';
const CORRECTED_AT = '2026-10-24T04:00:00.000Z';
const blindNotes: readonly SeatNote[] = [
  { member_id: 'member_dots', stance: 'dissent', text: 'Egress proof is still missing.' },
  { member_id: 'member_muse', stance: 'unknown', text: 'Content unknown from retrievable sources.', topic: 'MASS' },
  { member_id: 'member_grok', stance: 'assent', text: 'The agenda is in scope.' },
];
const crossNotes: readonly SeatNote[] = [
  { member_id: 'member_dots', stance: 'dissent', text: 'Cross round does not replace the blind objection.' },
];

type App = Awaited<ReturnType<typeof harness>>;
interface Envelope { ok: boolean; data: Record<string, unknown>; error?: { code: string; message: string }; meta: { replayed?: boolean } }
interface Rpc { ok?: boolean; error?: { code: string }; result?: { isError?: boolean; structuredContent?: Envelope; tools?: { name: string; annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean } }[] } }

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
function codeOf(res: { status: number; body: Rpc | Envelope }): string {
  const body = res.body as Rpc & Envelope;
  if (typeof body.ok === 'boolean') {
    assert.equal(body.ok, false, JSON.stringify(body));
    return body.error?.code ?? '';
  }
  if (body.error) return 'RPC:' + body.error.code;
  assert.equal(body.result?.isError, true, JSON.stringify(body));
  return body.result?.structuredContent?.error?.code ?? '';
}
function messageOf(res: { body: Rpc | Envelope }): string {
  return JSON.stringify(res.body);
}

async function rest(token: string, method: string, path: string, body?: object, key?: string): Promise<{ status: number; body: Envelope }> {
  const response = await app.mf.dispatchFetch('http://127.0.0.1' + path, { method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() as Envelope };
}
const must = <T>(result: { ok: true; value: T } | { ok: false; errors: string[] }, label: string): T => {
  assert.equal(result.ok, true, result.ok ? label : result.errors.join(' | '));
  if (!result.ok) throw new Error(label);
  return result.value;
};
async function countKey(table: 'council_records' | 'research_packets', actor: string, key: string): Promise<number> {
  const row = await app.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE actor_id=? AND idempotency_key=?`).bind(actor, key).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

test('council records and research packets persist through REST and MCP', async () => {
  for (const name of READ_NAMES) assert.equal(READ_TOOLS.has(name), true, name);
  for (const name of WRITE_NAMES) assert.equal(READ_TOOLS.has(name), false, name);
  const listed = await rpc(app, ALPHA, 'tools/list', {});
  const tools = listed.body.result?.tools ?? [];
  for (const name of WRITE_NAMES) {
    const tool = tools.find(item => item.name === name);
    assert.ok(tool, name);
    assert.equal(tool?.annotations?.readOnlyHint, false, name);
    assert.equal(tool?.annotations?.idempotentHint, true, name);
  }
  for (const name of READ_NAMES) {
    const tool = tools.find(item => item.name === name);
    assert.ok(tool, name);
    assert.equal(tool?.annotations?.readOnlyHint, true, name);
  }
  assert.equal((await app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='council_records'").first<{ name: string }>())?.name, 'council_records');
  assert.equal((await app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='research_packets'").first<{ name: string }>())?.name, 'research_packets');

  const agendaInput = { agenda_id: 'agenda_wire_001', consumer: 'P3' as const, provenance, proof_mode: 'synthetic' as const, owner_report_ref: 'report_owner_001' };
  const agenda = must(openAgenda(agendaInput), 'agenda');
  const opened = ok(await call(app, ALPHA, 'workroom_council_agenda_open', { idempotency_key: 'council-open-agenda-01', ...agendaInput }));
  assert.equal(opened.data.replayed, false);
  assert.equal(opened.data.actor_id, ALPHA_ID);
  assert.equal(opened.data.owner_principal_id, ALPHA_ID);
  assert.equal(opened.data.stage, 'agenda');
  assert.deepEqual(opened.data.record, agenda);
  assert.notEqual(opened.data.recorded_at, EXECUTED);
  assert.equal(typeof opened.data.recorded_at, 'string');

  const restReplay = await rest(ALPHA, 'POST', '/api/v1/rooms/room_main/council/agendas', { schema_version: '1', ...agendaInput }, 'council-open-agenda-01');
  assert.equal(restReplay.status, 200, JSON.stringify(restReplay.body));
  assert.equal(restReplay.body.data.replayed, true);
  assert.equal(restReplay.body.meta.replayed, true);
  assert.equal(restReplay.body.data.id, opened.data.id);
  assert.deepEqual(restReplay.body.data.record, agenda);
  assert.equal(await countKey('council_records', ALPHA_ID, 'council-open-agenda-01'), 1);

  const conflict = await call(app, ALPHA, 'workroom_council_agenda_open', { idempotency_key: 'council-open-agenda-01', ...agendaInput, agenda_id: 'agenda_wire_other' });
  assert.equal(codeOf(conflict), 'IDEMPOTENCY_CONFLICT');
  assert.equal(await countKey('council_records', ALPHA_ID, 'council-open-agenda-01'), 1);
  assert.equal(Number((await app.db.prepare("SELECT count(*) AS n FROM council_records WHERE agenda_id='agenda_wire_other'").first<{ n: number }>())?.n), 0);

  const smuggled = await call(app, ALPHA, 'workroom_council_agenda_open', { idempotency_key: 'council-smuggle-owner1', ...agendaInput, agenda_id: 'agenda_wire_smuggle', principal_id: BETA_ID, owner_principal_id: BETA_ID });
  assert.equal(codeOf(smuggled), 'INVALID_INPUT');
  assert.match(messageOf(smuggled), /principal_id/);
  assert.equal(await countKey('council_records', ALPHA_ID, 'council-smuggle-owner1'), 0);

  const authority = await rest(ALPHA, 'POST', '/api/v1/rooms/room_main/council/agendas', { schema_version: '1', ...agendaInput, agenda_id: 'agenda_wire_auth', authority: ['budget'] }, 'council-authority-0001');
  assert.equal(authority.status, 400);
  assert.equal(codeOf(authority), 'INVALID_INPUT');
  assert.match(authority.body.error?.message ?? '', /budget is a forbidden authority/);
  assert.equal(await countKey('council_records', ALPHA_ID, 'council-authority-0001'), 0);

  const live = await call(app, ALPHA, 'workroom_council_agenda_open', { idempotency_key: 'council-live-proof-001', ...agendaInput, agenda_id: 'agenda_wire_live', proof_mode: 'live' });
  assert.equal(codeOf(live), 'INVALID_INPUT');
  assert.match(messageOf(live), /synthetic proof cannot validate as live/);
  assert.equal(await countKey('council_records', ALPHA_ID, 'council-live-proof-001'), 0);

  const early = ok(await call(app, READER, 'workroom_council_get', { agenda_id: 'agenda_wire_001' }));
  assert.equal(early.data.owner_principal_id, ALPHA_ID);
  assert.deepEqual(early.data.agenda, agenda);
  assert.equal(early.data.blind, null);
  assert.equal(early.data.cross, null);
  assert.equal(early.data.record, null);
  const earlyRest = await rest(READER, 'GET', '/api/v1/rooms/room_main/council/agendas/agenda_wire_001');
  assert.equal(earlyRest.status, 200);
  assert.deepEqual(earlyRest.body.data.agenda, agenda);
  assert.equal(codeOf(await call(app, OUTSIDER, 'workroom_council_get', { agenda_id: 'agenda_wire_001' })), 'FORBIDDEN');
  assert.equal((await rest(OUTSIDER, 'GET', '/api/v1/rooms/room_main/council/agendas/agenda_wire_001')).status, 403);
  assert.equal(codeOf(await call(app, READER, 'workroom_council_blind_seal', { idempotency_key: 'council-reader-blind01', agenda_id: 'agenda_wire_001', record_ref: 'round_blind_wire', notes: [] })), 'FORBIDDEN');
  assert.equal((await rest(READER, 'POST', '/api/v1/rooms/room_main/council/agendas/agenda_wire_001/blind', { schema_version: '1', record_ref: 'round_blind_wire', notes: [] }, 'council-reader-rest-01')).status, 403);
  assert.equal(await countKey('council_records', 'synthetic:reader', 'council-reader-blind01'), 0);

  const badNotes = await call(app, BETA, 'workroom_council_blind_seal', { idempotency_key: 'council-bad-notes-001', agenda_id: 'agenda_wire_001', record_ref: 'round_blind_bad', notes: [{ member_id: 'member_muse', stance: 'unknown', text: 'No topic given.' }] });
  assert.equal(codeOf(badNotes), 'INVALID_INPUT');
  assert.match(messageOf(badNotes), /topic/);
  assert.equal(await countKey('council_records', BETA_ID, 'council-bad-notes-001'), 0);

  const blind = must(sealBlindRound(agenda, { record_ref: 'round_blind_wire', notes: blindNotes }), 'blind');
  const sealedBlind = ok(await call(app, BETA, 'workroom_council_blind_seal', { idempotency_key: 'council-blind-seal-001', agenda_id: 'agenda_wire_001', record_ref: 'round_blind_wire', notes: blindNotes }));
  assert.equal(sealedBlind.data.actor_id, BETA_ID);
  assert.equal(sealedBlind.data.owner_principal_id, ALPHA_ID);
  assert.equal(sealedBlind.data.stage, 'blind_r1');
  assert.deepEqual(sealedBlind.data.record, blind);
  const reseal = await call(app, ALPHA, 'workroom_council_blind_seal', { idempotency_key: 'council-blind-seal-002', agenda_id: 'agenda_wire_001', record_ref: 'round_blind_other', notes: [] });
  assert.equal(codeOf(reseal), 'INVALID_INPUT');
  assert.match(messageOf(reseal), /already sealed/);
  assert.equal(await countKey('council_records', ALPHA_ID, 'council-blind-seal-002'), 0);
  const blindReplay = ok(await call(app, BETA, 'workroom_council_blind_seal', { idempotency_key: 'council-blind-seal-001', agenda_id: 'agenda_wire_001', record_ref: 'round_blind_wire', notes: blindNotes }));
  assert.equal(blindReplay.data.replayed, true);
  assert.equal(blindReplay.data.id, sealedBlind.data.id);

  const chairInput = { chair_id: 'chair_muse', record_ref: 'chair_record_wire', summary: 'Advisory verdict recorded with dissent.', executed_at: EXECUTED };
  assert.equal(codeOf(await call(app, ALPHA, 'workroom_council_chair_seal', { idempotency_key: 'council-chair-before-01', agenda_id: 'agenda_wire_001', ...chairInput })), 'NOT_FOUND');
  assert.equal(await countKey('council_records', ALPHA_ID, 'council-chair-before-01'), 0);
  const cross = must(sealCrossRound(blind, { record_ref: 'round_cross_wire', notes: crossNotes }), 'cross');
  const sealedCross = ok(await call(app, ALPHA, 'workroom_council_cross_seal', { idempotency_key: 'council-cross-seal-001', agenda_id: 'agenda_wire_001', record_ref: 'round_cross_wire', notes: crossNotes }));
  assert.deepEqual(sealedCross.data.record, cross);
  assert.equal(codeOf(await call(app, ALPHA, 'workroom_council_chair_seal', { idempotency_key: 'council-chair-skip-001', agenda_id: 'agenda_missing', ...chairInput })), 'NOT_FOUND');
  const chair = must(sealChair(cross, chairInput), 'chair');
  const sealedChair = await rest(BETA, 'POST', '/api/v1/rooms/room_main/council/agendas/agenda_wire_001/chair', { schema_version: '1', ...chairInput, authority: ['budget'] }, 'council-chair-auth-0001');
  assert.equal(codeOf(sealedChair), 'INVALID_INPUT');
  assert.match(sealedChair.body.error?.message ?? '', /budget is a forbidden authority/);
  const chaired = ok(await call(app, BETA, 'workroom_council_chair_seal', { idempotency_key: 'council-chair-seal-001', agenda_id: 'agenda_wire_001', ...chairInput }));
  assert.equal(chaired.data.stage, 'sealed');
  assert.equal(chaired.data.record_id, 'chair_record_wire');
  assert.equal(chaired.data.actor_id, BETA_ID);
  assert.equal(chaired.data.owner_principal_id, ALPHA_ID);
  assert.deepEqual(chaired.data.record, chair);
  assert.equal((chaired.data.record as CouncilRecord).verdict.owner_accepted, null);
  assert.deepEqual((chaired.data.record as CouncilRecord).verdict.authority, []);
  assert.notEqual(chaired.data.recorded_at, EXECUTED);

  const denied = await call(app, BETA, 'workroom_council_owner_accept', { idempotency_key: 'council-beta-accept-01', record_id: 'chair_record_wire', accepted: true });
  assert.equal(codeOf(denied), 'FORBIDDEN');
  assert.match(messageOf(denied), /owner principal/);
  assert.equal(await countKey('council_records', BETA_ID, 'council-beta-accept-01'), 0);
  const acceptedPure = must(setOwnerAccepted(chair, true), 'accept');
  const accepted = ok(await call(app, ALPHA, 'workroom_council_owner_accept', { idempotency_key: 'council-owner-accept1', record_id: 'chair_record_wire', accepted: true }));
  assert.equal(accepted.data.stage, 'owner_accept');
  assert.equal(accepted.data.actor_id, ALPHA_ID);
  assert.equal(accepted.data.owner_principal_id, ALPHA_ID);
  assert.deepEqual(accepted.data.record, acceptedPure);
  assert.equal((accepted.data.record as CouncilRecord).verdict.owner_accepted, true);
  assert.equal((accepted.data.record as CouncilRecord).verdict.executes_immediately, true);
  assert.deepEqual((accepted.data.record as CouncilRecord).verdict.authority, []);
  const acceptReplay = await rest(ALPHA, 'POST', '/api/v1/rooms/room_main/council/records/chair_record_wire/owner-accept', { schema_version: '1', accepted: true }, 'council-owner-accept1');
  assert.equal(acceptReplay.status, 200, JSON.stringify(acceptReplay.body));
  assert.equal(acceptReplay.body.data.replayed, true);
  assert.equal(acceptReplay.body.data.id, accepted.data.id);
  const acceptFlip = await call(app, ALPHA, 'workroom_council_owner_accept', { idempotency_key: 'council-owner-accept1', record_id: 'chair_record_wire', accepted: false });
  assert.equal(codeOf(acceptFlip), 'IDEMPOTENCY_CONFLICT');
  assert.equal((JSON.parse(String((await app.db.prepare('SELECT payload_json FROM council_records WHERE actor_id=? AND idempotency_key=?').bind(ALPHA_ID, 'council-owner-accept1').first<{ payload_json: string }>())?.payload_json)) as CouncilRecord).verdict.owner_accepted, true);
  const notBoolean = await call(app, ALPHA, 'workroom_council_owner_accept', { idempotency_key: 'council-owner-bool-001', record_id: 'chair_record_wire', accepted: 'yes' });
  assert.equal(codeOf(notBoolean), 'INVALID_INPUT');
  assert.match(messageOf(notBoolean), /expected a boolean/);
  assert.equal(await countKey('council_records', ALPHA_ID, 'council-owner-bool-001'), 0);

  const self = await call(app, BETA, 'workroom_council_correct', { idempotency_key: 'council-correct-self01', record_id: 'chair_record_wire', correction_id: 'chair_record_wire', text: 'A correction must not point at itself.', at: CORRECTED_AT });
  assert.equal(codeOf(self), 'INVALID_INPUT');
  assert.match(messageOf(self), /self-reference/);
  assert.equal(await countKey('council_records', BETA_ID, 'council-correct-self01'), 0);
  const correctionInput = { correction_id: 'corr_wire_001', text: 'Record the dissent in the owner report.', at: CORRECTED_AT };
  const correctedPure = must(appendCouncilCorrection(acceptedPure, correctionInput), 'correction');
  const corrected = ok(await call(app, BETA, 'workroom_council_correct', { idempotency_key: 'council-correct-00001', record_id: 'chair_record_wire', ...correctionInput }));
  assert.equal(corrected.data.stage, 'correction');
  assert.equal(corrected.data.actor_id, BETA_ID);
  assert.equal(corrected.data.owner_principal_id, ALPHA_ID);
  assert.equal(corrected.data.record_id, 'corr_wire_001');
  assert.deepEqual(corrected.data.record, correctedPure);
  assert.equal((corrected.data.record as CouncilRecord).corrects, 'chair_record_wire');
  assert.equal((corrected.data.record as CouncilRecord).verdict.owner_accepted, true);
  const dup = await call(app, ALPHA, 'workroom_council_correct', { idempotency_key: 'council-correct-00002', record_id: 'corr_wire_001', correction_id: 'corr_wire_001', text: 'A reused id must not rewrite the linked correction.', at: '2026-10-24T05:00:00.000Z' });
  assert.equal(codeOf(dup), 'INVALID_INPUT');
  assert.match(messageOf(dup), /duplicate correction_id/);

  const chain = ok(await call(app, READER, 'workroom_council_get', { agenda_id: 'agenda_wire_001' }));
  assert.deepEqual(chain.data.agenda, agenda);
  assert.deepEqual(chain.data.blind, blind);
  assert.deepEqual(chain.data.cross, cross);
  assert.deepEqual(chain.data.record, correctedPure);
  const byRecord = await rest(BETA, 'GET', '/api/v1/rooms/room_main/council/records/chair_record_wire');
  assert.equal(byRecord.status, 200);
  assert.deepEqual(byRecord.body.data.record, acceptedPure);
  assert.equal((byRecord.body.data.record as CouncilRecord).verdict.corrections.length, 0);
  const byCorrection = ok(await call(app, ALPHA, 'workroom_council_get', { record_id: 'corr_wire_001' }));
  assert.deepEqual(byCorrection.data.record, correctedPure);
  assert.equal((await rest(ALPHA, 'GET', '/api/v1/rooms/room_main/council/agendas/agenda_missing')).status, 404);
  assert.equal((await rest(ALPHA, 'GET', '/api/v1/rooms/room_main/council/agendas')).status, 405);
  assert.equal((await rest(ALPHA, 'POST', '/api/v1/rooms/room_main/council/agendas', { schema_version: '1', ...agendaInput, agenda_id: 'agenda_wire_nokey' })).status, 400);
  assert.equal(codeOf(await call(app, ALPHA, 'workroom_council_get', { agenda_id: 'agenda_wire_001', record_id: 'chair_record_wire' })), 'INVALID_INPUT');

  const researchBody = {
    schema_version: '1', consumer: 'P4', provenance: { kind: 'synthetic_fixture', producer_id: 'producer_p3', source_ref: 'fixture:research-packet' },
    proof_mode: 'synthetic', task_id: 'research_wire_001', applicability: 'required', hypothesis: 'A named consumer raises closure rate.',
    discriminator: 'consumer present vs absent', edv_band: 'mid', frontier_class: 'dispatch', incorporated_by: null, intent_rev: 'intent_wire_001',
  };
  const packet = must(openResearchPacket(researchBody), 'packet');
  const researchOpen = ok(await call(app, ALPHA, 'workroom_research_open', { idempotency_key: 'research-open-000001', ...researchBody }));
  assert.equal(researchOpen.data.stage, 'open');
  assert.equal(researchOpen.data.actor_id, ALPHA_ID);
  assert.equal(researchOpen.data.opened_by, ALPHA_ID);
  assert.deepEqual(researchOpen.data.record, packet);
  const researchRest = await rest(ALPHA, 'POST', '/api/v1/rooms/room_main/research/packets', researchBody, 'research-open-000001');
  assert.equal(researchRest.status, 200, JSON.stringify(researchRest.body));
  assert.equal(researchRest.body.data.replayed, true);
  assert.equal(researchRest.body.data.id, researchOpen.data.id);
  const researchConflict = await call(app, ALPHA, 'workroom_research_open', { idempotency_key: 'research-open-000001', ...researchBody, hypothesis: 'A different hypothesis.' });
  assert.equal(codeOf(researchConflict), 'IDEMPOTENCY_CONFLICT');
  assert.equal(await countKey('research_packets', ALPHA_ID, 'research-open-000001'), 1);
  const extra = await call(app, BETA, 'workroom_research_open', { idempotency_key: 'research-extra-field01', ...researchBody, task_id: 'research_wire_extra', note: 'x' });
  assert.equal(codeOf(extra), 'INVALID_INPUT');
  assert.match(messageOf(extra), /unknown field/);
  assert.equal(await countKey('research_packets', BETA_ID, 'research-extra-field01'), 0);
  const named = await call(app, ALPHA, 'workroom_research_open', { idempotency_key: 'research-named-owner01', ...researchBody, task_id: 'research_wire_named', principal_id: BETA_ID });
  assert.equal(codeOf(named), 'INVALID_INPUT');
  assert.match(messageOf(named), /principal_id/);
  assert.equal(await countKey('research_packets', ALPHA_ID, 'research-named-owner01'), 0);

  const stale = await call(app, BETA, 'workroom_research_incorporate', { idempotency_key: 'research-stale-intent1', task_id: 'research_wire_001', msg_id: 'msg_wire_001', intent_rev: 'intent_999' });
  assert.equal(codeOf(stale), 'INVALID_INPUT');
  assert.match(messageOf(stale), /intent revision the packet was opened under/);
  assert.equal(await countKey('research_packets', BETA_ID, 'research-stale-intent1'), 0);
  const incorporated = must(incorporateResearchPacket(packet, { msg_id: 'msg_wire_001', intent_rev: 'intent_wire_001' }), 'incorporate');
  const cited = await rest(BETA, 'POST', '/api/v1/rooms/room_main/research/packets/research_wire_001/incorporate', { schema_version: '1', msg_id: 'msg_wire_001', intent_rev: 'intent_wire_001' }, 'research-incorporate-1');
  assert.equal(cited.status, 200, JSON.stringify(cited.body));
  assert.equal(cited.body.data.actor_id, BETA_ID);
  assert.equal(cited.body.data.opened_by, ALPHA_ID);
  assert.deepEqual(cited.body.data.record, incorporated);
  assert.equal((cited.body.data.record as ResearchPacket).task.incorporated_by, 'msg_wire_001');
  const again = ok(await call(app, ALPHA, 'workroom_research_incorporate', { idempotency_key: 'research-incorporate-2', task_id: 'research_wire_001', msg_id: 'msg_wire_001', intent_rev: 'intent_wire_001' }));
  assert.deepEqual(again.data.record, incorporated);
  const replaced = await call(app, ALPHA, 'workroom_research_incorporate', { idempotency_key: 'research-incorporate-3', task_id: 'research_wire_001', msg_id: 'msg_wire_002', intent_rev: 'intent_wire_001' });
  assert.equal(codeOf(replaced), 'INVALID_INPUT');
  assert.match(messageOf(replaced), /already incorporated/);
  const seen = ok(await call(app, READER, 'workroom_research_get', { task_id: 'research_wire_001' }));
  assert.deepEqual(seen.data.record, incorporated);
  assert.equal(seen.data.opened_by, ALPHA_ID);
  assert.equal(codeOf(await call(app, OUTSIDER, 'workroom_research_get', { task_id: 'research_wire_001' })), 'FORBIDDEN');
  assert.equal((await rest(OUTSIDER, 'GET', '/api/v1/rooms/room_main/research/packets/research_wire_001')).status, 403);
  assert.equal(codeOf(await call(app, READER, 'workroom_research_incorporate', { idempotency_key: 'research-reader-incorp', task_id: 'research_wire_001', msg_id: 'msg_wire_001', intent_rev: 'intent_wire_001' })), 'FORBIDDEN');

  const naBody = {
    schema_version: '1', consumer: 'P2', provenance: researchBody.provenance, proof_mode: 'synthetic', task_id: 'research_wire_na',
    applicability: 'not_applicable', reason: 'Deterministic ledger write; research is not a prerequisite.', incorporated_by: null, intent_rev: 'intent_wire_na',
  };
  const na = must(openResearchPacket(naBody), 'na');
  const naOpen = await rest(ALPHA, 'POST', '/api/v1/rooms/room_main/research/packets', naBody, 'research-na-open-0001');
  assert.equal(naOpen.status, 200, JSON.stringify(naOpen.body));
  assert.deepEqual(naOpen.body.data.record, na);
  assert.equal((naOpen.body.data.record as ResearchPacket).task.applicability, 'not_applicable');
  assert.equal('hypothesis' in ((naOpen.body.data.record as ResearchPacket).task), false);
  const naCited = must(incorporateResearchPacket(na, { msg_id: 'msg_na_wire', intent_rev: 'intent_wire_na' }), 'na cite');
  const naInc = ok(await call(app, ALPHA, 'workroom_research_incorporate', { idempotency_key: 'research-na-incorp-01', task_id: 'research_wire_na', msg_id: 'msg_na_wire', intent_rev: 'intent_wire_na' }));
  assert.deepEqual(naInc.data.record, naCited);
  assert.equal((await rest(ALPHA, 'GET', '/api/v1/rooms/room_main/research/packets/research_missing')).status, 404);
  assert.equal((await rest(ALPHA, 'POST', '/api/v1/rooms/room_main/research/packets', { ...naBody, task_id: 'research_wire_path', room: 'room_main' }, 'research-path-field-01')).status, 400);
});

test('missing council and research tables do not surface as storage faults', async () => {
  const current = await harness({ through: 27 });
  try {
    const opened = await call(current, ALPHA, 'workroom_council_agenda_open', { idempotency_key: 'council-old-open-0001', agenda_id: 'agenda_old', consumer: 'P3', provenance, proof_mode: 'synthetic', owner_report_ref: 'report_old' });
    assert.equal(codeOf(opened), 'NOT_AVAILABLE');
    assert.equal(messageOf(opened).includes('no such table'), false);
    const read = await call(current, ALPHA, 'workroom_council_get', { agenda_id: 'agenda_old' });
    assert.equal(codeOf(read), 'NOT_AVAILABLE');
    assert.equal(messageOf(read).includes('no such table'), false);
    const packet = await call(current, ALPHA, 'workroom_research_open', {
      idempotency_key: 'research-old-open-001', schema_version: '1', consumer: 'P4', provenance, proof_mode: 'synthetic',
      task_id: 'research_old', applicability: 'not_applicable', reason: 'No table yet.', incorporated_by: null, intent_rev: 'intent_old',
    });
    assert.equal(codeOf(packet), 'NOT_AVAILABLE');
    assert.equal(messageOf(packet).includes('no such table'), false);
    const got = await call(current, READER, 'workroom_research_get', { task_id: 'research_old' });
    assert.equal(codeOf(got), 'NOT_AVAILABLE');
    assert.equal(JSON.stringify(got.body).includes('no such table'), false);
  } finally { await current.close(); }
});

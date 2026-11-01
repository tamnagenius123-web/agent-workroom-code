// D1 + REST + MCP wiring for the pure council record and research packet modules.
// Those modules are the only domain validators. Identity comes from the caller, never the body.
// The agenda opener is the owner principal and is the only caller who may set owner_accepted.

import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ID_RE, type PhaseCheck } from '../phase-contracts/check.ts';
import {
  appendCouncilCorrection, openAgenda, sealBlindRound, sealChair, sealCrossRound, setOwnerAccepted,
  type AgendaInput, type AgendaRecord, type BlindRoundRecord, type ChairInput, type CorrectionInput,
  type CouncilRecord, type CrossRoundRecord, type RoundInput,
} from './council-record.ts';
import { incorporateResearchPacket, openResearchPacket, type ResearchPacket } from './research-packet.ts';
import { Fault, baseSchema, keySchema } from './contracts.ts';
import type { Database, Value } from './db.ts';

const COUNCIL_GET = 'workroom_council_get';
const RESEARCH_GET = 'workroom_research_get';
export const COUNCIL_RESEARCH_READ_TOOLS = [COUNCIL_GET, RESEARCH_GET] as const;

const AGENDA_OPEN = 'workroom_council_agenda_open';
const BLIND_SEAL = 'workroom_council_blind_seal';
const CROSS_SEAL = 'workroom_council_cross_seal';
const CHAIR_SEAL = 'workroom_council_chair_seal';
const CORRECT = 'workroom_council_correct';
const OWNER_ACCEPT = 'workroom_council_owner_accept';
const RESEARCH_OPEN = 'workroom_research_open';
const RESEARCH_INCORPORATE = 'workroom_research_incorporate';

const AGENDA_TEXT = 'Open a council agenda in the room. The authenticated caller becomes the owner principal. principal_id and owner_principal_id cannot be supplied. The same idempotency key and body replay; a different body conflicts. The council record module validates the agenda.';
const BLIND_TEXT = 'Seal blind_r1 on an open agenda. Any room writer may seal. The owner principal stays the agenda opener. The council record module validates the notes.';
const CROSS_TEXT = 'Seal cross_r2 on a sealed blind round. Any room writer may seal. The council record module validates the notes.';
const CHAIR_TEXT = 'Seal the chair verdict. It executes immediately and grants no release, security, or budget authority. owner_accepted stays null. executed_at is caller-supplied; recorded_at is server time.';
const CORRECT_TEXT = 'Append a correction snapshot linked to the current record. Any room writer may append. The council record module rejects duplicate and self-referential correction ids.';
const ACCEPT_TEXT = 'Set owner_accepted on one council record. Only the owner principal (the authenticated agenda opener) may call this. The bit stays separate from execution and grants no authority.';
const COUNCIL_GET_TEXT = 'Read a council agenda chain, or one record snapshot, for a room member. blind, cross, and the head record are null until sealed.';
const RESEARCH_OPEN_TEXT = 'Open a research packet under an intent revision. incorporated_by stays null. The research packet module validates required and not_applicable bodies. Identity is not taken from the body.';
const RESEARCH_INCORPORATE_TEXT = 'Incorporate a research packet by citing msg_id and the intent_rev it was opened under. A different intent revision is not incorporation. The same citation replays; a different message conflicts once incorporated.';
const RESEARCH_GET_TEXT = 'Read the latest research packet for a task. Any room member may read. opened_by is the authenticated opener.';

// Transport envelopes only. Field checks stay in the pure modules. catchall keeps smuggled keys for the handler.
const wireRoom = z.string().min(1).max(128);
const wireId = z.string().min(1).max(128);
const councilAgendaSchema = baseSchema.extend({ room: wireRoom, idempotency_key: keySchema }).catchall(z.unknown());
const councilBlindSchema = baseSchema.extend({ room: wireRoom, idempotency_key: keySchema, agenda_id: wireId }).catchall(z.unknown());
const councilCrossSchema = councilBlindSchema;
const councilChairSchema = councilBlindSchema;
const councilCorrectSchema = baseSchema.extend({ room: wireRoom, idempotency_key: keySchema, record_id: wireId }).catchall(z.unknown());
const councilAcceptSchema = baseSchema.extend({ room: wireRoom, idempotency_key: keySchema, record_id: wireId }).catchall(z.unknown());
const councilGetSchema = baseSchema.extend({ room: wireRoom, agenda_id: wireId.optional(), record_id: wireId.optional() }).strict();
const researchOpenSchema = baseSchema.extend({ room: wireRoom, idempotency_key: keySchema }).catchall(z.unknown());
const researchIncorporateSchema = baseSchema.extend({ room: wireRoom, idempotency_key: keySchema, task_id: wireId }).catchall(z.unknown());
const researchGetSchema = baseSchema.extend({ room: wireRoom, task_id: wireId }).strict();

const IDENTITY = ['principal_id', 'actor_id', 'owner_id', 'owner_principal_id', 'agent', 'created_by'] as const;
const COUNCIL_PATH = /^\/api\/v1\/rooms\/([^/]+)\/council\/(agendas|records)(?:\/([^/]+)(?:\/(blind|cross|chair|corrections|owner-accept))?)?$/;
const RESEARCH_PATH = /^\/api\/v1\/rooms\/([^/]+)\/research\/packets(?:\/([^/]+)(?:\/(incorporate))?)?$/;

interface Service {
  readonly database: Database;
  readonly principal: string;
  authorize(room?: string, write?: boolean): Promise<void>;
}
interface WireResult { data: Record<string, unknown>; meta: { replayed?: boolean } }
interface CouncilRow {
  id: string; room_id: string; agenda_id: string; stage: string; record_id: string | null; corrects: string | null;
  owner_principal_id: string; actor_id: string; request_json: string; payload_json: string; idempotency_key: string;
  recorded_at: number | string;
}
interface ResearchRow {
  id: string; room_id: string; task_id: string; intent_rev: string; kind: string; actor_id: string;
  request_json: string; payload_json: string; idempotency_key: string; recorded_at: number | string;
}

function rejectIdentity(body: object): void {
  const found = IDENTITY.filter(key => key in body);
  if (found.length > 0) throw new Fault('INVALID_INPUT', `${found.join(', ')} is derived from the authenticated caller and cannot be supplied.`);
}
function domainBody(parsed: object, drop: readonly string[]): Record<string, unknown> {
  rejectIdentity(parsed);
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) if (!drop.includes(key)) body[key] = value;
  return body;
}
function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new Fault('INVALID_INPUT', `unknown field ${JSON.stringify(key)}`);
}
function version(body: Record<string, unknown>): void {
  if (body.schema_version !== '1') throw new Fault('INVALID_INPUT', 'Input does not match the G1 schema.');
}
function phase<T>(result: PhaseCheck<T>): T {
  if (!result.ok) throw new Fault('INVALID_INPUT', result.errors.join(' | '));
  return result.value;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}
function iso(value: number | string): string {
  return new Date(typeof value === 'number' ? value : Number(value)).toISOString();
}
function stored<T>(json: string): T {
  try { return JSON.parse(json) as T; } catch { throw new Fault('INVALID_INPUT', 'Stored record is unreadable.'); }
}
function pathRoom(raw: string): string {
  try { return decodeURIComponent(raw); } catch { throw new Fault('INVALID_INPUT', 'Invalid path encoding.'); }
}
function pathId(raw: string, label: string): string {
  const value = pathRoom(raw);
  if (!ID_RE.test(value)) throw new Fault('INVALID_INPUT', `${label} is not a valid id.`);
  return value;
}
function idempotencyKey(request: Request): string {
  return keySchema.parse(request.headers.get('idempotency-key'));
}
async function readRecord(readJSON: () => Promise<unknown>, forbidden: readonly string[]): Promise<Record<string, unknown>> {
  const raw = await readJSON();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Fault('INVALID_INPUT', 'JSON object required.');
  const body = raw as Record<string, unknown>;
  rejectIdentity(body);
  for (const key of forbidden) if (key in body) throw new Fault('INVALID_INPUT', `${key} cannot be supplied in the body.`);
  version(body);
  return body;
}
async function tableExists(db: Database, table: 'council_records' | 'research_packets'): Promise<boolean> {
  try { await db.prepare(`SELECT 1 FROM ${table} LIMIT 0`).all(); return true; }
  catch (error) {
    if (/no such table/i.test(String((error as { message?: string })?.message ?? error))) return false;
    throw error;
  }
}
function storageFault(error: unknown, already: string): unknown {
  const text = String((error as { message?: string })?.message ?? error);
  if (/no such table/i.test(text)) return new Fault('NOT_AVAILABLE', 'Council or research storage is not installed.', 400, 'not_applied');
  if (/UNIQUE constraint failed/i.test(text)) return new Fault('INVALID_INPUT', already);
  return error;
}

class CouncilResearchWire {
  constructor(private service: Service) {}
  private get db(): Database { return this.service.database; }
  private get principal(): string { return this.service.principal; }

  private async ready(table: 'council_records' | 'research_packets', label: string): Promise<void> {
    if (!await tableExists(this.db, table)) throw new Fault('NOT_AVAILABLE', `${label} are not installed.`, 400, 'not_applied');
  }
  private async byKey<T>(table: 'council_records' | 'research_packets', key: string): Promise<T | null> {
    return this.db.prepare(`SELECT * FROM ${table} WHERE actor_id=? AND idempotency_key=?`).bind(this.principal, key).first<T>();
  }
  private same<T extends { request_json: string; idempotency_key: string }>(row: T, requestJson: string, present: (row: T, replayed: boolean) => WireResult): WireResult {
    if (row.request_json !== requestJson) throw new Fault('IDEMPOTENCY_CONFLICT', 'Key already has different content.', 409, 'not_applied', false, { idempotency_key: row.idempotency_key });
    return present(row, true);
  }
  private async commit<T extends { request_json: string; idempotency_key: string }>(
    table: 'council_records' | 'research_packets', key: string, requestJson: string, already: string,
    statement: (id: string, recordedAt: number) => { sql: string; args: Value[] }, present: (row: T, replayed: boolean) => WireResult,
  ): Promise<WireResult> {
    const prior = await this.byKey<T>(table, key);
    if (prior) return this.same(prior, requestJson, present);
    const id = crypto.randomUUID();
    const recordedAt = Date.now();
    const write = statement(id, recordedAt);
    try { await this.db.prepare(write.sql).bind(...write.args).all(); }
    catch (error) {
      const raced = await this.byKey<T>(table, key);
      if (raced) return this.same(raced, requestJson, present);
      throw storageFault(error, already);
    }
    const stored = await this.byKey<T>(table, key);
    if (!stored) throw new Fault('TEMPORARY_FAILURE', 'The record was not stored.', 503, 'unknown', true);
    return present(stored, false);
  }

  private presentCouncil(row: CouncilRow, replayed: boolean): WireResult {
    return { data: {
      id: row.id, stage: row.stage, agenda_id: row.agenda_id, record_id: row.record_id, actor_id: row.actor_id,
      owner_principal_id: row.owner_principal_id, idempotency_key: row.idempotency_key, recorded_at: iso(row.recorded_at),
      replayed, record: stored(row.payload_json),
    }, meta: { replayed } };
  }
  private presentResearch(row: ResearchRow, replayed: boolean, openedBy: string): WireResult {
    return { data: {
      id: row.id, stage: row.kind, task_id: row.task_id, intent_rev: row.intent_rev, actor_id: row.actor_id, opened_by: openedBy,
      idempotency_key: row.idempotency_key, recorded_at: iso(row.recorded_at), replayed, record: stored<ResearchPacket>(row.payload_json),
    }, meta: { replayed } };
  }
  private async stage(room: string, agendaId: string, name: string): Promise<CouncilRow | null> {
    return this.db.prepare('SELECT * FROM council_records WHERE room_id=? AND agenda_id=? AND stage=?').bind(room, agendaId, name).first<CouncilRow>();
  }
  private async latestCouncil(room: string, recordId: string): Promise<CouncilRow | null> {
    return this.db.prepare(`SELECT * FROM council_records WHERE room_id=? AND record_id=? AND stage IN ('sealed','correction','owner_accept') ORDER BY recorded_at DESC, rowid DESC LIMIT 1`).bind(room, recordId).first<CouncilRow>();
  }
  private async head(room: string, agendaId: string): Promise<CouncilRow | null> {
    return this.db.prepare(`SELECT * FROM council_records WHERE room_id=? AND agenda_id=? AND stage IN ('sealed','correction','owner_accept') ORDER BY recorded_at DESC, rowid DESC LIMIT 1`).bind(room, agendaId).first<CouncilRow>();
  }
  private councilWrite(row: { id: string; room: string; agendaId: string; stage: string; recordId: string | null; corrects: string | null; owner: string; requestJson: string; payload: unknown; key: string; recordedAt: number }) {
    return {
      sql: `INSERT INTO council_records(id,room_id,agenda_id,stage,record_id,corrects,owner_principal_id,actor_id,request_json,payload_json,idempotency_key,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [row.id, row.room, row.agendaId, row.stage, row.recordId, row.corrects, row.owner, this.principal, row.requestJson, JSON.stringify(row.payload), row.key, row.recordedAt] as Value[],
    };
  }

  async openAgenda(room: string, key: string, body: Record<string, unknown>): Promise<WireResult> {
    await this.service.authorize(room, true);
    await this.ready('council_records', 'Council records');
    rejectIdentity(body);
    version(body);
    const agenda = phase(openAgenda(body as unknown as AgendaInput));
    const requestJson = canonicalJson(body);
    const prior = await this.byKey<CouncilRow>('council_records', key);
    if (prior) return this.same(prior, requestJson, (row, replayed) => this.presentCouncil(row, replayed));
    if (await this.stage(room, agenda.agenda_id, 'agenda')) throw new Fault('INVALID_INPUT', 'agenda is already open.');
    return this.commit<CouncilRow>('council_records', key, requestJson, 'agenda is already open.', (id, recordedAt) => this.councilWrite({
      id, room, agendaId: agenda.agenda_id, stage: 'agenda', recordId: null, corrects: null, owner: this.principal, requestJson, payload: agenda, key, recordedAt,
    }), (row, replayed) => this.presentCouncil(row, replayed));
  }
  async sealBlind(room: string, key: string, agendaId: string, body: Record<string, unknown>): Promise<WireResult> {
    return this.sealRound(room, key, agendaId, body, 'blind_r1', 'agenda', 'blind_r1 is already sealed.', (parent, input) => sealBlindRound(parent as AgendaRecord, input));
  }
  async sealCross(room: string, key: string, agendaId: string, body: Record<string, unknown>): Promise<WireResult> {
    return this.sealRound(room, key, agendaId, body, 'cross_r2', 'blind_r1', 'cross_r2 is already sealed.', (parent, input) => sealCrossRound(parent as BlindRoundRecord, input));
  }
  private async sealRound(
    room: string, key: string, agendaId: string, body: Record<string, unknown>, stage: 'blind_r1' | 'cross_r2', parentStage: 'agenda' | 'blind_r1', already: string,
    seal: (parent: AgendaRecord | BlindRoundRecord, input: RoundInput) => PhaseCheck<BlindRoundRecord | CrossRoundRecord>,
  ): Promise<WireResult> {
    await this.service.authorize(room, true);
    await this.ready('council_records', 'Council records');
    rejectIdentity(body);
    version(body);
    const requestJson = canonicalJson(body);
    const prior = await this.byKey<CouncilRow>('council_records', key);
    if (prior) return this.same(prior, requestJson, (row, replayed) => this.presentCouncil(row, replayed));
    const parent = await this.stage(room, agendaId, parentStage);
    if (!parent) throw new Fault('NOT_FOUND', 'Unknown prior council stage in this room.', 404);
    if (await this.stage(room, agendaId, stage)) throw new Fault('INVALID_INPUT', already);
    const sealed = phase(seal(stored(parent.payload_json), body as unknown as RoundInput));
    return this.commit<CouncilRow>('council_records', key, requestJson, already, (id, recordedAt) => this.councilWrite({
      id, room, agendaId, stage, recordId: null, corrects: null, owner: parent.owner_principal_id, requestJson, payload: sealed, key, recordedAt,
    }), (row, replayed) => this.presentCouncil(row, replayed));
  }
  async sealChair(room: string, key: string, agendaId: string, body: Record<string, unknown>): Promise<WireResult> {
    await this.service.authorize(room, true);
    await this.ready('council_records', 'Council records');
    rejectIdentity(body);
    version(body);
    const requestJson = canonicalJson(body);
    const prior = await this.byKey<CouncilRow>('council_records', key);
    if (prior) return this.same(prior, requestJson, (row, replayed) => this.presentCouncil(row, replayed));
    const cross = await this.stage(room, agendaId, 'cross_r2');
    if (!cross) throw new Fault('NOT_FOUND', 'Unknown cross round in this room.', 404);
    if (await this.stage(room, agendaId, 'sealed')) throw new Fault('INVALID_INPUT', 'chair is already sealed.');
    const record = phase(sealChair(stored<CrossRoundRecord>(cross.payload_json), body as unknown as ChairInput));
    return this.commit<CouncilRow>('council_records', key, requestJson, 'chair is already sealed.', (id, recordedAt) => this.councilWrite({
      id, room, agendaId, stage: 'sealed', recordId: record.record_id, corrects: record.corrects, owner: cross.owner_principal_id, requestJson, payload: record, key, recordedAt,
    }), (row, replayed) => this.presentCouncil(row, replayed));
  }
  async correct(room: string, key: string, recordId: string, body: Record<string, unknown>): Promise<WireResult> {
    await this.service.authorize(room, true);
    await this.ready('council_records', 'Council records');
    rejectIdentity(body);
    version(body);
    const requestJson = canonicalJson(body);
    const prior = await this.byKey<CouncilRow>('council_records', key);
    if (prior) return this.same(prior, requestJson, (row, replayed) => this.presentCouncil(row, replayed));
    const current = await this.latestCouncil(room, recordId);
    if (!current) throw new Fault('NOT_FOUND', 'Unknown council record in this room.', 404);
    const next = phase(appendCouncilCorrection(stored<CouncilRecord>(current.payload_json), body as unknown as CorrectionInput));
    return this.commit<CouncilRow>('council_records', key, requestJson, 'correction is already stored.', (id, recordedAt) => this.councilWrite({
      id, room, agendaId: current.agenda_id, stage: 'correction', recordId: next.record_id, corrects: next.corrects, owner: current.owner_principal_id, requestJson, payload: next, key, recordedAt,
    }), (row, replayed) => this.presentCouncil(row, replayed));
  }
  async accept(room: string, key: string, recordId: string, body: Record<string, unknown>): Promise<WireResult> {
    await this.service.authorize(room, true);
    await this.ready('council_records', 'Council records');
    rejectIdentity(body);
    onlyKeys(body, ['schema_version', 'accepted']);
    version(body);
    const requestJson = canonicalJson({ accepted: body.accepted });
    const prior = await this.byKey<CouncilRow>('council_records', key);
    if (prior) return this.same(prior, requestJson, (row, replayed) => this.presentCouncil(row, replayed));
    const current = await this.latestCouncil(room, recordId);
    if (!current) throw new Fault('NOT_FOUND', 'Unknown council record in this room.', 404);
    if (current.owner_principal_id !== this.principal) throw new Fault('FORBIDDEN', 'Only the owner principal can set owner_accepted.', 403);
    const next = phase(setOwnerAccepted(stored<CouncilRecord>(current.payload_json), body.accepted as boolean));
    return this.commit<CouncilRow>('council_records', key, requestJson, 'owner accept is already stored.', (id, recordedAt) => this.councilWrite({
      id, room, agendaId: current.agenda_id, stage: 'owner_accept', recordId: next.record_id, corrects: next.corrects, owner: current.owner_principal_id, requestJson, payload: next, key, recordedAt,
    }), (row, replayed) => this.presentCouncil(row, replayed));
  }
  async getCouncil(room: string, agendaId?: string, recordId?: string): Promise<WireResult> {
    await this.service.authorize(room);
    await this.ready('council_records', 'Council records');
    if (Boolean(agendaId) === Boolean(recordId)) throw new Fault('INVALID_INPUT', 'Provide agenda_id or record_id.');
    if (agendaId) return this.agendaView(room, agendaId);
    return this.recordView(room, recordId ?? '');
  }
  async getAgenda(room: string, agendaId: string): Promise<WireResult> {
    await this.service.authorize(room);
    await this.ready('council_records', 'Council records');
    return this.agendaView(room, agendaId);
  }
  async getRecord(room: string, recordId: string): Promise<WireResult> {
    await this.service.authorize(room);
    await this.ready('council_records', 'Council records');
    return this.recordView(room, recordId);
  }
  private async agendaView(room: string, agendaId: string): Promise<WireResult> {
    const agenda = await this.stage(room, agendaId, 'agenda');
    if (!agenda) throw new Fault('NOT_FOUND', 'Unknown agenda in this room.', 404);
    const blind = await this.stage(room, agendaId, 'blind_r1');
    const cross = await this.stage(room, agendaId, 'cross_r2');
    const record = await this.head(room, agendaId);
    return { data: {
      agenda_id: agendaId, owner_principal_id: agenda.owner_principal_id,
      agenda: stored(agenda.payload_json), blind: blind ? stored(blind.payload_json) : null,
      cross: cross ? stored(cross.payload_json) : null, record: record ? stored(record.payload_json) : null,
    }, meta: {} };
  }
  private async recordView(room: string, recordId: string): Promise<WireResult> {
    const row = await this.latestCouncil(room, recordId);
    if (!row) throw new Fault('NOT_FOUND', 'Unknown council record in this room.', 404);
    return { data: { agenda_id: row.agenda_id, record_id: recordId, owner_principal_id: row.owner_principal_id, record: stored(row.payload_json) }, meta: {} };
  }

  async openResearch(room: string, key: string, body: Record<string, unknown>): Promise<WireResult> {
    await this.service.authorize(room, true);
    await this.ready('research_packets', 'Research packets');
    rejectIdentity(body);
    version(body);
    const packet = phase(openResearchPacket(body));
    const requestJson = canonicalJson(body);
    const prior = await this.byKey<ResearchRow>('research_packets', key);
    if (prior) return this.same(prior, requestJson, (row, replayed) => this.presentResearch(row, replayed, row.actor_id));
    if (await this.openRow(room, packet.task.task_id)) throw new Fault('INVALID_INPUT', 'research packet is already open.');
    return this.commit<ResearchRow>('research_packets', key, requestJson, 'research packet is already open.', (id, recordedAt) => ({
      sql: `INSERT INTO research_packets(id,room_id,task_id,intent_rev,kind,actor_id,request_json,payload_json,idempotency_key,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [id, room, packet.task.task_id, packet.intent_rev, 'open', this.principal, requestJson, JSON.stringify(packet), key, recordedAt] as Value[],
    }), (row, replayed) => this.presentResearch(row, replayed, row.actor_id));
  }
  async incorporate(room: string, key: string, taskId: string, ref: Record<string, unknown>): Promise<WireResult> {
    await this.service.authorize(room, true);
    await this.ready('research_packets', 'Research packets');
    rejectIdentity(ref);
    const requestJson = canonicalJson(ref);
    const prior = await this.byKey<ResearchRow>('research_packets', key);
    const opened = await this.openRow(room, taskId);
    if (prior) return this.same(prior, requestJson, (row, replayed) => this.presentResearch(row, replayed, opened?.actor_id ?? row.actor_id));
    const current = await this.latestResearch(room, taskId);
    if (!current || !opened) throw new Fault('NOT_FOUND', 'Unknown research packet in this room.', 404);
    const next = phase(incorporateResearchPacket(stored<ResearchPacket>(current.payload_json), ref));
    return this.commit<ResearchRow>('research_packets', key, requestJson, 'research incorporation is already stored.', (id, recordedAt) => ({
      sql: `INSERT INTO research_packets(id,room_id,task_id,intent_rev,kind,actor_id,request_json,payload_json,idempotency_key,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [id, room, next.task.task_id, next.intent_rev, 'incorporate', this.principal, requestJson, JSON.stringify(next), key, recordedAt] as Value[],
    }), (row, replayed) => this.presentResearch(row, replayed, opened.actor_id));
  }
  async getResearch(room: string, taskId: string): Promise<WireResult> {
    await this.service.authorize(room);
    await this.ready('research_packets', 'Research packets');
    const opened = await this.openRow(room, taskId);
    const latest = await this.latestResearch(room, taskId);
    if (!opened || !latest) throw new Fault('NOT_FOUND', 'Unknown research packet in this room.', 404);
    return { data: {
      task_id: taskId, intent_rev: latest.intent_rev, opened_by: opened.actor_id, actor_id: latest.actor_id,
      recorded_at: iso(latest.recorded_at), record: stored<ResearchPacket>(latest.payload_json),
    }, meta: {} };
  }
  private async openRow(room: string, taskId: string): Promise<ResearchRow | null> {
    return this.db.prepare(`SELECT * FROM research_packets WHERE room_id=? AND task_id=? AND kind='open'`).bind(room, taskId).first<ResearchRow>();
  }
  private async latestResearch(room: string, taskId: string): Promise<ResearchRow | null> {
    return this.db.prepare('SELECT * FROM research_packets WHERE room_id=? AND task_id=? ORDER BY recorded_at DESC, rowid DESC LIMIT 1').bind(room, taskId).first<ResearchRow>();
  }
}

function bind(service: Service): CouncilResearchWire {
  return new CouncilResearchWire(service);
}

export async function councilResearchRoute(service: Service, request: Request, url: URL, readJSON: () => Promise<unknown>): Promise<WireResult | null> {
  const council = COUNCIL_PATH.exec(url.pathname);
  const research = RESEARCH_PATH.exec(url.pathname);
  if (!council && !research) return null;
  if (url.search) throw new Fault('INVALID_INPUT', 'Query parameters are unsupported.');
  const wire = bind(service);
  if (research) return researchHttp(wire, request, research, readJSON);
  return councilHttp(wire, request, council as RegExpExecArray, readJSON);
}

async function councilHttp(wire: CouncilResearchWire, request: Request, match: RegExpExecArray, readJSON: () => Promise<unknown>): Promise<WireResult> {
  const room = pathRoom(match[1] ?? '');
  const kind = match[2];
  const id = match[3] === undefined ? undefined : pathId(match[3], kind === 'records' ? 'record_id' : 'agenda_id');
  const action = match[4];
  const method = request.method;
  if (kind === 'agendas' && id === undefined && action === undefined && method === 'POST') return wire.openAgenda(room, idempotencyKey(request), await readRecord(readJSON, ['room', 'idempotency_key']));
  if (kind === 'agendas' && id && action === 'blind' && method === 'POST') return wire.sealBlind(room, idempotencyKey(request), id, await readRecord(readJSON, ['room', 'idempotency_key', 'agenda_id']));
  if (kind === 'agendas' && id && action === 'cross' && method === 'POST') return wire.sealCross(room, idempotencyKey(request), id, await readRecord(readJSON, ['room', 'idempotency_key', 'agenda_id']));
  if (kind === 'agendas' && id && action === 'chair' && method === 'POST') return wire.sealChair(room, idempotencyKey(request), id, await readRecord(readJSON, ['room', 'idempotency_key', 'agenda_id']));
  if (kind === 'agendas' && id && action === undefined && method === 'GET') return wire.getAgenda(room, id);
  if (kind === 'records' && id && action === 'corrections' && method === 'POST') return wire.correct(room, idempotencyKey(request), id, await readRecord(readJSON, ['room', 'idempotency_key', 'record_id']));
  if (kind === 'records' && id && action === 'owner-accept' && method === 'POST') return wire.accept(room, idempotencyKey(request), id, await readRecord(readJSON, ['room', 'idempotency_key', 'record_id']));
  if (kind === 'records' && id && action === undefined && method === 'GET') return wire.getRecord(room, id);
  throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
}

async function researchHttp(wire: CouncilResearchWire, request: Request, match: RegExpExecArray, readJSON: () => Promise<unknown>): Promise<WireResult> {
  const room = pathRoom(match[1] ?? '');
  const taskId = match[2] === undefined ? undefined : pathId(match[2], 'task_id');
  const action = match[3];
  if (taskId === undefined && action === undefined && request.method === 'POST') return wire.openResearch(room, idempotencyKey(request), await readRecord(readJSON, ['room', 'idempotency_key']));
  if (taskId && action === 'incorporate' && request.method === 'POST') {
    const ref = domainBody(await readRecord(readJSON, ['room', 'idempotency_key', 'task_id']), ['schema_version']);
    return wire.incorporate(room, idempotencyKey(request), taskId, ref);
  }
  if (taskId && action === undefined && request.method === 'GET') return wire.getResearch(room, taskId);
  throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
}

type ToolResult = (call: () => Promise<unknown>, wrapped?: boolean) => Promise<CallToolResult>;
type ToolHints = { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };

export function registerCouncilResearchTools(server: McpServer, service: Service, result: ToolResult, hints: ToolHints): void {
  const wire = () => bind(service);
  const write = { ...hints, readOnlyHint: false, idempotentHint: true };
  const run = (call: () => Promise<WireResult>) => result(call, true);
  server.registerTool(AGENDA_OPEN, { description: AGENDA_TEXT, inputSchema: councilAgendaSchema, annotations: write }, input => run(() => {
    const parsed = councilAgendaSchema.parse(input);
    return wire().openAgenda(parsed.room, parsed.idempotency_key, domainBody(parsed, ['room', 'idempotency_key']));
  }));
  server.registerTool(BLIND_SEAL, { description: BLIND_TEXT, inputSchema: councilBlindSchema, annotations: write }, input => run(() => {
    const parsed = councilBlindSchema.parse(input);
    return wire().sealBlind(parsed.room, parsed.idempotency_key, parsed.agenda_id, domainBody(parsed, ['room', 'idempotency_key', 'agenda_id']));
  }));
  server.registerTool(CROSS_SEAL, { description: CROSS_TEXT, inputSchema: councilCrossSchema, annotations: write }, input => run(() => {
    const parsed = councilCrossSchema.parse(input);
    return wire().sealCross(parsed.room, parsed.idempotency_key, parsed.agenda_id, domainBody(parsed, ['room', 'idempotency_key', 'agenda_id']));
  }));
  server.registerTool(CHAIR_SEAL, { description: CHAIR_TEXT, inputSchema: councilChairSchema, annotations: write }, input => run(() => {
    const parsed = councilChairSchema.parse(input);
    return wire().sealChair(parsed.room, parsed.idempotency_key, parsed.agenda_id, domainBody(parsed, ['room', 'idempotency_key', 'agenda_id']));
  }));
  server.registerTool(CORRECT, { description: CORRECT_TEXT, inputSchema: councilCorrectSchema, annotations: write }, input => run(() => {
    const parsed = councilCorrectSchema.parse(input);
    return wire().correct(parsed.room, parsed.idempotency_key, parsed.record_id, domainBody(parsed, ['room', 'idempotency_key', 'record_id']));
  }));
  server.registerTool(OWNER_ACCEPT, { description: ACCEPT_TEXT, inputSchema: councilAcceptSchema, annotations: write }, input => run(() => {
    const parsed = councilAcceptSchema.parse(input);
    return wire().accept(parsed.room, parsed.idempotency_key, parsed.record_id, domainBody(parsed, ['room', 'idempotency_key', 'record_id']));
  }));
  server.registerTool(COUNCIL_GET, { description: COUNCIL_GET_TEXT, inputSchema: councilGetSchema, annotations: hints }, input => run(() => {
    const parsed = councilGetSchema.parse(input);
    return wire().getCouncil(parsed.room, parsed.agenda_id, parsed.record_id);
  }));
  server.registerTool(RESEARCH_OPEN, { description: RESEARCH_OPEN_TEXT, inputSchema: researchOpenSchema, annotations: write }, input => run(() => {
    const parsed = researchOpenSchema.parse(input);
    return wire().openResearch(parsed.room, parsed.idempotency_key, domainBody(parsed, ['room', 'idempotency_key']));
  }));
  server.registerTool(RESEARCH_INCORPORATE, { description: RESEARCH_INCORPORATE_TEXT, inputSchema: researchIncorporateSchema, annotations: write }, input => run(() => {
    const parsed = researchIncorporateSchema.parse(input);
    return wire().incorporate(parsed.room, parsed.idempotency_key, parsed.task_id, domainBody(parsed, ['schema_version', 'room', 'idempotency_key', 'task_id']));
  }));
  server.registerTool(RESEARCH_GET, { description: RESEARCH_GET_TEXT, inputSchema: researchGetSchema, annotations: hints }, input => run(() => {
    const parsed = researchGetSchema.parse(input);
    return wire().getResearch(parsed.room, parsed.task_id);
  }));
}

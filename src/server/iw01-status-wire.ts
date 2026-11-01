// D1 + REST + MCP wiring for the IW-01 status-fields module (c4f5868).
// validateIw01Status is the only validator. Grade, level, tier, and stage
// are separate read fields. They are not accepted as write names.
// kept, applied, and effect are stored as recorded. kept does not fill the others.
// principal_id is the authenticated caller. The body cannot set it.

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  classificationOf, lifecycleOf, validateIw01Status, type Iw01StatusRecord,
} from '../phase-contracts/iw01-status-fields.ts';
import { Fault, baseSchema, keySchema } from './contracts.ts';
import type { Database } from './db.ts';
import type { Workroom } from './domain.ts';

const STATUS_NOTE = 'grade, level, tier, and stage are separate fields for structuralGrade, corpusLevel, memoryTier, and promotionStage. kept is not applied and is not an effect. principal_id is the authenticated caller.';

export const STATUS_RECORD_TOOL = { name: 'workroom_status_record', readOnly: false, description: 'Record one IW-01 status for a subject. validateIw01Status is the validator. reviewSupport, structuralGrade, corpusLevel, memoryTier, promotionStage, kept, applied, and effect are required and stay separate. grade, level, tier, stage, status, and state are rejected. kept does not fill applied or effect. Requires write permission and an idempotency key. The same key and record replays; a different record conflicts. ' + STATUS_NOTE } as const;
export const STATUS_READ_TOOL = { name: 'workroom_status_read', readOnly: true, description: 'Read one IW-01 status in this room by id or subject_id. Returns separate grade, level, tier, and stage fields. Requires room membership. ' + STATUS_NOTE } as const;
export const STATUS_READ_TOOLS = [STATUS_READ_TOOL.name] as const;
export const STATUS_WRITE_TOOLS = [STATUS_RECORD_TOOL.name] as const;

const roomField = z.string().min(1).max(128);
const idField = z.string().min(1).max(128);
const BLOCKED = ['principal_id', 'actor_id', 'principal', 'agent', 'id', 'recorded_at'] as const;

export const statusRecordSchema = baseSchema.extend({
  room: roomField,
  idempotency_key: keySchema,
  subject_id: idField,
  record: z.unknown(),
  principal_id: z.unknown().optional(),
  actor_id: z.unknown().optional(),
  principal: z.unknown().optional(),
  agent: z.unknown().optional(),
  id: z.unknown().optional(),
  recorded_at: z.unknown().optional(),
}).strict();
export const statusReadSchema = baseSchema.extend({
  room: roomField,
  id: idField.optional(),
  subject_id: idField.optional(),
}).strict();
export type StatusRecordInput = z.infer<typeof statusRecordSchema>;
export type StatusReadInput = z.infer<typeof statusReadSchema>;

type Access = (room?: string, write?: boolean) => Promise<void>;
interface StatusRow {
  id: string;
  room_id: string;
  subject_id: string;
  principal_id: string;
  review_support: string;
  structural_grade: string;
  corpus_level: string;
  memory_tier: number;
  promotion_stage: string;
  kept: number | boolean;
  applied: number | boolean;
  effect: number | boolean;
  record_json: string;
  idempotency_key: string;
  recorded_at: number | string;
}

const missing = (e: unknown) => /no such table/i.test(String((e as Error)?.message ?? e));

async function hasTable(db: Database): Promise<boolean> {
  try { await db.prepare('SELECT 1 FROM iw01_status_records LIMIT 0').all(); return true; }
  catch (e) { if (missing(e)) return false; throw e; }
}
function isoFromMs(value: number | string): string {
  const ms = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(value);
}
function oneOf(present: boolean[], message: string): void {
  if (present.filter(Boolean).length !== 1) throw new Fault('INVALID_INPUT', message);
}
function ident(value: string, field: string): string {
  if (value.length < 1 || value.length > 128 || !value.isWellFormed() || value.includes('\0')) {
    throw new Fault('INVALID_INPUT', `${field} is invalid`);
  }
  return value;
}
function flag(value: number | boolean): boolean | undefined {
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false) return false;
  return undefined;
}
function storedRecordJson(record: Iw01StatusRecord): string {
  return JSON.stringify({
    reviewSupport: record.reviewSupport,
    structuralGrade: record.structuralGrade,
    corpusLevel: record.corpusLevel,
    memoryTier: record.memoryTier,
    promotionStage: record.promotionStage,
    kept: record.kept,
    applied: record.applied,
    effect: record.effect,
  });
}
function rejectBlocked(input: object): void {
  const rec = input as Record<string, unknown>;
  for (const key of BLOCKED) {
    if (Object.hasOwn(rec, key) && rec[key] !== undefined) throw new Fault('INVALID_INPUT', `${key} is not accepted from the body.`);
  }
}
function validated(input: unknown): Iw01StatusRecord {
  const result = validateIw01Status(input);
  if (!result.ok) {
    throw new Fault('INVALID_INPUT', result.issues.map(issue => `${issue.code}:${issue.field}:${issue.message}`).join(' '));
  }
  return result.record;
}
function bit(value: boolean): number {
  return value ? 1 : 0;
}

/** Read projection. Short names mirror the four axes and are not a collapsed status. */
export function statusFieldsOf(record: Iw01StatusRecord): {
  reviewSupport: Iw01StatusRecord['reviewSupport'];
  structuralGrade: Iw01StatusRecord['structuralGrade'];
  corpusLevel: Iw01StatusRecord['corpusLevel'];
  memoryTier: Iw01StatusRecord['memoryTier'];
  promotionStage: Iw01StatusRecord['promotionStage'];
  grade: Iw01StatusRecord['structuralGrade'];
  level: Iw01StatusRecord['corpusLevel'];
  tier: Iw01StatusRecord['memoryTier'];
  stage: Iw01StatusRecord['promotionStage'];
  kept: boolean;
  applied: boolean;
  effect: boolean;
} {
  const classification = classificationOf(record);
  const lifecycle = lifecycleOf(record);
  return {
    reviewSupport: classification.reviewSupport,
    structuralGrade: classification.structuralGrade,
    corpusLevel: classification.corpusLevel,
    memoryTier: classification.memoryTier,
    promotionStage: classification.promotionStage,
    grade: classification.structuralGrade,
    level: classification.corpusLevel,
    tier: classification.memoryTier,
    stage: classification.promotionStage,
    kept: lifecycle.kept,
    applied: lifecycle.applied,
    effect: lifecycle.effect,
  };
}

function recordFromRow(row: StatusRow): Iw01StatusRecord {
  const kept = flag(row.kept);
  const applied = flag(row.applied);
  const effect = flag(row.effect);
  const parsed = validateIw01Status({
    reviewSupport: row.review_support,
    structuralGrade: row.structural_grade,
    corpusLevel: row.corpus_level,
    memoryTier: row.memory_tier,
    promotionStage: row.promotion_stage,
    kept, applied, effect,
  });
  if (!parsed.ok || row.record_json !== storedRecordJson(parsed.record)) {
    throw new Fault('TEMPORARY_FAILURE', 'Stored IW-01 status does not match its columns.', 503, 'unknown', true);
  }
  return parsed.record;
}
function present(row: StatusRow, replayed: boolean) {
  const record = recordFromRow(row);
  const recorded = isoFromMs(row.recorded_at);
  return {
    data: {
      id: row.id, room_id: row.room_id, subject_id: row.subject_id, principal_id: row.principal_id,
      recorded_at: recorded, replayed, ...statusFieldsOf(record),
      timestamps: { recorded_at: { value: recorded, authority: 'server' as const } },
    },
    meta: { replayed, idempotency_key: row.idempotency_key, note: STATUS_NOTE },
  };
}
const ROW = `id, room_id, subject_id, principal_id, review_support, structural_grade, corpus_level, memory_tier, promotion_stage, kept, applied, effect, record_json, idempotency_key, recorded_at`;

export class StatusRecords {
  constructor(private db: Database, private principal: string, private authorize: Access) {}

  async record(input: StatusRecordInput) {
    await this.authorize(input.room, true);
    if (!await hasTable(this.db)) throw new Fault('NOT_AVAILABLE', 'IW-01 status records are not installed.', 400, 'not_applied');
    rejectBlocked(input);
    const subjectId = ident(input.subject_id, 'subject_id');
    const record = validated(input.record);
    const recordJson = storedRecordJson(record);
    const prior = await this.db.prepare(`SELECT ${ROW} FROM iw01_status_records WHERE principal_id=? AND idempotency_key=?`)
      .bind(this.principal, input.idempotency_key).first<StatusRow>();
    if (prior) {
      if (prior.subject_id !== subjectId || prior.record_json !== recordJson) {
        throw new Fault('IDEMPOTENCY_CONFLICT', 'Key already has different IW-01 status content.', 409, 'not_applied', false, { idempotency_key: input.idempotency_key });
      }
      return present(prior, true);
    }
    const id = crypto.randomUUID();
    const recordedAt = Date.now();
    await this.db.prepare(`INSERT INTO iw01_status_records(id,room_id,subject_id,principal_id,review_support,structural_grade,corpus_level,memory_tier,promotion_stage,kept,applied,effect,record_json,idempotency_key,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT DO NOTHING`)
      .bind(
        id, input.room, subjectId, this.principal,
        record.reviewSupport, record.structuralGrade, record.corpusLevel, record.memoryTier, record.promotionStage,
        bit(record.kept), bit(record.applied), bit(record.effect), recordJson, input.idempotency_key, recordedAt,
      ).all();
    const row = await this.db.prepare(`SELECT ${ROW} FROM iw01_status_records WHERE principal_id=? AND idempotency_key=?`)
      .bind(this.principal, input.idempotency_key).first<StatusRow>();
    if (row) {
      if (row.subject_id !== subjectId || row.record_json !== recordJson) {
        throw new Fault('IDEMPOTENCY_CONFLICT', 'Key already has different IW-01 status content.', 409, 'not_applied', false, { idempotency_key: input.idempotency_key });
      }
      return present(row, row.id !== id);
    }
    const existing = await this.db.prepare(`SELECT ${ROW} FROM iw01_status_records WHERE room_id=? AND subject_id=?`)
      .bind(input.room, subjectId).first<StatusRow>();
    if (existing) throw new Fault('CONFLICT', 'subject_id already has an IW-01 status record.', 409, 'not_applied');
    throw new Fault('TEMPORARY_FAILURE', 'IW-01 status was not stored.', 503, 'unknown', true);
  }

  async read(input: StatusReadInput) {
    await this.authorize(input.room);
    if (!await hasTable(this.db)) throw new Fault('NOT_AVAILABLE', 'IW-01 status records are not installed.', 400, 'not_applied');
    oneOf([input.id !== undefined, input.subject_id !== undefined], 'Provide exactly one of id or subject_id.');
    const row = input.id !== undefined
      ? await this.db.prepare(`SELECT ${ROW} FROM iw01_status_records WHERE room_id=? AND id=?`).bind(input.room, input.id).first<StatusRow>()
      : await this.db.prepare(`SELECT ${ROW} FROM iw01_status_records WHERE room_id=? AND subject_id=?`).bind(input.room, ident(input.subject_id ?? '', 'subject_id')).first<StatusRow>();
    if (!row) throw new Fault('NOT_FOUND', 'No IW-01 status record for this room.', 404);
    return present(row, false);
  }
}

function statusFor(service: Workroom): StatusRecords {
  return new StatusRecords(service.database, service.principal, (room, write) => service.authorize(room, write));
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Fault('INVALID_INPUT', 'JSON object body required.');
  return value as Record<string, unknown>;
}
function idempotencyOf(request: Request, url: URL): string {
  if (url.search) throw new Fault('INVALID_INPUT', 'Mutation query parameters are unsupported.');
  return keySchema.parse(request.headers.get('idempotency-key'));
}

export async function statusRoute(service: Workroom, request: Request, url: URL, readJSON: () => Promise<unknown>) {
  const match = /^\/api\/v1\/rooms\/([^/]+)\/status-records(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) return null;
  const room = decodeURIComponent(match[1]!);
  const id = match[2] ? decodeURIComponent(match[2]) : undefined;
  const write = request.method === 'POST';
  await service.authorize(room, write);
  const status = statusFor(service);
  if (request.method === 'POST' && !id) {
    const idempotency_key = idempotencyOf(request, url);
    const body = bodyObject(await readJSON());
    for (const key of ['room', 'idempotency_key', ...BLOCKED]) {
      if (Object.hasOwn(body, key)) throw new Fault('INVALID_INPUT', `${key} is not accepted from the body.`);
    }
    return status.record(statusRecordSchema.parse({ ...body, schema_version: body.schema_version ?? '1', room, idempotency_key }));
  }
  if (request.method === 'GET') {
    if (id && url.search) throw new Fault('INVALID_INPUT', 'Status id and query cannot both be set.');
    const params = Object.fromEntries(url.searchParams);
    if (Object.keys(params).some(key => key !== 'subject_id')) throw new Fault('INVALID_INPUT', 'Unsupported query parameters.');
    return status.read(statusReadSchema.parse({ schema_version: '1', room, ...(id ? { id } : {}), ...params }));
  }
  throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
}

export function registerStatusTools(server: McpServer, service: Workroom, result: (call: () => Promise<{ data: unknown; meta: object }>, wrapped?: boolean) => Promise<{ content: { type: 'text'; text: string }[]; structuredContent: object; isError: boolean }>, hints: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean }): void {
  const status = statusFor(service);
  const writeHints = { ...hints, readOnlyHint: false, idempotentHint: true };
  server.registerTool(STATUS_RECORD_TOOL.name, { description: STATUS_RECORD_TOOL.description, inputSchema: statusRecordSchema, annotations: writeHints },
    input => result(() => status.record(input), true));
  server.registerTool(STATUS_READ_TOOL.name, { description: STATUS_READ_TOOL.description, inputSchema: statusReadSchema, annotations: hints },
    input => result(() => status.read(input), true));
}

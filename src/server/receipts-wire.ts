// D1 + REST + MCP wiring for the pure handoff and verifier-receipt modules.
// Identity is the authenticated principal. The body cannot set it.
// acceptHandoff and evaluateVerifierReceipt remain the only validators.

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { Fault, baseSchema, keySchema } from './contracts.ts';
import type { Database } from './db.ts';
import type { Workroom } from './domain.ts';
import { acceptHandoff, type HandoffAttempt } from './handoff-receipt.ts';
import { evaluateVerifierReceipt, type ReceiptObservation } from './verifier-receipt.ts';

const HANDOFF_NOTE = 'principal_id is the authenticated caller. Injection ids already accepted in this room are supplied by the server. The body cannot set principal_id or seen_injection_ids.';
const VERIFIER_NOTE = 'acceptor_id and verifier_id are the authenticated principal and are not accepted from the body.';

export const HANDOFF_ACCEPT_TOOL = { name: 'workroom_handoff_accept', readOnly: false, description: 'Accept a consumer-bound handoff. The receipt must join the wake proof; acceptHandoff is the validator. Requires write permission and an idempotency key. The same key and payload replays the stored row; a different payload conflicts. principal_id is the authenticated caller. ' + HANDOFF_NOTE } as const;
export const HANDOFF_GET_TOOL = { name: 'workroom_handoff_get', readOnly: true, description: 'Read one accepted handoff in this room by id or injection_receipt_id. Requires room membership. ' + HANDOFF_NOTE } as const;
export const VERIFIER_SUBMIT_TOOL = { name: 'workroom_verifier_receipt_submit', readOnly: false, description: 'Evaluate one verifier observation with evaluateVerifierReceipt and store the result. Requires write permission and an idempotency key. The same key and observation replays; a different observation conflicts. PASS and HOLD are both stored. ' + VERIFIER_NOTE } as const;
export const VERIFIER_GET_TOOL = { name: 'workroom_verifier_receipt_get', readOnly: true, description: 'Read one stored verifier receipt in this room by id, or by your own idempotency key. Requires room membership. ' + VERIFIER_NOTE } as const;
export const RECEIPT_READ_TOOLS = [HANDOFF_GET_TOOL.name, VERIFIER_GET_TOOL.name] as const;
export const RECEIPT_WRITE_TOOLS = [HANDOFF_ACCEPT_TOOL.name, VERIFIER_SUBMIT_TOOL.name] as const;

const roomField = z.string().min(1).max(128);
const idField = z.string().min(1).max(128);
export const handoffAcceptSchema = baseSchema.extend({
  room: roomField, idempotency_key: keySchema,
  consumer_id: z.unknown().optional(), checkpoint_hash: z.unknown().optional(), wake_stage_id: z.unknown().optional(),
  proof: z.unknown().optional(), receipt: z.unknown().optional(),
}).strict();
export const handoffGetSchema = baseSchema.extend({
  room: roomField, id: idField.optional(), injection_receipt_id: idField.optional(),
}).strict();
export const verifierReceiptSubmitSchema = baseSchema.extend({
  room: roomField, idempotency_key: keySchema,
  consumer: z.unknown().optional(), producer_id: z.unknown().optional(), next_maker: z.unknown().optional(),
  author_lineage: z.unknown().optional(), verifier_lineage: z.unknown().optional(),
  sha: z.unknown().optional(), observed_sha: z.unknown().optional(), claimed_gate_version: z.unknown().optional(),
  task_id: z.unknown().optional(), attempt_id: z.unknown().optional(), artifact_digest: z.unknown().optional(),
  lease: z.unknown().optional(), capability_label_as_authority: z.unknown().optional(),
  approval_events: z.unknown().optional(), observation_ok: z.unknown().optional(), runs: z.unknown().optional(),
}).strict();
export const verifierReceiptGetSchema = baseSchema.extend({
  room: roomField, id: idField.optional(), idempotency_key: keySchema.optional(),
}).strict();
export type HandoffAcceptInput = z.infer<typeof handoffAcceptSchema>;
export type HandoffGetInput = z.infer<typeof handoffGetSchema>;
export type VerifierSubmitInput = z.infer<typeof verifierReceiptSubmitSchema>;
export type VerifierGetInput = z.infer<typeof verifierReceiptGetSchema>;

type Access = (room?: string, write?: boolean) => Promise<void>;
interface StoredRow { id: string; attempt_json?: string; observation_json?: string; result_json: string; recorded_at: number | string }

const missing = (e: unknown) => /no such table/i.test(String((e as Error)?.message ?? e));

/** consumer_id is the addressee. principal_id is who recorded the receipt. JSON true at result_json.acknowledged is the acknowledgement; a missing key stays listed. */
export async function handoffsAddressedTo(db: Database, consumerId: string, roomId: string): Promise<{ id: string }[]> {
  const rows = await db.prepare(`SELECT id FROM handoff_receipts WHERE room_id=? AND consumer_id=? AND json_extract(result_json,'$.acknowledged') IS NOT 1 ORDER BY recorded_at, id`).bind(roomId, consumerId).all<{ id: string }>();
  return rows.results;
}

async function hasTable(db: Database, name: 'handoff_receipts' | 'verifier_receipts'): Promise<boolean> {
  try { await db.prepare(`SELECT 1 FROM ${name} LIMIT 0`).all(); return true; }
  catch (e) { if (missing(e)) return false; throw e; }
}
function isoFromMs(value: number | string): string {
  const ms = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(value);
}
function oneOf(present: boolean[], message: string): void {
  if (present.filter(Boolean).length !== 1) throw new Fault('INVALID_INPUT', message);
}
function attemptOf(input: HandoffAcceptInput, seen: readonly string[]): HandoffAttempt {
  return {
    consumer_id: input.consumer_id as string, checkpoint_hash: input.checkpoint_hash as string, wake_stage_id: input.wake_stage_id as string,
    proof: input.proof, receipt: input.receipt, seen_injection_ids: seen,
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
function attemptJson(input: HandoffAcceptInput): string {
  return JSON.stringify(canonical({
    consumer_id: input.consumer_id ?? null, checkpoint_hash: input.checkpoint_hash ?? null, wake_stage_id: input.wake_stage_id ?? null,
    proof: input.proof ?? null, receipt: input.receipt ?? null,
  }));
}
function observationOf(input: VerifierSubmitInput, principal: string): ReceiptObservation {
  return {
    consumer: input.consumer as ReceiptObservation['consumer'],
    producer_id: input.producer_id as string,
    acceptor_id: principal,
    next_maker: input.next_maker as string,
    author_lineage: input.author_lineage as ReceiptObservation['author_lineage'],
    verifier_lineage: input.verifier_lineage as ReceiptObservation['verifier_lineage'],
    sha: input.sha as string,
    observed_sha: input.observed_sha as string,
    claimed_gate_version: input.claimed_gate_version as string,
    task_id: input.task_id as string,
    attempt_id: input.attempt_id as string,
    artifact_digest: input.artifact_digest as string,
    verifier_id: principal,
    lease: input.lease as ReceiptObservation['lease'],
    capability_label_as_authority: input.capability_label_as_authority as boolean,
    approval_events: input.approval_events as ReceiptObservation['approval_events'],
    observation_ok: input.observation_ok as boolean,
    runs: input.runs as ReceiptObservation['runs'],
  };
}
function present(row: StoredRow, replayed: boolean, note: string, idempotencyKey: string) {
  const stored = JSON.parse(row.result_json) as Record<string, unknown>;
  const recorded = isoFromMs(row.recorded_at);
  return {
    data: { ...stored, id: row.id, recorded_at: recorded, replayed, timestamps: { recorded_at: { value: recorded, authority: 'server' as const } } },
    meta: { replayed, idempotency_key: idempotencyKey, note },
  };
}

export class Receipts {
  constructor(private db: Database, private principal: string, private authorize: Access) {}

  async handoffAccept(input: HandoffAcceptInput) {
    await this.authorize(input.room, true);
    if (!await hasTable(this.db, 'handoff_receipts')) throw new Fault('NOT_AVAILABLE', 'Handoff receipts are not installed.', 400, 'not_applied');
    const attempt = attemptJson(input);
    const prior = await this.db.prepare('SELECT id, attempt_json, result_json, recorded_at FROM handoff_receipts WHERE principal_id=? AND idempotency_key=?')
      .bind(this.principal, input.idempotency_key).first<StoredRow>();
    if (prior) {
      if (prior.attempt_json !== attempt) throw new Fault('IDEMPOTENCY_CONFLICT', 'Key already has different handoff content.', 409, 'not_applied', false, { idempotency_key: input.idempotency_key });
      return present(prior, true, HANDOFF_NOTE, input.idempotency_key);
    }
    const seenRows = await this.db.prepare('SELECT injection_receipt_id FROM handoff_receipts WHERE room_id=?').bind(input.room).all<{ injection_receipt_id: string }>();
    const decision = acceptHandoff(attemptOf(input, seenRows.results.map(row => row.injection_receipt_id)));
    if (!decision.ok) throw new Fault('INVALID_INPUT', decision.errors.join('; '));
    const id = crypto.randomUUID();
    const recordedAt = Date.now();
    const binding = decision.value.handoff_receipt;
    const result = {
      principal_id: this.principal, room_id: input.room, consumer_id: binding.consumer_id, idempotency_key: input.idempotency_key,
      handoff_receipt: binding, proven_live: decision.value.proven_live, proof: decision.value.proof, receipt: decision.value.receipt,
    };
    await this.db.prepare(`INSERT INTO handoff_receipts(id,room_id,principal_id,consumer_id,checkpoint_hash,wake_stage_id,injection_receipt_id,proven_live,attempt_json,result_json,idempotency_key,recorded_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM handoff_receipts WHERE room_id=? AND injection_receipt_id=?)
      ON CONFLICT(principal_id, idempotency_key) DO NOTHING`)
      .bind(id, input.room, this.principal, binding.consumer_id, binding.checkpoint_hash, binding.wake_stage_id, decision.value.receipt.injection_receipt_id, decision.value.proven_live ? 1 : 0, attempt, JSON.stringify(result), input.idempotency_key, recordedAt, input.room, decision.value.receipt.injection_receipt_id)
      .all();
    const row = await this.db.prepare('SELECT id, attempt_json, result_json, recorded_at FROM handoff_receipts WHERE principal_id=? AND idempotency_key=?')
      .bind(this.principal, input.idempotency_key).first<StoredRow>();
    if (!row) {
      const again = await this.db.prepare('SELECT injection_receipt_id FROM handoff_receipts WHERE room_id=?').bind(input.room).all<{ injection_receipt_id: string }>();
      const retry = acceptHandoff(attemptOf(input, again.results.map(item => item.injection_receipt_id)));
      if (!retry.ok) throw new Fault('INVALID_INPUT', retry.errors.join('; '));
      throw new Fault('TEMPORARY_FAILURE', 'Handoff receipt was not stored.', 503, 'unknown', true);
    }
    if (row.attempt_json !== attempt) throw new Fault('IDEMPOTENCY_CONFLICT', 'Key already has different handoff content.', 409, 'not_applied', false, { idempotency_key: input.idempotency_key });
    return present(row, row.id !== id, HANDOFF_NOTE, input.idempotency_key);
  }

  async handoffGet(input: HandoffGetInput) {
    await this.authorize(input.room);
    if (!await hasTable(this.db, 'handoff_receipts')) throw new Fault('NOT_AVAILABLE', 'Handoff receipts are not installed.', 400, 'not_applied');
    oneOf([input.id !== undefined, input.injection_receipt_id !== undefined], 'Provide exactly one of id or injection_receipt_id.');
    const row = input.id !== undefined
      ? await this.db.prepare('SELECT id, result_json, recorded_at, idempotency_key FROM handoff_receipts WHERE room_id=? AND id=?').bind(input.room, input.id).first<StoredRow & { idempotency_key: string }>()
      : await this.db.prepare('SELECT id, result_json, recorded_at, idempotency_key FROM handoff_receipts WHERE room_id=? AND injection_receipt_id=?').bind(input.room, input.injection_receipt_id ?? '').first<StoredRow & { idempotency_key: string }>();
    if (!row) throw new Fault('NOT_FOUND', 'No handoff receipt for this room.', 404);
    return present(row, false, HANDOFF_NOTE, row.idempotency_key);
  }

  async verifierSubmit(input: VerifierSubmitInput) {
    await this.authorize(input.room, true);
    if (!await hasTable(this.db, 'verifier_receipts')) throw new Fault('NOT_AVAILABLE', 'Verifier receipts are not installed.', 400, 'not_applied');
    const observation = observationOf(input, this.principal);
    const observationJson = JSON.stringify(canonical(observation));
    const prior = await this.db.prepare('SELECT id, observation_json, result_json, recorded_at FROM verifier_receipts WHERE principal_id=? AND idempotency_key=?')
      .bind(this.principal, input.idempotency_key).first<StoredRow>();
    if (prior) {
      if (prior.observation_json !== observationJson) throw new Fault('IDEMPOTENCY_CONFLICT', 'Key already has different verifier content.', 409, 'not_applied', false, { idempotency_key: input.idempotency_key });
      return present(prior, true, VERIFIER_NOTE, input.idempotency_key);
    }
    const evaluation = evaluateVerifierReceipt(observation);
    const id = crypto.randomUUID();
    const recordedAt = Date.now();
    const result = {
      principal_id: this.principal, room_id: input.room, idempotency_key: input.idempotency_key,
      acceptor_id: this.principal, verifier_id: this.principal, observation,
      disposition: evaluation.disposition, receipt: evaluation.receipt, reasons: evaluation.reasons,
      failure_packet: evaluation.failure_packet, observation_report: evaluation.observation_report, separate_gates: evaluation.separate_gates,
    };
    await this.db.prepare(`INSERT INTO verifier_receipts(id,room_id,principal_id,disposition,observation_json,result_json,idempotency_key,recorded_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(principal_id, idempotency_key) DO NOTHING`)
      .bind(id, input.room, this.principal, evaluation.disposition, observationJson, JSON.stringify(result), input.idempotency_key, recordedAt)
      .all();
    const row = await this.db.prepare('SELECT id, observation_json, result_json, recorded_at FROM verifier_receipts WHERE principal_id=? AND idempotency_key=?')
      .bind(this.principal, input.idempotency_key).first<StoredRow>();
    if (!row) throw new Fault('TEMPORARY_FAILURE', 'Verifier receipt was not stored.', 503, 'unknown', true);
    if (row.observation_json !== observationJson) throw new Fault('IDEMPOTENCY_CONFLICT', 'Key already has different verifier content.', 409, 'not_applied', false, { idempotency_key: input.idempotency_key });
    return present(row, row.id !== id, VERIFIER_NOTE, input.idempotency_key);
  }

  async verifierGet(input: VerifierGetInput) {
    await this.authorize(input.room);
    if (!await hasTable(this.db, 'verifier_receipts')) throw new Fault('NOT_AVAILABLE', 'Verifier receipts are not installed.', 400, 'not_applied');
    oneOf([input.id !== undefined, input.idempotency_key !== undefined], 'Provide exactly one of id or idempotency_key.');
    const row = input.id !== undefined
      ? await this.db.prepare('SELECT id, result_json, recorded_at, idempotency_key FROM verifier_receipts WHERE room_id=? AND id=?').bind(input.room, input.id).first<StoredRow & { idempotency_key: string }>()
      : await this.db.prepare('SELECT id, result_json, recorded_at, idempotency_key FROM verifier_receipts WHERE room_id=? AND principal_id=? AND idempotency_key=?').bind(input.room, this.principal, input.idempotency_key ?? '').first<StoredRow & { idempotency_key: string }>();
    if (!row) throw new Fault('NOT_FOUND', 'No verifier receipt for this room.', 404);
    return present(row, false, VERIFIER_NOTE, row.idempotency_key);
  }
}

function receiptsFor(service: Workroom): Receipts {
  return new Receipts(service.database, service.principal, (room, write) => service.authorize(room, write));
}

const HANDOFF_BLOCK = ['room', 'idempotency_key', 'principal_id', 'actor_id', 'principal', 'agent', 'acceptor_id', 'verifier_id', 'seen_injection_ids', 'id'];
const VERIFIER_BLOCK = ['room', 'idempotency_key', 'principal_id', 'actor_id', 'principal', 'agent', 'acceptor_id', 'verifier_id', 'id'];

function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Fault('INVALID_INPUT', 'JSON object body required.');
  return value as Record<string, unknown>;
}
function rejectBlocked(body: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(body, key)) throw new Fault('INVALID_INPUT', `${key} is not accepted from the body.`);
}
function idempotencyOf(request: Request, url: URL): string {
  if (url.search) throw new Fault('INVALID_INPUT', 'Mutation query parameters are unsupported.');
  return keySchema.parse(request.headers.get('idempotency-key'));
}

export async function receiptsRoute(service: Workroom, request: Request, url: URL, readJSON: () => Promise<unknown>) {
  const handoff = /^\/api\/v1\/rooms\/([^/]+)\/handoffs(?:\/([^/]+))?$/.exec(url.pathname);
  const verifier = /^\/api\/v1\/rooms\/([^/]+)\/verifier-receipts(?:\/([^/]+))?$/.exec(url.pathname);
  const match = handoff ?? verifier;
  if (!match) return null;
  const room = decodeURIComponent(match[1]!);
  const id = match[2] ? decodeURIComponent(match[2]) : undefined;
  const write = request.method === 'POST';
  await service.authorize(room, write);
  const receipts = receiptsFor(service);
  if (handoff && request.method === 'POST' && !id) {
    const idempotency_key = idempotencyOf(request, url);
    const body = bodyObject(await readJSON());
    rejectBlocked(body, HANDOFF_BLOCK);
    return receipts.handoffAccept(handoffAcceptSchema.parse({ ...body, schema_version: body.schema_version ?? '1', room, idempotency_key }));
  }
  if (handoff && request.method === 'GET') {
    if (id && url.search) throw new Fault('INVALID_INPUT', 'Handoff id and query cannot both be set.');
    const params = Object.fromEntries(url.searchParams);
    if (Object.keys(params).some(key => key !== 'injection_receipt_id')) throw new Fault('INVALID_INPUT', 'Unsupported query parameters.');
    return receipts.handoffGet(handoffGetSchema.parse({ schema_version: '1', room, ...(id ? { id } : {}), ...params }));
  }
  if (verifier && request.method === 'POST' && !id) {
    const idempotency_key = idempotencyOf(request, url);
    const body = bodyObject(await readJSON());
    rejectBlocked(body, VERIFIER_BLOCK);
    return receipts.verifierSubmit(verifierReceiptSubmitSchema.parse({ ...body, schema_version: body.schema_version ?? '1', room, idempotency_key }));
  }
  if (verifier && request.method === 'GET') {
    if (id && url.search) throw new Fault('INVALID_INPUT', 'Verifier receipt id and query cannot both be set.');
    const params = Object.fromEntries(url.searchParams);
    if (Object.keys(params).some(key => key !== 'idempotency_key')) throw new Fault('INVALID_INPUT', 'Unsupported query parameters.');
    return receipts.verifierGet(verifierReceiptGetSchema.parse({ schema_version: '1', room, ...(id ? { id } : {}), ...params }));
  }
  throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
}

export function registerReceiptTools(server: McpServer, service: Workroom, result: (call: () => Promise<{ data: unknown; meta: object }>, wrapped?: boolean) => Promise<{ content: { type: 'text'; text: string }[]; structuredContent: object; isError: boolean }>, hints: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean }): void {
  const receipts = receiptsFor(service);
  const writeHints = { ...hints, readOnlyHint: false, idempotentHint: true };
  server.registerTool(HANDOFF_ACCEPT_TOOL.name, { description: HANDOFF_ACCEPT_TOOL.description, inputSchema: handoffAcceptSchema, annotations: writeHints },
    input => result(() => receipts.handoffAccept(input), true));
  server.registerTool(HANDOFF_GET_TOOL.name, { description: HANDOFF_GET_TOOL.description, inputSchema: handoffGetSchema, annotations: hints },
    input => result(() => receipts.handoffGet(input), true));
  server.registerTool(VERIFIER_SUBMIT_TOOL.name, { description: VERIFIER_SUBMIT_TOOL.description, inputSchema: verifierReceiptSubmitSchema, annotations: writeHints },
    input => result(() => receipts.verifierSubmit(input), true));
  server.registerTool(VERIFIER_GET_TOOL.name, { description: VERIFIER_GET_TOOL.description, inputSchema: verifierReceiptGetSchema, annotations: hints },
    input => result(() => receipts.verifierGet(input), true));
}

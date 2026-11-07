// P4 dispatch on the real request path. Unit-cost validation stays in unit-cost.ts.
// Reserve and settle each run as one D1 batch. The OpenRouter fetch sits between them,
// so the two money movements cannot share a batch. Identity comes from the transport.
import { z } from 'zod';
import { BoundaryUnavailableError } from '../boundary.ts';
import rosterJson from '../../config/models.openrouter.json' with { type: 'json' };
import {
  dispatch, estimateMicroUsd,
  type DispatchReport, type FetchLike, type Ledger, type PendingMark, type ReserveInput, type Roster, type SettleInput,
} from '../or-harness/client.ts';
import type { Database, Value } from './db.ts';
import type { Workroom } from './domain.ts';
import { aggregateUnitCosts, recordUnitCost, type RecordedUnitCost } from './unit-cost.ts';
import { Fault, keySchema } from './contracts.ts';
import type { McpServer } from '@modelcontextprotocol/server';

const roster = rosterJson as unknown as Roster;
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GENERATION_URL = 'https://openrouter.ai/api/v1/generation';
const KEY_RE = /^[A-Za-z0-9_.-]{8,128}$/;
const COUNTED_HOLD = `state IN ('open', 'pending_actual', 'unknown')`;

export const DEFAULT_BUDGET_CAP_USD_MICROS = 3_000_000;

export interface DispatchEnv {
  OPENROUTER_API_KEY?: string;
  BUDGET_CAP_USD_MICROS?: string | number;
}

const idempotencyKey = z.string().regex(KEY_RE);
const costField = {
  consumer: z.unknown(), provenance: z.unknown(), proof_mode: z.unknown(), unit_id: z.unknown(),
  tool: z.unknown(), model: z.unknown(), tokens_in: z.unknown(), tokens_out: z.unknown(),
  category: z.unknown(), cost_usd_micros: z.unknown(),
};
export const unitCostRecordSchema = z.object({
  schema_version: z.literal('1'), room: z.string().min(1).max(128), idempotency_key: idempotencyKey, ...costField,
}).loose();
export const unitCostSummarySchema = z.object({
  schema_version: z.literal('1'), room: z.string().min(1).max(128),
}).strict();
export const agentDispatchSchema = z.object({
  schema_version: z.literal('1'), room: z.string().min(1).max(128), idempotency_key: idempotencyKey,
  model: z.string().min(1).max(128), prompt: z.string().min(1).max(8000),
  max_tokens: z.number().int().min(1).max(4096).default(256),
  project: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/).default('test'),
}).strict();

export const UNIT_COST_RECORD_TOOL = {
  name: 'workroom_unit_cost_record',
  description: 'Record one unit cost for the authenticated principal. Identity is the caller, never a body field. The pure unit-cost module validates the record. Subscription dollar cost is UNKNOWN, never 0. The idempotency key replays the same payload and conflicts when the payload differs.',
};
export const UNIT_COST_SUMMARY_TOOL = {
  name: 'workroom_unit_cost_summary',
  description: 'Summarize unit costs recorded in this room. Requires room membership. Totals come from aggregateUnitCosts. An empty room is UNKNOWN, not zero.',
};
export const AGENT_DISPATCH_TOOL = {
  name: 'workroom_agent_dispatch',
  description: 'Reserve budget, call OpenRouter, settle the actual cost, and post the reply as a room message from the authenticated principal. The model must be on the OpenRouter roster. If OPENROUTER_API_KEY is unset, returns DISPATCH_NOT_CONFIGURED and reserves nothing. The idempotency key replays the stored result.',
};

type Hints = { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
type ResultFn = (call: () => Promise<unknown>, wrapped?: boolean) => Promise<unknown>;
type RecordInput = z.infer<typeof unitCostRecordSchema>;
type SummaryInput = z.infer<typeof unitCostSummarySchema>;
type DispatchInput = z.infer<typeof agentDispatchSchema>;

interface ReservationRow {
  reservation_id: string;
  state: string;
  micro_usd: number | string | bigint;
  generation_id: string | null;
  provider_account: string;
  model: string;
}
interface ActualRow {
  reservation_id: string;
  provider_account: string;
  generation_id: string;
  model: string;
  micro_usd: number | string | bigint;
  cost_field: string;
}
interface DispatchRow {
  id: string;
  room_id: string;
  request_hash: string;
  state: string;
  result_json: string | null;
  message_id: string | null;
}
interface UnitRow {
  id: string;
  principal_id: string;
  room_id: string;
  request_hash: string;
  record_json: string;
  recorded_at: number;
}

function notConfigured(): Fault {
  return new Fault('DISPATCH_NOT_CONFIGURED', 'OpenRouter dispatch is not configured.', 503);
}

function readDispatchEnv(env: object): DispatchEnv {
  const source = env as DispatchEnv;
  return {
    OPENROUTER_API_KEY: typeof source.OPENROUTER_API_KEY === 'string' ? source.OPENROUTER_API_KEY : undefined,
    BUDGET_CAP_USD_MICROS: typeof source.BUDGET_CAP_USD_MICROS === 'string' || typeof source.BUDGET_CAP_USD_MICROS === 'number'
      ? source.BUDGET_CAP_USD_MICROS : undefined,
  };
}

export function budgetCapUsdMicros(env: DispatchEnv): number {
  const raw = env.BUDGET_CAP_USD_MICROS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_BUDGET_CAP_USD_MICROS;
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : null;
  if (text === null || !/^[0-9]+$/.test(text)) throw notConfigured();
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw notConfigured();
  return value;
}

function configuredKey(env: DispatchEnv): string | null {
  const key = env.OPENROUTER_API_KEY;
  if (typeof key !== 'string' || key.length === 0 || key.trim() !== key) return null;
  if (/[\r\n\0]/.test(key)) return null;
  return key;
}

function asMicro(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('micro overflow');
    return Number(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error('bad micro_usd');
}

function accountOf(value: string | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = stable(source[key]);
    return out;
  }
  return value;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function canonicalHash(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(stable(value)));
}

function missingTable(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ''}` : String(error);
  return message.toLowerCase().includes('no such table');
}

async function available(db: Database): Promise<void> {
  try {
    await db.prepare('SELECT 1 FROM budget_reservations, budget_actuals, unit_cost_records, dispatch_calls LIMIT 0').all();
  } catch (error) {
    if (missingTable(error)) throw new Fault('NOT_AVAILABLE', 'Budget ledger is not installed.', 400, 'not_applied');
    throw error;
  }
}

async function one<T>(db: Database, sql: string, args: Value[]): Promise<T | null> {
  return db.prepare(sql).bind(...args).first<T>();
}

async function readPosition(db: Database): Promise<{ spent: number; held: number }> {
  const row = await one<{ spent: unknown; held: unknown }>(db, `SELECT
    COALESCE((SELECT SUM(micro_usd) FROM budget_actuals), 0) AS spent,
    COALESCE((SELECT SUM(micro_usd) FROM budget_reservations WHERE ${COUNTED_HOLD}), 0) AS held`, []);
  return { spent: asMicro(row?.spent), held: asMicro(row?.held) };
}

function positionSummary(cap: number, position: { spent: number; held: number }) {
  const remaining = cap - position.spent - position.held;
  if (!Number.isSafeInteger(remaining)) throw new Error('remaining micro_usd is not a safe integer');
  return { cap, spent: position.spent, held: position.held, remaining };
}

/** Ledger the OpenRouter client drives. Each method's write is one D1 batch. */
export function openD1Ledger(db: Database, principal: string, cap: number): Ledger {
  return {
    async reserve(input: ReserveInput) {
      if (!Number.isSafeInteger(input.est_micro_usd) || input.est_micro_usd < 0) throw new Error('bad estimate');
      if (!input.attempt_id || !input.project) throw new Error('bad reserve');
      const reservationId = `res_${crypto.randomUUID()}`;
      const createdAt = new Date().toISOString();
      const snapshot = JSON.stringify(input.pricing_snapshot);
      const inserted = await db.batch<{ reservation_id: string }>([
        db.prepare(`INSERT INTO budget_reservations (
            reservation_id, attempt_id, run_id, project, principal_id, model, state,
            micro_usd, pricing_snapshot_json, generation_id, provider_account, pending_reason, evidence, flag, created_at
          )
          SELECT ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, '', NULL, NULL, NULL, ?
          WHERE NOT EXISTS (SELECT 1 FROM budget_reservations WHERE attempt_id = ?)
          AND (
            ? - COALESCE((SELECT SUM(micro_usd) FROM budget_actuals), 0)
              - COALESCE((SELECT SUM(micro_usd) FROM budget_reservations WHERE ${COUNTED_HOLD}), 0)
          ) >= ?`).bind(
          reservationId, input.attempt_id, input.run_id, input.project, principal, input.model,
          input.est_micro_usd, snapshot, createdAt, input.attempt_id, cap, input.est_micro_usd,
        ),
        db.prepare('SELECT reservation_id FROM budget_reservations WHERE attempt_id = ?').bind(input.attempt_id),
      ]);
      const seen = inserted[1]?.results[0]?.reservation_id
        ?? (await one<{ reservation_id: string }>(db, 'SELECT reservation_id FROM budget_reservations WHERE attempt_id = ?', [input.attempt_id]))?.reservation_id;
      if (seen) return { ok: true, reservation_id: seen };
      const position = await readPosition(db);
      return { ok: false, reason: 'over_budget', remaining: positionSummary(cap, position).remaining };
    },

    async markPending(reservationId: string, reason: string, extra?: PendingMark) {
      const generation = extra?.generation_id ?? null;
      const model = extra?.model ?? null;
      const account = accountOf(extra?.provider_account);
      await db.batch([
        db.prepare(`UPDATE budget_reservations
          SET state = 'pending_actual',
              pending_reason = ?,
              generation_id = CASE WHEN ? IS NULL THEN generation_id ELSE ? END,
              model = CASE WHEN ? IS NULL THEN model ELSE ? END,
              provider_account = CASE WHEN ? = '' THEN provider_account WHEN provider_account = '' THEN ? ELSE provider_account END
          WHERE reservation_id = ?
            AND ${COUNTED_HOLD}
            AND (? IS NULL OR generation_id IS NULL OR generation_id = ?)
            AND (? = '' OR provider_account = '' OR provider_account = ?)`).bind(
          reason, generation, generation, model, model, account, account, reservationId, generation, generation, account, account,
        ),
      ]);
      const row = await one<ReservationRow>(db, `SELECT reservation_id, state, micro_usd, generation_id, provider_account, model
        FROM budget_reservations WHERE reservation_id = ?`, [reservationId]);
      if (!row) throw new Error('not found');
      if (row.state !== 'pending_actual') throw new Error('invalid_state');
      if (generation !== null && row.generation_id !== generation) throw new Error('invalid_state');
      if (account !== '' && row.provider_account !== '' && row.provider_account !== account) throw new Error('invalid_state');
    },

    async settle(reservationId: string, actual: SettleInput) {
      if (actual.cost_field !== 'total_cost' && actual.cost_field !== 'usage') throw new Error('bad cost_field');
      if (!Number.isSafeInteger(actual.micro_usd) || actual.micro_usd < 0) throw new Error('bad micro_usd');
      if (!actual.generation_id) throw new Error('missing generation_id');
      const account = accountOf(actual.provider_account);
      const actualId = `act_${crypto.randomUUID()}`;
      const createdAt = new Date().toISOString();
      const tokens = JSON.stringify(actual.tokens);
      const update = db.prepare(`UPDATE budget_reservations
        SET state = 'settled',
            flag = CASE WHEN ? > micro_usd THEN 'over_budget' ELSE flag END,
            generation_id = COALESCE(generation_id, ?),
            provider_account = CASE WHEN provider_account = '' THEN ? ELSE provider_account END,
            model = ?
        WHERE reservation_id = ?
          AND ${COUNTED_HOLD}
          AND EXISTS (
            SELECT 1 FROM budget_actuals a
            WHERE a.reservation_id = budget_reservations.reservation_id
              AND a.provider = 'openrouter' AND a.provider_account = ? AND a.generation_id = ?
              AND a.micro_usd = ? AND a.cost_field = ?
          )`).bind(actual.micro_usd, actual.generation_id, account, actual.model, reservationId, account, actual.generation_id, actual.micro_usd, actual.cost_field);
      await db.batch([
        db.prepare(`INSERT INTO budget_actuals (
            id, reservation_id, project, provider, provider_account, generation_id, model,
            micro_usd, cost_field, tokens_json, flag, created_at
          )
          SELECT ?, r.reservation_id, r.project, 'openrouter', ?, ?, ?, ?, ?, ?,
            CASE WHEN ? > r.micro_usd THEN 'over_budget' ELSE NULL END, ?
          FROM budget_reservations r
          WHERE r.reservation_id = ?
            AND r.${COUNTED_HOLD}
            AND NOT EXISTS (
              SELECT 1 FROM budget_actuals a
              WHERE a.provider = 'openrouter' AND a.provider_account = ? AND a.generation_id = ?
            )`).bind(
          actualId, account, actual.generation_id, actual.model, actual.micro_usd, actual.cost_field, tokens,
          actual.micro_usd, createdAt, reservationId, account, actual.generation_id,
        ),
        update,
      ]);
      const loadActual = () => one<ActualRow>(db, `SELECT reservation_id, provider_account, generation_id, model, micro_usd, cost_field
        FROM budget_actuals WHERE provider = 'openrouter' AND provider_account = ? AND generation_id = ?`, [account, actual.generation_id]);
      const loadReservation = () => one<ReservationRow>(db, `SELECT reservation_id, state, micro_usd, generation_id, provider_account, model
        FROM budget_reservations WHERE reservation_id = ?`, [reservationId]);
      const stored = await loadActual();
      let reservation = await loadReservation();
      if (stored && stored.reservation_id === reservationId && reservation && reservation.state !== 'settled') {
        await update.bind(actual.micro_usd, actual.generation_id, account, actual.model, reservationId, account, actual.generation_id, actual.micro_usd, actual.cost_field).all();
        reservation = await loadReservation();
      }
      if (!reservation) throw new Error('not found');
      if (!stored) throw new Error('invalid_state');
      const matches = stored.reservation_id === reservationId
        && stored.generation_id === actual.generation_id
        && asMicro(stored.micro_usd) === actual.micro_usd
        && stored.cost_field === actual.cost_field
        && stored.provider_account === account
        && stored.model === actual.model;
      if (!matches || reservation.state !== 'settled') throw new Error('invalid_state');
    },

    async summary(project: string) {
      if (typeof project !== 'string' || project.length === 0) throw new Error('project required');
      return positionSummary(cap, await readPosition(db));
    },
  };
}

function clipReply(text: string): string {
  const cleaned = text.split('\0').join('');
  const bytes = new TextEncoder().encode(cleaned);
  if (bytes.byteLength <= 32768) return cleaned;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = 32768; end >= 32768 - 4 && end >= 0; end -= 1) {
    try { return decoder.decode(bytes.subarray(0, end)); } catch { /* stop on a code-point boundary */ }
  }
  return '';
}

function costPayload(input: RecordInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'room' || key === 'idempotency_key') continue;
    payload[key] = value;
  }
  return payload;
}

async function recordCost(service: Workroom, input: RecordInput) {
  await service.authorize(input.room, true);
  await available(service.database);
  const parsed = recordUnitCost(costPayload(input));
  if (!parsed.ok) throw new Fault('INVALID_INPUT', parsed.errors.join('; '));
  const recorded = parsed.value;
  const hash = await canonicalHash(costPayload(input));
  const freshId = `uc_${crypto.randomUUID()}`;
  const now = Date.now();
  const costText = recorded.cost_usd_micros === 'UNKNOWN' ? 'UNKNOWN' : String(recorded.cost_usd_micros);
  const select = 'SELECT id, principal_id, room_id, request_hash, record_json, recorded_at FROM unit_cost_records WHERE principal_id = ? AND idempotency_key = ?';
  const out = await service.database.batch<UnitRow>([
    service.database.prepare(`INSERT INTO unit_cost_records (
        id, principal_id, room_id, idempotency_key, category, cost_usd_micros, record_json, request_hash, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(principal_id, idempotency_key) DO NOTHING`).bind(
      freshId, service.principal, input.room, input.idempotency_key, recorded.category, costText, JSON.stringify(recorded), hash, now,
    ),
    service.database.prepare(select).bind(service.principal, input.idempotency_key),
  ]);
  const row = out[1]?.results[0] ?? await one<UnitRow>(service.database, select, [service.principal, input.idempotency_key]);
  if (!row) throw new Fault('TEMPORARY_FAILURE', 'Unit cost record was not stored.', 503, 'unknown', true);
  if (row.request_hash !== hash) throw new Fault('IDEMPOTENCY_CONFLICT', 'Key already has different unit cost content.', 409);
  const replayed = row.id !== freshId;
  const body = JSON.parse(row.record_json) as RecordedUnitCost;
  return {
    data: {
      id: row.id, principal_id: service.principal, room_id: row.room_id, category: body.category,
      cost_usd_micros: body.cost_usd_micros, record: body.record, recorded_at: new Date(row.recorded_at).toISOString(), replayed,
    },
    meta: { replayed },
  };
}

async function summarizeCosts(service: Workroom, input: SummaryInput) {
  await service.authorize(input.room);
  await available(service.database);
  let rows: { record_json: string }[];
  try {
    rows = (await service.database.prepare(`SELECT record_json FROM unit_cost_records WHERE room_id = ? ORDER BY recorded_at, rowid`)
      .bind(input.room).all<{ record_json: string }>()).results;
  } catch (error) {
    if (missingTable(error)) throw new Fault('NOT_AVAILABLE', 'Budget ledger is not installed.', 400, 'not_applied');
    throw error;
  }
  let records: RecordedUnitCost[];
  try {
    records = rows.map(row => JSON.parse(row.record_json) as RecordedUnitCost);
  } catch {
    throw new Fault('TEMPORARY_FAILURE', 'Stored unit costs could not be read.', 503, 'unknown', true);
  }
  const aggregate = aggregateUnitCosts(records);
  if (!aggregate.ok) throw new Fault('TEMPORARY_FAILURE', 'Stored unit costs could not be aggregated.', 503, 'unknown', true);
  return { data: { room_id: input.room, aggregate: aggregate.value }, meta: {} };
}

function storedReport(report: DispatchReport): Record<string, unknown> {
  return {
    state: report.state, micro_usd: report.micro_usd, cost_field: report.cost_field, text: report.text, reason: report.reason,
    attempt_id: report.attempt_id, run_id: report.run_id, reservation_id: report.reservation_id, summary: report.summary,
    generation_id: report.generation_id, estimate_micro_usd: report.estimate_micro_usd, reserve_micro_usd: report.reserve_micro_usd,
    remaining: report.remaining,
  };
}

function viewDispatch(principal: string, row: DispatchRow, replayed: boolean) {
  const stored = JSON.parse(row.result_json ?? 'null') as Record<string, unknown> | null;
  if (!stored || typeof stored !== 'object') throw new Fault('TEMPORARY_FAILURE', 'Stored dispatch result could not be read.', 503, 'unknown', true);
  return {
    data: { ...stored, principal_id: principal, room_id: row.room_id, message_id: row.message_id ?? null, replayed },
    meta: { replayed },
  };
}

const DISPATCH_SELECT = `SELECT id, room_id, request_hash, state, result_json, message_id FROM dispatch_calls WHERE principal_id = ? AND idempotency_key = ?`;

async function loadDispatch(db: Database, principal: string, key: string): Promise<DispatchRow | null> {
  return one<DispatchRow>(db, DISPATCH_SELECT, [principal, key]);
}

function guardedFetch(base: typeof fetch): FetchLike {
  return async (input, init) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (target !== CHAT_URL && !target.startsWith(`${GENERATION_URL}?id=`)) throw new Error('outbound url is not an OpenRouter dispatch endpoint');
    return base(input, init);
  };
}

async function postReply(service: Workroom, room: string, idempotencyKeyValue: string, row: DispatchRow): Promise<DispatchRow> {
  if (row.message_id || !row.result_json) return row;
  const stored = JSON.parse(row.result_json) as { state?: unknown; text?: unknown };
  const text = clipReply(typeof stored.text === 'string' ? stored.text : '');
  if ((stored.state !== 'settled' && stored.state !== 'pending_actual') || text.trim().length === 0) return row;
  const key = `dispatch.${(await sha256Hex(`${service.principal}\n${idempotencyKeyValue}`)).slice(0, 40)}`;
  if (!KEY_RE.test(key)) throw new Fault('TEMPORARY_FAILURE', 'Dispatch message key is not valid.', 503, 'unknown', true);
  const posted = await service.post({ schema_version: '1', room, text, format: 'text', idempotency_key: key });
  const messageId = posted.data.message.id;
  await service.database.prepare(`UPDATE dispatch_calls SET message_id = ? WHERE principal_id = ? AND idempotency_key = ? AND message_id IS NULL`)
    .bind(messageId, service.principal, idempotencyKeyValue).all();
  return { ...row, message_id: messageId };
}

async function agentDispatch(service: Workroom, env: DispatchEnv, input: DispatchInput) {
  await service.authorize(input.room, true);
  await available(service.database);
  const apiKey = configuredKey(env);
  if (!apiKey) throw notConfigured();
  const cap = budgetCapUsdMicros(env);
  const maxTokens = input.max_tokens ?? 256;
  const project = input.project ?? 'test';
  try {
    estimateMicroUsd(input.model, input.prompt.length, maxTokens, roster);
  } catch (error) {
    if (error instanceof BoundaryUnavailableError) {
      throw new Fault('NOT_AVAILABLE', 'Dispatch cost estimation is not available.', 400, 'not_applied');
    }
    const message = error instanceof Error ? error.message : 'model not in roster';
    throw new Fault('INVALID_INPUT', message);
  }
  const request = { room: input.room, model: input.model, prompt: input.prompt, max_tokens: maxTokens, project };
  const hash = await canonicalHash(request);
  const db = service.database;
  let row = await loadDispatch(db, service.principal, input.idempotency_key);
  if (row && row.request_hash !== hash) throw new Fault('IDEMPOTENCY_CONFLICT', 'Key already has different dispatch content.', 409);
  if (row?.result_json) {
    row = await postReply(service, input.room, input.idempotency_key, row);
    return viewDispatch(service.principal, row, true);
  }
  if (row) throw new Fault('TEMPORARY_FAILURE', 'Dispatch attempt is incomplete. Retry the same key after it finishes.', 503, 'unknown', true);
  const freshId = `dc_${crypto.randomUUID()}`;
  const claim = await db.batch<DispatchRow>([
    db.prepare(`INSERT INTO dispatch_calls (
        id, principal_id, room_id, idempotency_key, request_hash, reservation_id, state, result_json, message_id, created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 'started', NULL, NULL, ?)
      ON CONFLICT(principal_id, idempotency_key) DO NOTHING`).bind(freshId, service.principal, input.room, input.idempotency_key, hash, Date.now()),
    db.prepare(DISPATCH_SELECT).bind(service.principal, input.idempotency_key),
  ]);
  row = claim[1]?.results[0] ?? await loadDispatch(db, service.principal, input.idempotency_key);
  if (!row) throw new Fault('TEMPORARY_FAILURE', 'Dispatch attempt was not stored.', 503, 'unknown', true);
  if (row.request_hash !== hash) throw new Fault('IDEMPOTENCY_CONFLICT', 'Key already has different dispatch content.', 409);
  if (row.result_json) {
    row = await postReply(service, input.room, input.idempotency_key, row);
    return viewDispatch(service.principal, row, true);
  }
  if (row.id !== freshId) throw new Fault('TEMPORARY_FAILURE', 'Dispatch attempt is incomplete. Retry the same key after it finishes.', 503, 'unknown', true);

  const attemptId = `${service.principal}|${input.idempotency_key}`;
  const runId = `run-${(await sha256Hex(`${service.principal}\n${input.idempotency_key}`)).slice(0, 12)}`;
  let report: DispatchReport;
  try {
    report = await dispatch({
      model: input.model, project, prompt: input.prompt, maxTokens, run_id: runId, attempt_id: attemptId,
      ledger: openD1Ledger(db, service.principal, cap), roster, fetchImpl: guardedFetch(globalThis.fetch),
      apiKey, timeoutMs: 10_000, costRetries: 1, costDelayMs: 0,
    });
  } catch (error) {
    const held = await one<{ reservation_id: string }>(db, 'SELECT reservation_id FROM budget_reservations WHERE attempt_id = ?', [attemptId]);
    if (!held) await db.prepare('DELETE FROM dispatch_calls WHERE id = ? AND result_json IS NULL').bind(freshId).all();
    throw error;
  }
  const payload = JSON.stringify(storedReport(report));
  const reservationId = typeof report.reservation_id === 'string' ? report.reservation_id : null;
  await db.prepare(`UPDATE dispatch_calls SET result_json = ?, state = ?, reservation_id = ? WHERE id = ? AND result_json IS NULL`)
    .bind(payload, report.state, reservationId, freshId).all();
  row = await loadDispatch(db, service.principal, input.idempotency_key);
  if (!row?.result_json) throw new Fault('TEMPORARY_FAILURE', 'Dispatch result was not stored.', 503, 'unknown', true);
  row = await postReply(service, input.room, input.idempotency_key, row);
  return viewDispatch(service.principal, row, false);
}

export function registerDispatchTools(server: McpServer, service: Workroom, env: object, result: ResultFn, hints: Hints): void {
  const bindings = readDispatchEnv(env);
  server.registerTool(UNIT_COST_RECORD_TOOL.name, {
    description: UNIT_COST_RECORD_TOOL.description, inputSchema: unitCostRecordSchema,
    annotations: { ...hints, readOnlyHint: false, idempotentHint: true },
  }, ((input: RecordInput) => result(() => recordCost(service, input), true)) as never);
  server.registerTool(UNIT_COST_SUMMARY_TOOL.name, {
    description: UNIT_COST_SUMMARY_TOOL.description, inputSchema: unitCostSummarySchema, annotations: hints,
  }, ((input: SummaryInput) => result(() => summarizeCosts(service, input), true)) as never);
  server.registerTool(AGENT_DISPATCH_TOOL.name, {
    description: AGENT_DISPATCH_TOOL.description, inputSchema: agentDispatchSchema,
    annotations: { ...hints, readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  }, ((input: DispatchInput) => result(() => agentDispatch(service, bindings, input), true)) as never);
}

const BODY_IDENTITY = ['room', 'idempotency_key', 'principal_id', 'actor_id', 'principal'];

export async function dispatchRoute(service: Workroom, env: object, request: Request, url: URL, readJSON: () => Promise<unknown>) {
  const match = /^\/api\/v1\/rooms\/([^/]+)\/(unit-costs|dispatch)$/.exec(url.pathname);
  if (!match) return null;
  if (url.search) throw new Fault('INVALID_INPUT', 'No query parameters.');
  let room: string;
  try { room = decodeURIComponent(match[1] ?? ''); } catch { throw new Fault('INVALID_INPUT', 'Room path is not valid.'); }
  const action = match[2];
  if (action === 'unit-costs' && request.method === 'GET') return summarizeCosts(service, unitCostSummarySchema.parse({ schema_version: '1', room }));
  if (request.method !== 'POST') throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
  const body = await readJSON();
  if (!body || typeof body !== 'object' || Array.isArray(body) || BODY_IDENTITY.some(key => key in body)) {
    throw new Fault('INVALID_INPUT', 'Identity and path fields cannot be supplied in the body.');
  }
  const idempotency_key = keySchema.parse(request.headers.get('idempotency-key'));
  const merged = { ...body, room, idempotency_key };
  if (action === 'unit-costs') return recordCost(service, unitCostRecordSchema.parse(merged));
  return agentDispatch(service, readDispatchEnv(env), agentDispatchSchema.parse(merged));
}

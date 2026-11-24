// Judgment rows for migration 0078. Separate from the 0055 owner-decision ledger.

import type { Database, Value } from '../server/db.ts';

export const JUDGMENT_COLUMNS = [
  'id',
  'point',
  'unit_id',
  'input_hash',
  'source_watermark',
  'hard_filter_result_json',
  'request_payload_json',
  'provider_path',
  'routing_reason',
  'model',
  'answer_json',
  'probs_json',
  'verdict',
  'shadow_decider_json',
  'rule_baseline',
  'agreed',
  'cost_micro_usd',
  'gen_id',
  'latency_ms',
  'created_at',
  'consumed_by',
] as const;

export type ProviderPath = 'd1' | 'jev' | 'llm' | 'rule';
export type Verdict = 'act' | 'reject' | 'unsettled' | 'fallback_rule';

export interface JudgmentRow {
  id: string;
  point: string;
  unit_id: string;
  input_hash: string;
  source_watermark: string | null;
  hard_filter_result_json: string | null;
  request_payload_json: string | null;
  provider_path: ProviderPath;
  routing_reason: string | null;
  model: string | null;
  answer_json: string | null;
  probs_json: string | null;
  verdict: Verdict;
  shadow_decider_json: string | null;
  rule_baseline: string;
  agreed: 0 | 1;
  cost_micro_usd: number | null;
  gen_id: string | null;
  latency_ms: number | null;
  created_at: string;
  consumed_by: string | null;
}

export interface JudgmentStore {
  insert(row: JudgmentRow): Promise<void>;
}

export class MemoryJudgmentStore implements JudgmentStore {
  readonly rows: JudgmentRow[] = [];

  async insert(row: JudgmentRow): Promise<void> {
    this.rows.push({ ...row });
  }
}

export function createD1JudgmentStore(db: Database): JudgmentStore {
  return { insert: row => insertJudgment(db, row) };
}

export function missingJudgmentsTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  return `${message} ${cause}`.toLowerCase().includes('no such table');
}

/** Writes a judgment when 0078 is present. A missing table is not an error. */
export function createTolerantJudgmentStore(db: Database): JudgmentStore {
  return {
    async insert(row) {
      try {
        await insertJudgment(db, row);
      } catch (error) {
        if (missingJudgmentsTable(error)) return;
        throw error;
      }
    },
  };
}

export async function insertJudgment(db: Database, row: JudgmentRow): Promise<void> {
  const sql = `INSERT INTO judgments (${JUDGMENT_COLUMNS.join(', ')}) VALUES (${JUDGMENT_COLUMNS.map(() => '?').join(', ')})`;
  await db.prepare(sql).bind(...rowValues(row)).all();
}

export interface JudgmentFilter {
  point?: string;
  unit_id?: string;
  /** Newest first. Defaults to 500, capped at 5000. */
  limit?: number;
}

type RawJudgmentRow = Record<(typeof JUDGMENT_COLUMNS)[number], Value>;

const PROVIDER_PATHS: readonly ProviderPath[] = ['d1', 'jev', 'llm', 'rule'];
const VERDICTS: readonly Verdict[] = ['act', 'reject', 'unsettled', 'fallback_rule'];

function text(value: Value, field: string): string {
  if (typeof value !== 'string') throw new Error(`judgment ${field} is not text`);
  return value;
}

function nullableText(value: Value): string | null {
  return value === null ? null : text(value, 'column');
}

function nullableCount(value: Value): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('judgment count column is not a non-negative integer');
  }
  return value;
}

function judgmentFromRaw(raw: RawJudgmentRow): JudgmentRow {
  const path = text(raw.provider_path, 'provider_path');
  if (!PROVIDER_PATHS.includes(path as ProviderPath)) throw new Error('judgment provider_path is unknown');
  const verdict = text(raw.verdict, 'verdict');
  if (!VERDICTS.includes(verdict as Verdict)) throw new Error('judgment verdict is unknown');
  if (raw.agreed !== 0 && raw.agreed !== 1) throw new Error('judgment agreed is not 0 or 1');
  return {
    id: text(raw.id, 'id'),
    point: text(raw.point, 'point'),
    unit_id: text(raw.unit_id, 'unit_id'),
    input_hash: text(raw.input_hash, 'input_hash'),
    source_watermark: nullableText(raw.source_watermark),
    hard_filter_result_json: nullableText(raw.hard_filter_result_json),
    request_payload_json: nullableText(raw.request_payload_json),
    provider_path: path as ProviderPath,
    routing_reason: nullableText(raw.routing_reason),
    model: nullableText(raw.model),
    answer_json: nullableText(raw.answer_json),
    probs_json: nullableText(raw.probs_json),
    verdict: verdict as Verdict,
    shadow_decider_json: nullableText(raw.shadow_decider_json),
    rule_baseline: text(raw.rule_baseline, 'rule_baseline'),
    agreed: raw.agreed,
    cost_micro_usd: nullableCount(raw.cost_micro_usd),
    gen_id: nullableText(raw.gen_id),
    latency_ms: nullableCount(raw.latency_ms),
    created_at: text(raw.created_at, 'created_at'),
    consumed_by: nullableText(raw.consumed_by),
  };
}

/** Recorded judgments, newest first. Read side for the shadow report; never writes. */
export async function listJudgments(db: Database, filter: JudgmentFilter = {}): Promise<JudgmentRow[]> {
  const limit = filter.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
    throw new Error('judgment list limit out of range');
  }
  const clauses: string[] = [];
  const binds: Value[] = [];
  if (filter.point !== undefined) { clauses.push('point = ?'); binds.push(filter.point); }
  if (filter.unit_id !== undefined) { clauses.push('unit_id = ?'); binds.push(filter.unit_id); }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const sql = `SELECT ${JUDGMENT_COLUMNS.join(', ')} FROM judgments${where} ORDER BY created_at DESC, id DESC LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...binds, limit).all<RawJudgmentRow>();
  return results.map(judgmentFromRaw);
}

function rowValues(row: JudgmentRow): Value[] {
  return [
    row.id,
    row.point,
    row.unit_id,
    row.input_hash,
    row.source_watermark,
    row.hard_filter_result_json,
    row.request_payload_json,
    row.provider_path,
    row.routing_reason,
    row.model,
    row.answer_json,
    row.probs_json,
    row.verdict,
    row.shadow_decider_json,
    row.rule_baseline,
    row.agreed,
    row.cost_micro_usd,
    row.gen_id,
    row.latency_ms,
    row.created_at,
    row.consumed_by,
  ];
}

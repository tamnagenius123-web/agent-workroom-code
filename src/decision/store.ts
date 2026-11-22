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

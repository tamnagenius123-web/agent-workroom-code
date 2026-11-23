// Shadow evaluation report for the G3 decision layer (keep-shadow unit).
//
// Quality and cost are measured against a fixed baseline: the rule baseline
// recorded on every judgment row. The rule path makes no provider call, so
// the baseline cost is zero and every micro-USD in this report is shadow
// overhead. `agreed` on a row means the recorded verdict took the same action
// as the baseline (reject / fallback_rule = hold); anything else is a
// disagreement the shadow run surfaced without applying.
//
// Actual token usage is not a judgments column. It is recorded by the budget
// ledger at settle time (migration 0028, budget_actuals.tokens_json) keyed by
// generation_id, and judgments.gen_id names the primary generation, so the
// join below is the shadow record's usage. Adding denormalized token columns
// to judgments would need a new migration number, which is reserved in the
// room before use and is not taken here.
//
// This module only reads and aggregates. It never applies a verdict.

import type { Database } from '../server/db.ts';
import {
  listJudgments,
  missingJudgmentsTable,
  type JudgmentFilter,
  type JudgmentRow,
  type ProviderPath,
  type Verdict,
} from './store.ts';

export interface GenerationActual {
  generation_id: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  micro_usd: number;
}

export interface ShadowGroupStats {
  judgments: number;
  /** Judgments a provider model made (provider_path is not 'rule'). */
  model_judgments: number;
  agreed: number;
  /** agreed / judgments, or null when there are no judgments. */
  agreement_rate: number | null;
  model_agreed: number;
  /** model_agreed / model_judgments, or null when no model judged. */
  model_agreement_rate: number | null;
  verdicts: Record<Verdict, number>;
  charged_judgments: number;
  total_cost_micro_usd: number;
  /** Mean over charged judgments only; uncharged rows are not zero-cost proof. */
  mean_cost_micro_usd: number | null;
  max_cost_micro_usd: number | null;
  /** Judgments whose gen_id has at least one settled budget actual. */
  usage_matched: number;
  /** usage_matched / judgments carrying a gen_id, or null when none do. */
  usage_coverage: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Matched actuals where a token field was null; those fields add nothing above. */
  token_unknown_fields: number;
  latency_samples: number;
  mean_latency_ms: number | null;
  max_latency_ms: number | null;
}

export interface ShadowReport {
  baseline: {
    /** Distinct rule_baseline values present, sorted. */
    rule_baselines: string[];
    baseline_cost_micro_usd: 0;
    /** Total shadow spend above the zero-cost baseline. */
    shadow_overhead_micro_usd: number;
  };
  overall: ShadowGroupStats;
  by_point: Record<string, ShadowGroupStats>;
  by_provider_path: Partial<Record<ProviderPath, ShadowGroupStats>>;
}

const VERDICT_ORDER: readonly Verdict[] = ['act', 'reject', 'unsettled', 'fallback_rule'];
const PATH_ORDER: readonly ProviderPath[] = ['d1', 'jev', 'llm', 'rule'];

function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

function mean(total: number, count: number): number | null {
  if (count === 0) return null;
  return Math.round((total / count) * 1000) / 1000;
}

interface Accumulator {
  judgments: number;
  model_judgments: number;
  agreed: number;
  model_agreed: number;
  verdicts: Record<Verdict, number>;
  charged_judgments: number;
  total_cost_micro_usd: number;
  max_cost_micro_usd: number | null;
  with_gen: number;
  usage_matched: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  token_unknown_fields: number;
  latency_samples: number;
  latency_total: number;
  max_latency_ms: number | null;
}

function emptyAccumulator(): Accumulator {
  return {
    judgments: 0,
    model_judgments: 0,
    agreed: 0,
    model_agreed: 0,
    verdicts: { act: 0, reject: 0, unsettled: 0, fallback_rule: 0 },
    charged_judgments: 0,
    total_cost_micro_usd: 0,
    max_cost_micro_usd: null,
    with_gen: 0,
    usage_matched: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    token_unknown_fields: 0,
    latency_samples: 0,
    latency_total: 0,
    max_latency_ms: null,
  };
}

function addToken(acc: Accumulator, field: 'prompt_tokens' | 'completion_tokens' | 'total_tokens', value: number | null): void {
  if (value === null) { acc.token_unknown_fields += 1; return; }
  acc[field] += value;
}

function accumulate(acc: Accumulator, row: JudgmentRow, actuals: ReadonlyMap<string, GenerationActual>): void {
  acc.judgments += 1;
  acc.verdicts[row.verdict] += 1;
  acc.agreed += row.agreed;
  if (row.provider_path !== 'rule') {
    acc.model_judgments += 1;
    acc.model_agreed += row.agreed;
  }
  if (row.cost_micro_usd !== null) {
    acc.charged_judgments += 1;
    acc.total_cost_micro_usd += row.cost_micro_usd;
    acc.max_cost_micro_usd = acc.max_cost_micro_usd === null ? row.cost_micro_usd : Math.max(acc.max_cost_micro_usd, row.cost_micro_usd);
  }
  if (row.gen_id !== null) {
    acc.with_gen += 1;
    const actual = actuals.get(row.gen_id);
    if (actual) {
      acc.usage_matched += 1;
      addToken(acc, 'prompt_tokens', actual.prompt_tokens);
      addToken(acc, 'completion_tokens', actual.completion_tokens);
      addToken(acc, 'total_tokens', actual.total_tokens);
    }
  }
  if (row.latency_ms !== null) {
    acc.latency_samples += 1;
    acc.latency_total += row.latency_ms;
    acc.max_latency_ms = acc.max_latency_ms === null ? row.latency_ms : Math.max(acc.max_latency_ms, row.latency_ms);
  }
}

function finishGroup(acc: Accumulator): ShadowGroupStats {
  const verdicts = {} as Record<Verdict, number>;
  for (const verdict of VERDICT_ORDER) verdicts[verdict] = acc.verdicts[verdict];
  return {
    judgments: acc.judgments,
    model_judgments: acc.model_judgments,
    agreed: acc.agreed,
    agreement_rate: rate(acc.agreed, acc.judgments),
    model_agreed: acc.model_agreed,
    model_agreement_rate: rate(acc.model_agreed, acc.model_judgments),
    verdicts,
    charged_judgments: acc.charged_judgments,
    total_cost_micro_usd: acc.total_cost_micro_usd,
    mean_cost_micro_usd: acc.charged_judgments ? mean(acc.total_cost_micro_usd, acc.charged_judgments) : null,
    max_cost_micro_usd: acc.max_cost_micro_usd,
    usage_matched: acc.usage_matched,
    usage_coverage: rate(acc.usage_matched, acc.with_gen),
    prompt_tokens: acc.prompt_tokens,
    completion_tokens: acc.completion_tokens,
    total_tokens: acc.total_tokens,
    token_unknown_fields: acc.token_unknown_fields,
    latency_samples: acc.latency_samples,
    mean_latency_ms: acc.latency_samples ? mean(acc.latency_total, acc.latency_samples) : null,
    max_latency_ms: acc.max_latency_ms,
  };
}

function groupStats<K extends string>(rows: readonly JudgmentRow[], actuals: ReadonlyMap<string, GenerationActual>, keyOf: (row: JudgmentRow) => K, order: readonly K[] | 'sorted'): Record<K, ShadowGroupStats> {
  const groups = new Map<K, Accumulator>();
  for (const row of rows) {
    const key = keyOf(row);
    let acc = groups.get(key);
    if (!acc) { acc = emptyAccumulator(); groups.set(key, acc); }
    accumulate(acc, row, actuals);
  }
  const keys = order === 'sorted'
    ? [...groups.keys()].sort()
    : order.filter(key => groups.has(key));
  const out = {} as Record<K, ShadowGroupStats>;
  for (const key of keys) out[key] = finishGroup(groups.get(key) as Accumulator);
  return out;
}

/** Pure aggregation. Same rows and actuals give the same report in any input order. */
export function buildShadowReport(rows: readonly JudgmentRow[], actuals: readonly GenerationActual[] = []): ShadowReport {
  const byGeneration = new Map<string, GenerationActual>();
  for (const actual of actuals) {
    const existing = byGeneration.get(actual.generation_id);
    if (!existing) { byGeneration.set(actual.generation_id, { ...actual }); continue; }
    existing.micro_usd += actual.micro_usd;
    existing.prompt_tokens = sumNullable(existing.prompt_tokens, actual.prompt_tokens);
    existing.completion_tokens = sumNullable(existing.completion_tokens, actual.completion_tokens);
    existing.total_tokens = sumNullable(existing.total_tokens, actual.total_tokens);
  }
  const overall = emptyAccumulator();
  for (const row of rows) accumulate(overall, row, byGeneration);
  const overallStats = finishGroup(overall);
  return {
    baseline: {
      rule_baselines: [...new Set(rows.map(row => row.rule_baseline))].sort(),
      baseline_cost_micro_usd: 0,
      shadow_overhead_micro_usd: overallStats.total_cost_micro_usd,
    },
    overall: overallStats,
    by_point: groupStats(rows, byGeneration, row => row.point, 'sorted'),
    by_provider_path: groupStats(rows, byGeneration, row => row.provider_path, PATH_ORDER),
  };
}

function sumNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

function tokenField(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** Parses a budget_actuals.tokens_json value. Returns null when it is not a token record. */
export function parseTokensJson(json: string): { prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null } | null {
  let raw: unknown;
  try { raw = JSON.parse(json) as unknown; } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!('prompt' in record) && !('completion' in record) && !('total' in record)) return null;
  // A record whose fields are all null or unusable still counts as settled
  // usage with unknown token counts.
  return {
    prompt_tokens: tokenField(record.prompt),
    completion_tokens: tokenField(record.completion),
    total_tokens: tokenField(record.total),
  };
}

interface RawActualRow {
  generation_id: string;
  tokens_json: string;
  micro_usd: number;
}

async function listGenerationActuals(db: Database, generationIds: readonly string[]): Promise<GenerationActual[]> {
  const unique = [...new Set(generationIds)];
  if (!unique.length) return [];
  const out: GenerationActual[] = [];
  try {
    for (let start = 0; start < unique.length; start += 100) {
      const chunk = unique.slice(start, start + 100);
      const placeholders = chunk.map(() => '?').join(', ');
      const { results } = await db.prepare(
        `SELECT generation_id, tokens_json, micro_usd FROM budget_actuals WHERE generation_id IN (${placeholders})`,
      ).bind(...chunk).all<RawActualRow>();
      for (const row of results) {
        const tokens = parseTokensJson(row.tokens_json);
        if (!tokens) continue;
        out.push({ generation_id: row.generation_id, micro_usd: row.micro_usd, ...tokens });
      }
    }
  } catch (error) {
    if (missingJudgmentsTable(error)) return [];
    throw error;
  }
  return out;
}

/** Reads recorded judgments and their settled actuals, then builds the report. */
export async function readShadowReport(db: Database, filter: JudgmentFilter = {}): Promise<ShadowReport> {
  const rows = await listJudgments(db, filter);
  const actuals = await listGenerationActuals(db, rows.map(row => row.gen_id).filter((id): id is string => id !== null));
  return buildShadowReport(rows, actuals);
}

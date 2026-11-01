// P4 per-unit cost for one Grok CLI terminal. Pure: no clock, no I/O, no ledger write.
// The contract object is the W0 UnitCostRecord. This file does not edit src/phase-contracts/.
// cost_usd_micros is an integer micro-USD or the literal UNKNOWN. Subscription usage has no
// dollar invoice, so a subscription cost is UNKNOWN, never 0 and never a rate-table product.
// An unobserved metered cost is also UNKNOWN. An observed 0 on a metered lane stays 0.
// Aggregation: one UNKNOWN dollar cost makes the total UNKNOWN. Token counts still add.
// known_usd_micros keeps the observed part so the hole stays explainable. An empty set is
// UNKNOWN, not a measured zero. Category spelling is the W0 SpendCategory enum.

import {
  SCHEMA_VERSION, includesConst, isRecord, type PhaseCheck,
} from '../phase-contracts/check.ts';
import {
  SPEND_CATEGORIES, validateUnitCostRecord, type SpendCategory, type UnitCostRecord,
} from '../phase-contracts/dispatch.ts';

export const UNKNOWN_COST = 'UNKNOWN' as const;
export type CostUsdMicros = number | typeof UNKNOWN_COST;

export interface RecordedUnitCost {
  /** W0 projection. category and cost_usd_micros are not fields on this object. */
  record: UnitCostRecord;
  category: SpendCategory;
  cost_usd_micros: CostUsdMicros;
}

export interface CategoryCostTotal {
  record_count: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd_micros: CostUsdMicros;
  known_usd_micros: number;
  unknown_count: number;
}

export interface UnitCostAggregate extends CategoryCostTotal {
  by_category: Record<SpendCategory, CategoryCostTotal>;
}

const INPUT_KEYS = [
  'schema_version', 'consumer', 'provenance', 'proof_mode',
  'unit_id', 'tool', 'model', 'tokens_in', 'tokens_out',
  'category', 'cost_usd_micros',
] as const;

interface MutableTotal {
  record_count: number;
  tokens_in: number;
  tokens_out: number;
  known_usd_micros: number;
  unknown_count: number;
}

function readCategory(value: unknown): SpendCategory | undefined {
  if (typeof value !== 'string' || !includesConst(SPEND_CATEGORIES, value)) return undefined;
  return value;
}

function readCost(value: unknown): CostUsdMicros | undefined {
  if (value === UNKNOWN_COST) return UNKNOWN_COST;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  return undefined;
}

function subscriptionDollarError(cost: number): string {
  if (cost === 0) return 'unknown subscription usage is UNKNOWN, never 0';
  return 'subscription dollar cost is UNKNOWN; a rate table is not an invoice';
}

// Boolean, not Array.isArray's any[] predicate, so the caller keeps its element type.
function isList(value: unknown): boolean {
  return Array.isArray(value);
}

function blank(): MutableTotal {
  return { record_count: 0, tokens_in: 0, tokens_out: 0, known_usd_micros: 0, unknown_count: 0 };
}

function seal(row: MutableTotal): CategoryCostTotal {
  const unobserved = row.record_count === 0 || row.unknown_count > 0;
  return { ...row, cost_usd_micros: unobserved ? UNKNOWN_COST : row.known_usd_micros };
}

/** Dollar view of a W0 record. A null usd_micros is UNKNOWN. Subscription usage is not added in. */
export function costUsdMicrosOf(record: UnitCostRecord): CostUsdMicros {
  if (record.usd_micros === null) return UNKNOWN_COST;
  return record.usd_micros;
}

export function recordUnitCost(input: unknown): PhaseCheck<RecordedUnitCost> {
  if (!isRecord(input)) return { ok: false, errors: ['unit_cost: expected an object'] };
  const errors: string[] = [];
  for (const key of Object.keys(input)) {
    if (!(INPUT_KEYS as readonly string[]).includes(key)) {
      errors.push(`unit_cost: unknown field ${JSON.stringify(key)}`);
    }
  }
  const category = readCategory(input.category);
  if (!category) errors.push(`unit_cost.category: expected one of ${SPEND_CATEGORIES.join('|')}`);
  const cost = readCost(input.cost_usd_micros);
  if (cost === undefined) {
    errors.push('unit_cost.cost_usd_micros: expected an integer >= 0 or the literal UNKNOWN');
  } else if (category === 'subscription' && typeof cost === 'number') {
    errors.push(`unit_cost.cost_usd_micros: ${subscriptionDollarError(cost)}`);
  }
  const usd_micros: number | null = typeof cost === 'number' && category !== 'subscription' ? cost : null;
  const parsed = validateUnitCostRecord({
    schema_version: 'schema_version' in input ? input.schema_version : SCHEMA_VERSION,
    consumer: input.consumer,
    provenance: input.provenance,
    proof_mode: input.proof_mode,
    unit_id: input.unit_id,
    tool: input.tool,
    model: input.model,
    tokens_in: input.tokens_in,
    tokens_out: input.tokens_out,
    usd_micros,
    subscription_usage: UNKNOWN_COST,
  });
  if (!parsed.ok) errors.push(...parsed.errors);
  if (!parsed.ok || !category || cost === undefined || errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { record: parsed.value, category, cost_usd_micros: cost } };
}

function rowErrors(row: RecordedUnitCost, index: number): string[] {
  const path = `unit_cost.aggregate[${index}]`;
  const errors: string[] = [];
  if (!isRecord(row) || !isRecord(row.record)) return [`${path}: expected a recorded unit cost`];
  const category = readCategory(row.category);
  if (!category) errors.push(`${path}.category: expected one of ${SPEND_CATEGORIES.join('|')}`);
  const cost = readCost(row.cost_usd_micros);
  if (cost === undefined) {
    errors.push(`${path}.cost_usd_micros: expected an integer >= 0 or the literal UNKNOWN`);
  } else if (category === 'subscription' && typeof cost === 'number') {
    errors.push(`${path}.cost_usd_micros: ${subscriptionDollarError(cost)}`);
  }
  const usage = row.record.subscription_usage;
  if (usage !== UNKNOWN_COST) {
    const phrase = usage === 0
      ? 'unknown subscription usage is UNKNOWN, never 0'
      : 'subscription usage is UNKNOWN; this unit does not record a quota count';
    errors.push(`${path}.record.subscription_usage: ${phrase}`);
  }
  if (cost === UNKNOWN_COST && row.record.usd_micros !== null) {
    errors.push(`${path}: UNKNOWN cost_usd_micros does not match usd_micros`);
  } else if (typeof cost === 'number' && row.record.usd_micros !== cost) {
    errors.push(`${path}: cost_usd_micros does not match usd_micros`);
  }
  for (const key of ['tokens_in', 'tokens_out'] as const) {
    const value = row.record[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      errors.push(`${path}.record.${key}: expected an integer >= 0`);
    }
  }
  return errors;
}

function preview(into: MutableTotal, cost: CostUsdMicros, tokensIn: number, tokensOut: number): MutableTotal | string {
  const tokens_in = into.tokens_in + tokensIn;
  const tokens_out = into.tokens_out + tokensOut;
  if (!Number.isSafeInteger(tokens_in) || !Number.isSafeInteger(tokens_out)) {
    return 'unit_cost.aggregate: token sum is not a safe integer';
  }
  let known_usd_micros = into.known_usd_micros;
  let unknown_count = into.unknown_count;
  if (cost === UNKNOWN_COST) unknown_count += 1;
  else {
    known_usd_micros += cost;
    if (!Number.isSafeInteger(known_usd_micros)) return 'unit_cost.aggregate: micro-USD sum is not a safe integer';
  }
  return {
    record_count: into.record_count + 1,
    tokens_in,
    tokens_out,
    known_usd_micros,
    unknown_count,
  };
}

export function aggregateUnitCosts(records: readonly RecordedUnitCost[]): PhaseCheck<UnitCostAggregate> {
  if (!isList(records)) return { ok: false, errors: ['unit_cost.aggregate: expected an array'] };
  const errors: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const row = records[index];
    if (row === undefined) {
      errors.push(`unit_cost.aggregate[${index}]: expected a recorded unit cost`);
      continue;
    }
    errors.push(...rowErrors(row, index));
  }
  if (errors.length > 0) return { ok: false, errors };

  let overall = blank();
  const buckets: Record<SpendCategory, MutableTotal> = {
    subscription: blank(),
    openrouter: blank(),
    claude_api_credit: blank(),
  };
  for (const row of records) {
    const nextOverall = preview(overall, row.cost_usd_micros, row.record.tokens_in, row.record.tokens_out);
    const nextBucket = preview(buckets[row.category], row.cost_usd_micros, row.record.tokens_in, row.record.tokens_out);
    if (typeof nextOverall === 'string') return { ok: false, errors: [nextOverall] };
    if (typeof nextBucket === 'string') return { ok: false, errors: [nextBucket] };
    overall = nextOverall;
    buckets[row.category] = nextBucket;
  }
  return {
    ok: true,
    value: {
      ...seal(overall),
      by_category: {
        subscription: seal(buckets.subscription),
        openrouter: seal(buckets.openrouter),
        claude_api_credit: seal(buckets.claude_api_credit),
      },
    },
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { validateUnitCostRecord } from '../src/phase-contracts/dispatch.ts';
import {
  aggregateUnitCosts, costUsdMicrosOf, recordUnitCost, type RecordedUnitCost,
} from '../src/server/unit-cost.ts';

function observation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1',
    consumer: 'P4',
    provenance: {
      kind: 'synthetic_fixture',
      producer_id: 'producer_p4',
      source_ref: 'fixture:unit-cost',
    },
    proof_mode: 'synthetic',
    unit_id: 'unit_p4_001',
    tool: 'grok',
    model: 'grok-4.7',
    tokens_in: 120,
    tokens_out: 30,
    category: 'subscription',
    cost_usd_micros: 'UNKNOWN',
    ...over,
  };
}

function recorded(over: Record<string, unknown> = {}): RecordedUnitCost {
  const parsed = recordUnitCost(observation(over));
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join(' | '));
  if (!parsed.ok) throw new Error('record failed');
  return parsed.value;
}

test('subscription usage is the literal UNKNOWN and projects onto the W0 record', () => {
  const input = observation();
  const before = structuredClone(input);
  const parsed = recordUnitCost(input);
  assert.deepEqual(input, before);
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join(' | '));
  if (!parsed.ok) return;
  assert.equal(parsed.value.cost_usd_micros, 'UNKNOWN');
  assert.equal(parsed.value.category, 'subscription');
  assert.equal(parsed.value.record.model, 'grok-4.7');
  assert.equal(parsed.value.record.tokens_in, 120);
  assert.equal(parsed.value.record.tokens_out, 30);
  assert.equal(parsed.value.record.usd_micros, null);
  assert.equal(parsed.value.record.subscription_usage, 'UNKNOWN');
  assert.equal(Object.hasOwn(parsed.value.record, 'cost_usd_micros'), false);
  assert.equal(Object.hasOwn(parsed.value.record, 'category'), false);
  const contract = validateUnitCostRecord(parsed.value.record);
  assert.equal(contract.ok, true, contract.ok ? '' : contract.errors.join(' | '));
  assert.deepEqual(recordUnitCost(observation()), parsed);
});

test('subscription cost 0 is rejected and is not stored as zero', () => {
  const parsed = recordUnitCost(observation({ cost_usd_micros: 0 }));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.ok(parsed.errors.some(error => error.includes('never 0')));
  assert.ok(parsed.errors.some(error => error.includes('UNKNOWN')));
});

test('a subscription dollar amount is rejected because it is not an invoice', () => {
  const parsed = recordUnitCost(observation({ cost_usd_micros: 50_000 }));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.ok(parsed.errors.some(error => error.includes('UNKNOWN')));
  assert.ok(parsed.errors.every(error => !error.includes('usd_micros: 50000')));
});

test('openrouter stores an integer micro-USD and does not invent subscription usage', () => {
  const parsed = recordUnitCost(observation({
    unit_id: 'unit_or_001', tool: 'openrouter', model: 'deepseek/deepseek-chat',
    category: 'openrouter', cost_usd_micros: 50_000, tokens_in: 10, tokens_out: 4,
  }));
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join(' | '));
  if (!parsed.ok) return;
  assert.equal(parsed.value.category, 'openrouter');
  assert.equal(parsed.value.cost_usd_micros, 50_000);
  assert.equal(parsed.value.record.usd_micros, 50_000);
  assert.equal(parsed.value.record.subscription_usage, 'UNKNOWN');
  assert.equal(parsed.value.record.model, 'deepseek/deepseek-chat');
  assert.equal(validateUnitCostRecord(parsed.value.record).ok, true);
});

test('claude_api_credit uses the W0 category spelling and an integer micro-USD', () => {
  const parsed = recordUnitCost(observation({
    unit_id: 'unit_cl_001', tool: 'claude', category: 'claude_api_credit', cost_usd_micros: 12,
  }));
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join(' | '));
  if (!parsed.ok) return;
  assert.equal(parsed.value.category, 'claude_api_credit');
  assert.equal(parsed.value.cost_usd_micros, 12);
  assert.equal(parsed.value.record.usd_micros, 12);
  assert.equal(parsed.value.record.subscription_usage, 'UNKNOWN');
});

test('the hyphenated category spelling is rejected', () => {
  const parsed = recordUnitCost(observation({ category: 'claude-api-credit', cost_usd_micros: 12 }));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.ok(parsed.errors.some(error => error.includes('claude_api_credit')));
});

test('an observed openrouter zero stays zero and is distinct from UNKNOWN', () => {
  const parsed = recordUnitCost(observation({
    unit_id: 'unit_or_zero', category: 'openrouter', cost_usd_micros: 0,
  }));
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join(' | '));
  if (!parsed.ok) return;
  assert.equal(parsed.value.cost_usd_micros, 0);
  assert.equal(parsed.value.record.usd_micros, 0);
  assert.notEqual(parsed.value.cost_usd_micros, 'UNKNOWN');
});

test('an unobserved metered cost stays UNKNOWN and is not coerced to 0', () => {
  const parsed = recordUnitCost(observation({
    unit_id: 'unit_or_unk', category: 'openrouter', cost_usd_micros: 'UNKNOWN',
  }));
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join(' | '));
  if (!parsed.ok) return;
  assert.equal(parsed.value.cost_usd_micros, 'UNKNOWN');
  assert.equal(parsed.value.record.usd_micros, null);
  assert.equal(costUsdMicrosOf(parsed.value.record), 'UNKNOWN');
});

test('null, floats, and numeric strings are not a micro-USD cost', () => {
  for (const cost_usd_micros of [null, 1.5, -1, '0', '50000', Number.NaN, Number.POSITIVE_INFINITY]) {
    const parsed = recordUnitCost(observation({ category: 'openrouter', cost_usd_micros }));
    assert.equal(parsed.ok, false, `accepted ${String(cost_usd_micros)}`);
    if (parsed.ok) return;
    assert.ok(parsed.errors.some(error => error.includes('UNKNOWN')), String(cost_usd_micros));
  }
});

test('callers cannot smuggle usd_micros or subscription_usage past the boundary', () => {
  const parsed = recordUnitCost(observation({ usd_micros: 0, subscription_usage: 0 }));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.ok(parsed.errors.some(error => error.includes('usd_micros')));
  assert.ok(parsed.errors.some(error => error.includes('subscription_usage')));
});

test('a synthetic fixture cannot validate as live proof', () => {
  const parsed = recordUnitCost(observation({ proof_mode: 'live' }));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.ok(parsed.errors.some(error => error.includes('live')));
});

test('dollar projection reads usd_micros and does not add subscription usage into it', () => {
  const metered = recorded({ unit_id: 'unit_or_002', category: 'openrouter', cost_usd_micros: 80 });
  assert.equal(costUsdMicrosOf(metered.record), 80);
  const quotaAndDollars: RecordedUnitCost['record'] = {
    ...metered.record, usd_micros: 100, subscription_usage: 12,
  };
  assert.equal(costUsdMicrosOf(quotaAndDollars), 100);
  const quotaOnly: RecordedUnitCost['record'] = { ...metered.record, usd_micros: null, subscription_usage: 12 };
  assert.equal(costUsdMicrosOf(quotaOnly), 'UNKNOWN');
  assert.notEqual(costUsdMicrosOf(quotaOnly), 12);
  assert.notEqual(costUsdMicrosOf(quotaOnly), 0);
});

test('known micro-USD amounts add, including an observed zero', () => {
  const total = aggregateUnitCosts([
    recorded({ unit_id: 'unit_or_a', category: 'openrouter', cost_usd_micros: 100, tokens_in: 3, tokens_out: 5 }),
    recorded({ unit_id: 'unit_or_b', category: 'openrouter', cost_usd_micros: 250, tokens_in: 7, tokens_out: 1 }),
    recorded({ unit_id: 'unit_cl_b', category: 'claude_api_credit', cost_usd_micros: 0, tokens_in: 1, tokens_out: 1 }),
  ]);
  assert.equal(total.ok, true, total.ok ? '' : total.errors.join(' | '));
  if (!total.ok) return;
  assert.equal(total.value.cost_usd_micros, 350);
  assert.equal(total.value.known_usd_micros, 350);
  assert.equal(total.value.unknown_count, 0);
  assert.equal(total.value.record_count, 3);
  assert.equal(total.value.tokens_in, 11);
  assert.equal(total.value.tokens_out, 7);
  assert.equal(total.value.by_category.openrouter.cost_usd_micros, 350);
  assert.equal(total.value.by_category.claude_api_credit.cost_usd_micros, 0);
});

test('one UNKNOWN cost makes the total UNKNOWN and does not count as zero', () => {
  const total = aggregateUnitCosts([
    recorded({ unit_id: 'unit_or_c', category: 'openrouter', cost_usd_micros: 100, tokens_in: 4, tokens_out: 6 }),
    recorded({ unit_id: 'unit_sub_c', category: 'subscription', cost_usd_micros: 'UNKNOWN', tokens_in: 8, tokens_out: 2 }),
    recorded({ unit_id: 'unit_or_d', category: 'openrouter', cost_usd_micros: 0, tokens_in: 1, tokens_out: 1 }),
  ]);
  assert.equal(total.ok, true, total.ok ? '' : total.errors.join(' | '));
  if (!total.ok) return;
  assert.equal(total.value.cost_usd_micros, 'UNKNOWN');
  assert.notEqual(total.value.cost_usd_micros, 100);
  assert.notEqual(total.value.cost_usd_micros, 0);
  assert.equal(total.value.known_usd_micros, 100);
  assert.equal(total.value.unknown_count, 1);
  assert.equal(total.value.tokens_in, 13);
  assert.equal(total.value.tokens_out, 9);
  assert.equal(total.value.by_category.openrouter.cost_usd_micros, 100);
  assert.equal(total.value.by_category.subscription.cost_usd_micros, 'UNKNOWN');
  assert.equal(total.value.by_category.subscription.unknown_count, 1);
  assert.equal(total.value.by_category.claude_api_credit.record_count, 0);
  assert.equal(total.value.by_category.claude_api_credit.cost_usd_micros, 'UNKNOWN');
  assert.notEqual(total.value.by_category.claude_api_credit.cost_usd_micros, 0);
});

test('an empty aggregate is UNKNOWN, not a measured zero', () => {
  const total = aggregateUnitCosts([]);
  assert.equal(total.ok, true, total.ok ? '' : total.errors.join(' | '));
  if (!total.ok) return;
  assert.equal(total.value.record_count, 0);
  assert.equal(total.value.unknown_count, 0);
  assert.equal(total.value.known_usd_micros, 0);
  assert.equal(total.value.cost_usd_micros, 'UNKNOWN');
  assert.equal(total.value.tokens_in, 0);
  assert.equal(total.value.tokens_out, 0);
});

test('aggregate refuses a smuggled subscription zero instead of adding it', () => {
  const metered = recorded({ unit_id: 'unit_or_e', category: 'openrouter', cost_usd_micros: 40 });
  const smuggled: RecordedUnitCost = {
    record: { ...metered.record, unit_id: 'unit_sub_zero', usd_micros: 0 },
    category: 'subscription',
    cost_usd_micros: 0,
  };
  const total = aggregateUnitCosts([metered, smuggled]);
  assert.equal(total.ok, false);
  if (total.ok) return;
  assert.ok(total.errors.some(error => error.includes('never 0')));
});

test('aggregate refuses a cost that does not match the W0 projection', () => {
  const metered = recorded({ unit_id: 'unit_or_f', category: 'openrouter', cost_usd_micros: 40 });
  const drifted: RecordedUnitCost = { ...metered, cost_usd_micros: 'UNKNOWN' };
  const total = aggregateUnitCosts([drifted]);
  assert.equal(total.ok, false);
  if (total.ok) return;
  assert.ok(total.errors.some(error => error.includes('usd_micros')));
});

test('a micro-USD sum that is not a safe integer is rejected', () => {
  const left = recorded({ unit_id: 'unit_or_g', category: 'openrouter', cost_usd_micros: Number.MAX_SAFE_INTEGER });
  const right = recorded({ unit_id: 'unit_or_h', category: 'openrouter', cost_usd_micros: 1 });
  const total = aggregateUnitCosts([left, right]);
  assert.equal(total.ok, false);
  if (total.ok) return;
  assert.ok(total.errors.some(error => error.includes('safe integer')));
});

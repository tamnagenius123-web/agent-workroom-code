import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { DECISION_LIVE_ENABLED, resolveDecisionConfig } from '../src/decision/config.ts';
import {
  buildShadowReport,
  parseTokensJson,
  readShadowReport,
  type GenerationActual,
} from '../src/decision/shadow-report.ts';
import {
  insertJudgment,
  listJudgments,
  type JudgmentRow,
} from '../src/decision/store.ts';
import type { Database } from '../src/server/db.ts';

const originalFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async () => {
    throw new Error('unexpected network');
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

function row(partial: Partial<JudgmentRow> & { id: string }): JudgmentRow {
  return {
    point: 't2.rebalance',
    unit_id: 'unit-1',
    input_hash: 'hash',
    source_watermark: null,
    hard_filter_result_json: null,
    request_payload_json: null,
    provider_path: 'd1',
    routing_reason: null,
    model: 'liquid/d1.2-ultra',
    answer_json: null,
    probs_json: null,
    verdict: 'act',
    shadow_decider_json: null,
    rule_baseline: 'hold',
    agreed: 0,
    cost_micro_usd: null,
    gen_id: null,
    latency_ms: null,
    created_at: '2026-11-23T00:00:00.000Z',
    consumed_by: null,
    ...partial,
  };
}

const FIXTURE_ROWS: JudgmentRow[] = [
  row({ id: 'r1', verdict: 'act', agreed: 0, cost_micro_usd: 120, latency_ms: 100, gen_id: 'g1' }),
  row({ id: 'r2', verdict: 'reject', agreed: 1, cost_micro_usd: 80, latency_ms: 300, gen_id: 'g2' }),
  row({ id: 'r3', provider_path: 'rule', model: null, verdict: 'fallback_rule', agreed: 1, latency_ms: 5 }),
  row({ id: 'r4', point: 'sweep.owner_question', provider_path: 'jev', model: 'typesafe/jev-1.14-2026', verdict: 'unsettled', agreed: 0, cost_micro_usd: 50_000, gen_id: 'g3' }),
  row({ id: 'r5', provider_path: 'llm', model: 'z-ai/glm-5.3', verdict: 'act', agreed: 0, latency_ms: 50, gen_id: 'g4' }),
];

const FIXTURE_ACTUALS: GenerationActual[] = [
  { generation_id: 'g1', prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, micro_usd: 120 },
  { generation_id: 'g2', prompt_tokens: 50, completion_tokens: null, total_tokens: null, micro_usd: 80 },
  { generation_id: 'g3', prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, micro_usd: 50_000 },
];

test('shadow stays off: the live flag and the default config keep shadow-only', () => {
  assert.equal(DECISION_LIVE_ENABLED, false);
  assert.equal(resolveDecisionConfig().live, false);
});

test('report measures quality and cost against the fixed rule baseline', () => {
  const report = buildShadowReport(FIXTURE_ROWS, FIXTURE_ACTUALS);
  assert.deepEqual(report.baseline, {
    rule_baselines: ['hold'],
    baseline_cost_micro_usd: 0,
    shadow_overhead_micro_usd: 50_200,
  });
  const overall = report.overall;
  assert.equal(overall.judgments, 5);
  assert.equal(overall.model_judgments, 4);
  assert.equal(overall.agreed, 2);
  assert.equal(overall.agreement_rate, 0.4);
  assert.equal(overall.model_agreed, 1);
  assert.equal(overall.model_agreement_rate, 0.25);
  assert.deepEqual(overall.verdicts, { act: 2, reject: 1, unsettled: 1, fallback_rule: 1 });
  assert.equal(overall.charged_judgments, 3);
  assert.equal(overall.total_cost_micro_usd, 50_200);
  assert.equal(overall.mean_cost_micro_usd, 16_733.333);
  assert.equal(overall.max_cost_micro_usd, 50_000);
  assert.equal(overall.latency_samples, 4);
  assert.equal(overall.mean_latency_ms, 113.75);
  assert.equal(overall.max_latency_ms, 300);
});

test('report joins actual token usage by generation id and reports coverage honestly', () => {
  const overall = buildShadowReport(FIXTURE_ROWS, FIXTURE_ACTUALS).overall;
  // g4 has no settled actual, so coverage is 3 of the 4 rows carrying a gen_id.
  assert.equal(overall.usage_matched, 3);
  assert.equal(overall.usage_coverage, 0.75);
  assert.equal(overall.prompt_tokens, 1150);
  assert.equal(overall.completion_tokens, 520);
  assert.equal(overall.total_tokens, 1620);
  // g2 settled without completion/total token counts: unknown, not zero.
  assert.equal(overall.token_unknown_fields, 2);
});

test('report groups by point and provider path with a total order', () => {
  const report = buildShadowReport(FIXTURE_ROWS, FIXTURE_ACTUALS);
  assert.deepEqual(Object.keys(report.by_point), ['sweep.owner_question', 't2.rebalance']);
  assert.deepEqual(Object.keys(report.by_provider_path), ['d1', 'jev', 'llm', 'rule']);
  const t2 = report.by_point['t2.rebalance'];
  assert.ok(t2);
  assert.equal(t2.judgments, 4);
  assert.equal(t2.model_judgments, 3);
  assert.equal(t2.agreement_rate, 0.5);
  assert.equal(t2.model_agreement_rate, 0.333333);
  assert.equal(t2.total_cost_micro_usd, 200);
  assert.equal(t2.usage_coverage, 0.666667);
  const d1 = report.by_provider_path.d1;
  assert.ok(d1);
  assert.equal(d1.judgments, 2);
  assert.equal(d1.usage_coverage, 1);
  assert.equal(d1.mean_latency_ms, 200);
  const rule = report.by_provider_path.rule;
  assert.ok(rule);
  assert.equal(rule.model_judgments, 0);
  assert.equal(rule.model_agreement_rate, null);
  assert.equal(rule.usage_coverage, null);
});

test('report is deterministic under input reordering', () => {
  const shuffled = [FIXTURE_ROWS[3], FIXTURE_ROWS[0], FIXTURE_ROWS[4], FIXTURE_ROWS[1], FIXTURE_ROWS[2]] as JudgmentRow[];
  const actuals = [FIXTURE_ACTUALS[2], FIXTURE_ACTUALS[0], FIXTURE_ACTUALS[1]] as GenerationActual[];
  assert.deepEqual(buildShadowReport(shuffled, actuals), buildShadowReport(FIXTURE_ROWS, FIXTURE_ACTUALS));
});

test('empty input yields a zeroed report with null rates', () => {
  const report = buildShadowReport([]);
  assert.equal(report.overall.judgments, 0);
  assert.equal(report.overall.agreement_rate, null);
  assert.equal(report.overall.usage_coverage, null);
  assert.equal(report.overall.mean_cost_micro_usd, null);
  assert.deepEqual(report.baseline.rule_baselines, []);
  assert.equal(report.baseline.shadow_overhead_micro_usd, 0);
  assert.deepEqual(report.by_point, {});
  assert.deepEqual(report.by_provider_path, {});
});

test('duplicate actuals for one generation are summed once per judgment', () => {
  const rows = [row({ id: 'x1', gen_id: 'g1', cost_micro_usd: 30 })];
  const actuals: GenerationActual[] = [
    { generation_id: 'g1', prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, micro_usd: 10 },
    { generation_id: 'g1', prompt_tokens: 20, completion_tokens: null, total_tokens: 25, micro_usd: 20 },
  ];
  const overall = buildShadowReport(rows, actuals).overall;
  assert.equal(overall.usage_matched, 1);
  assert.equal(overall.prompt_tokens, 30);
  assert.equal(overall.completion_tokens, 5);
  assert.equal(overall.total_tokens, 40);
  assert.equal(overall.token_unknown_fields, 0);
});

test('same gen_id under different providers is not mixed: it reports ambiguous, not matched', () => {
  const rows = [row({ id: 'x1', gen_id: 'g1', cost_micro_usd: 30 })];
  const actuals: GenerationActual[] = [
    { generation_id: 'g1', provider: 'openrouter', provider_account: 'acct-a', prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, micro_usd: 10 },
    { generation_id: 'g1', provider: 'other-provider', provider_account: 'acct-a', prompt_tokens: 20, completion_tokens: 7, total_tokens: 27, micro_usd: 20 },
  ];
  const overall = buildShadowReport(rows, actuals).overall;
  // judgments has no provider column, so neither record can be attributed;
  // the tokens must not be summed into the judgment's usage.
  assert.equal(overall.usage_matched, 0);
  assert.equal(overall.usage_ambiguous, 1);
  assert.equal(overall.usage_coverage, 0);
  assert.equal(overall.prompt_tokens, 0);
  assert.equal(overall.completion_tokens, 0);
  assert.equal(overall.total_tokens, 0);
});

test('same gen_id under different provider accounts is ambiguous too', () => {
  const rows = [row({ id: 'x1', gen_id: 'g1' })];
  const actuals: GenerationActual[] = [
    { generation_id: 'g1', provider: 'openrouter', provider_account: 'acct-a', prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, micro_usd: 10 },
    { generation_id: 'g1', provider: 'openrouter', provider_account: 'acct-b', prompt_tokens: 20, completion_tokens: 7, total_tokens: 27, micro_usd: 20 },
  ];
  const overall = buildShadowReport(rows, actuals).overall;
  assert.equal(overall.usage_matched, 0);
  assert.equal(overall.usage_ambiguous, 1);
  assert.equal(overall.total_tokens, 0);
});

test('same gen_id under one provider account still sums duplicate actuals', () => {
  const rows = [row({ id: 'x1', gen_id: 'g1' })];
  const actuals: GenerationActual[] = [
    { generation_id: 'g1', provider: 'openrouter', provider_account: 'acct-a', prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, micro_usd: 10 },
    { generation_id: 'g1', provider: 'openrouter', provider_account: 'acct-a', prompt_tokens: 20, completion_tokens: null, total_tokens: 25, micro_usd: 20 },
  ];
  const overall = buildShadowReport(rows, actuals).overall;
  assert.equal(overall.usage_matched, 1);
  assert.equal(overall.usage_ambiguous, 0);
  assert.equal(overall.prompt_tokens, 30);
  assert.equal(overall.total_tokens, 40);
});

test('parseTokensJson accepts ledger token records and rejects other shapes', () => {
  assert.deepEqual(parseTokensJson('{"prompt":10,"completion":5,"total":15}'), {
    prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
  });
  assert.deepEqual(parseTokensJson('{"prompt":null,"completion":null,"total":null}'), {
    prompt_tokens: null, completion_tokens: null, total_tokens: null,
  });
  assert.equal(parseTokensJson('{"unrelated":1}'), null);
  assert.equal(parseTokensJson('[1,2]'), null);
  assert.equal(parseTokensJson('not json'), null);
});

function statements(sql: string, db: Database) {
  const body = sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  return body.split(';').map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement));
}

async function database() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(null) } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: 'shadow-report-' + crypto.randomUUID() },
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const db = await mf.getD1Database('DB') as Database;
  return { mf, db };
}

async function applyMigration(db: Database, file: string) {
  const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
  await db.batch(statements(sql, db));
}

test('loader reads judgments and settled actuals from D1', async () => {
  const { mf, db } = await database();
  try {
    await applyMigration(db, '0028_budget_ledger.sql');
    await applyMigration(db, '0078_judgments.sql');
    await insertJudgment(db, row({ id: 'jdg-a', verdict: 'act', agreed: 0, cost_micro_usd: 120, latency_ms: 100, gen_id: 'gen-a', created_at: '2026-11-23T01:00:00.000Z' }));
    await insertJudgment(db, row({ id: 'jdg-b', provider_path: 'rule', model: null, verdict: 'fallback_rule', agreed: 1, latency_ms: 5, created_at: '2026-11-23T02:00:00.000Z' }));
    await db.prepare(`INSERT INTO budget_actuals (id, reservation_id, project, provider, provider_account, generation_id, model, micro_usd, cost_field, tokens_json, flag, created_at)
      VALUES ('act-a', 'res-a', 'test', 'openrouter', '', 'gen-a', 'liquid/d1.2-ultra', 120, 'usage', '{"prompt":100,"completion":20,"total":120}', NULL, '2026-11-23T01:00:01.000Z')`).all();

    const listed = await listJudgments(db);
    assert.deepEqual(listed.map(entry => entry.id), ['jdg-b', 'jdg-a']);
    assert.equal(listed[1]?.provider_path, 'd1');
    assert.equal(listed[1]?.agreed, 0);
    assert.deepEqual((await listJudgments(db, { point: 'sweep.owner_question' })).length, 0);
    await assert.rejects(listJudgments(db, { limit: 0 }), /out of range/);

    const report = await readShadowReport(db);
    assert.equal(report.overall.judgments, 2);
    assert.equal(report.overall.total_cost_micro_usd, 120);
    assert.equal(report.overall.usage_matched, 1);
    assert.equal(report.overall.usage_coverage, 1);
    assert.equal(report.overall.prompt_tokens, 100);
    assert.equal(report.overall.total_tokens, 120);
    assert.equal(report.baseline.shadow_overhead_micro_usd, 120);
  } finally {
    await mf.dispose();
  }
});

test('loader keeps actuals from different provider accounts separate', async () => {
  const { mf, db } = await database();
  try {
    await applyMigration(db, '0028_budget_ledger.sql');
    await applyMigration(db, '0078_judgments.sql');
    await insertJudgment(db, row({ id: 'jdg-a', gen_id: 'gen-x', cost_micro_usd: 30, created_at: '2026-11-23T01:00:00.000Z' }));
    const insertActual = `INSERT INTO budget_actuals (id, reservation_id, project, provider, provider_account, generation_id, model, micro_usd, cost_field, tokens_json, flag, created_at)
      VALUES (?, ?, 'test', 'openrouter', ?, 'gen-x', 'liquid/d1.2-ultra', ?, 'usage', ?, NULL, '2026-11-23T01:00:01.000Z')`;
    await db.prepare(insertActual).bind('act-a', 'res-a', 'acct-a', 10, '{"prompt":10,"completion":5,"total":15}').all();
    await db.prepare(insertActual).bind('act-b', 'res-b', 'acct-b', 20, '{"prompt":20,"completion":7,"total":27}').all();

    const report = await readShadowReport(db);
    assert.equal(report.overall.judgments, 1);
    assert.equal(report.overall.usage_matched, 0);
    assert.equal(report.overall.usage_ambiguous, 1);
    assert.equal(report.overall.total_tokens, 0);
  } finally {
    await mf.dispose();
  }
});

test('loader tolerates a missing budget_actuals table', async () => {
  const { mf, db } = await database();
  try {
    await applyMigration(db, '0078_judgments.sql');
    await insertJudgment(db, row({ id: 'jdg-a', gen_id: 'gen-a', cost_micro_usd: 10 }));
    const report = await readShadowReport(db);
    assert.equal(report.overall.judgments, 1);
    assert.equal(report.overall.usage_matched, 0);
    assert.equal(report.overall.usage_coverage, 0);
  } finally {
    await mf.dispose();
  }
});

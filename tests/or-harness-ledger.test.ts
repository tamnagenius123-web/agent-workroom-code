import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LedgerError, openLedger, type Ledger, type PricingSnapshot, type ReserveResult, type SettleInput } from '../src/or-harness/ledger.ts';

const roster = JSON.parse(readFileSync(fileURLToPath(new URL('../config/models.openrouter.json', import.meta.url)), 'utf8')) as {
  project_defaults: { test: { cap_usd: number } };
};
const TEST_CAP = Math.round(roster.project_defaults.test.cap_usd * 1_000_000);
const MODEL = 'deepseek/deepseek-v4.1-flash';

function snapshot(est: number): PricingSnapshot {
  return {
    model: MODEL,
    captured_at: '2026-10-24T00:00:00.000Z',
    est_micro_usd: est,
    unit_prices: { prompt: '0.0000003', completion: '0.0000012' },
  };
}

function reserveInput(attemptId: string, est: number, runId = 'run-1') {
  return {
    project: 'test',
    run_id: runId,
    attempt_id: attemptId,
    model: MODEL,
    est_micro_usd: est,
    pricing_snapshot: snapshot(est),
  };
}

function settleInput(generationId: string, microUsd: number, costField: SettleInput['cost_field'] = 'total_cost'): SettleInput {
  return {
    generation_id: generationId,
    micro_usd: microUsd,
    cost_field: costField,
    provider_account: 'acct-1',
    model: MODEL,
    tokens: { completion: 20, prompt: 100, total: 120 },
  };
}

async function withLedger(fn: (ledger: Ledger, path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'or-ledger-'));
  const path = join(dir, 'or-ledger.json');
  try {
    await fn(openLedger(path), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function mustReserve(ledger: Ledger, attemptId: string, est: number, runId = 'run-1'): Promise<string> {
  const result = await ledger.reserve(reserveInput(attemptId, est, runId));
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('unreachable');
  return result.reservation_id;
}

interface StoredRow {
  kind: string;
  state?: string;
  micro_usd?: number;
  generation_id?: string;
  evidence?: string | null;
  attempt_id?: string;
  provider?: string;
}

function readRows(path: string): StoredRow[] {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { rows: StoredRow[] };
  for (const row of doc.rows) {
    assert.equal(Number.isSafeInteger(row.micro_usd), true);
    assert.equal(JSON.stringify(row).includes('OPENROUTER_API_KEY'), false);
  }
  return doc.rows;
}

test('project cap is the roster cap_usd converted to micro_usd', () => {
  assert.equal(roster.project_defaults.test.cap_usd, 3);
  assert.equal(TEST_CAP, 3_000_000);
});

test('over-budget reserve is denied and writes no hold', async () => {
  await withLedger(async (ledger, path) => {
    const first = await mustReserve(ledger, 'over-1', 2_000_000);
    assert.equal(first.startsWith('res_'), true);
    const denied = await ledger.reserve(reserveInput('over-2', 1_000_001));
    assert.deepEqual(denied, { ok: false, reason: 'over_budget', remaining: 1_000_000 });
    const exact = await ledger.reserve(reserveInput('over-3', 1_000_000));
    assert.equal(exact.ok, true);
    const past = await ledger.reserve(reserveInput('over-4', 1));
    assert.deepEqual(past, { ok: false, reason: 'over_budget', remaining: 0 });
    const summary = await ledger.summary('test');
    assert.deepEqual(summary, { cap: TEST_CAP, spent: 0, held: TEST_CAP, remaining: 0 });
    const rows = readRows(path);
    assert.equal(rows.length, 2);
    assert.equal(existsSync(`${path}.lock`), false);
  });
});

test('the same attempt_id returns the existing reservation', async () => {
  await withLedger(async (ledger, path) => {
    const first = await ledger.reserve(reserveInput('same-attempt', 1_500_000));
    const second = await ledger.reserve({ ...reserveInput('same-attempt', 2_500_000), run_id: 'run-other' });
    assert.equal(first.ok, true);
    assert.deepEqual(second, first);
    const summary = await ledger.summary('test');
    assert.equal(summary.held, 1_500_000);
    assert.equal(readRows(path).length, 1);

    const burst = await Promise.all(Array.from({ length: 6 }, () => ledger.reserve(reserveInput('burst-attempt', 400_000, 'run-burst'))));
    const ids = new Set(burst.map(result => result.ok ? result.reservation_id : ''));
    assert.equal(ids.size, 1);
    assert.equal((await ledger.summary('test')).held, 1_900_000);
  });
});

test('settle dedupes the same generation and rejects a changed payload', async () => {
  await withLedger(async (ledger, path) => {
    const reservationId = await mustReserve(ledger, 'settle-1', 1_000_000);
    const payload = settleInput('gen-1', 800_000);
    await assert.rejects(
      () => ledger.settle(reservationId, { ...payload, generation_id: '' }),
      (err: unknown) => err instanceof LedgerError && err.code === 'missing_generation_id',
    );
    await assert.rejects(
      () => ledger.settle(reservationId, { ...payload, generation_id: '   ' }),
      (err: unknown) => err instanceof LedgerError && err.code === 'missing_generation_id',
    );
    assert.equal((await ledger.summary('test')).held, 1_000_000);
    assert.equal(readRows(path).some(row => row.kind === 'actual'), false);

    await ledger.settle(reservationId, payload);
    await ledger.settle(reservationId, { ...payload, tokens: { prompt: 100, completion: 20, total: 120 } });
    const settledRows = readRows(path);
    const firstActuals = settledRows.filter(row => row.kind === 'actual');
    assert.equal(firstActuals.length, 1);
    assert.equal(firstActuals[0]?.generation_id, 'gen-1');
    assert.equal(firstActuals[0]?.micro_usd, 800_000);
    assert.equal(settledRows.find(row => row.kind === 'reservation')?.state, 'settled');
    await assert.rejects(
      () => ledger.settle(reservationId, { ...payload, micro_usd: 800_001 }),
      (err: unknown) => err instanceof LedgerError && err.code === 'settle_conflict',
    );
    await assert.rejects(
      () => ledger.settle(reservationId, { ...payload, cost_field: 'usage' }),
      (err: unknown) => err instanceof LedgerError && err.code === 'settle_conflict',
    );
    await assert.rejects(
      () => ledger.settle(reservationId, settleInput('gen-2', 10)),
      (err: unknown) => err instanceof LedgerError && err.code === 'settle_conflict',
    );

    const other = await mustReserve(ledger, 'settle-2', 500_000, 'run-1');
    await ledger.settle(other, settleInput('gen-2', 125_000, 'usage'));
    const summary = await ledger.summary('test');
    assert.deepEqual(summary, { cap: TEST_CAP, spent: 925_000, held: 0, remaining: TEST_CAP - 925_000 });
    const actuals = readRows(path).filter(row => row.kind === 'actual');
    assert.equal(actuals.length, 2);
    assert.deepEqual(actuals.map(row => row.generation_id).sort(), ['gen-1', 'gen-2']);
    assert.equal(existsSync(`${path}.lock`), false);
  });
});

test('timeout keeps the hold counted and does not write a zero actual', async () => {
  await withLedger(async (ledger, path) => {
    const reservationId = await mustReserve(ledger, 'timeout-1', TEST_CAP);
    const pending: unknown = await ledger.markPending(reservationId, 'timeout');
    assert.equal(pending, 'pending_actual');
    assert.equal(await ledger.markPending(reservationId, 'timeout') as unknown, 'pending_actual');
    const denied = await ledger.reserve(reserveInput('timeout-2', 1));
    const deniedShape: ReserveResult = { ok: false, reason: 'over_budget', remaining: 0 };
    assert.deepEqual(denied, deniedShape);
    const summary = await ledger.summary('test');
    assert.deepEqual(summary, { cap: TEST_CAP, spent: 0, held: TEST_CAP, remaining: 0 });
    const rows = readRows(path);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind, 'reservation');
    assert.equal(rows[0]?.state, 'pending_actual');
    assert.equal(rows[0]?.micro_usd, TEST_CAP);
    assert.equal(rows[0]?.generation_id, null);
    assert.equal(rows.some(row => row.kind === 'actual'), false);
  });
});

test('concurrent reserves share one lock and never exceed the cap', async () => {
  await withLedger(async (ledger, path) => {
    const est = 1_000_000;
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => ledger.reserve(reserveInput(`concurrent-${index}`, est, 'run-concurrent'))));
    const admitted = results.filter((result): result is { ok: true; reservation_id: string } => result.ok);
    const denied = results.filter((result): result is { ok: false; reason: 'over_budget'; remaining: number } => !result.ok);
    assert.equal(admitted.length, 3);
    assert.equal(denied.length, 5);
    assert.equal(new Set(admitted.map(result => result.reservation_id)).size, 3);
    for (const result of denied) {
      assert.equal(result.reason, 'over_budget');
      assert.ok(result.remaining < est);
      assert.ok(result.remaining >= 0);
    }
    const summary = await ledger.summary('test');
    assert.deepEqual(summary, { cap: TEST_CAP, spent: 0, held: TEST_CAP, remaining: 0 });
    assert.ok(summary.held <= summary.cap);
    const rows = readRows(path);
    assert.equal(rows.length, 3);
    assert.equal(rows.reduce((sum, row) => sum + (row.micro_usd ?? 0), 0), TEST_CAP);
    assert.equal(existsSync(`${path}.lock`), false);
  });
});

test('closeNoCharge requires evidence and then drops the hold', async () => {
  await withLedger(async (ledger, path) => {
    const reservationId = await mustReserve(ledger, 'close-1', TEST_CAP);
    await assert.rejects(
      () => ledger.closeNoCharge(reservationId, ''),
      (err: unknown) => err instanceof LedgerError && err.code === 'evidence_required',
    );
    await assert.rejects(
      () => ledger.closeNoCharge(reservationId, ' \n\t'),
      (err: unknown) => err instanceof LedgerError && err.code === 'evidence_required',
    );
    assert.equal((await ledger.summary('test')).held, TEST_CAP);
    const evidence = 'attempt was undispatched; provider issued no generation id';
    assert.equal(await ledger.closeNoCharge(reservationId, evidence), 'closed_no_charge');
    assert.equal(await ledger.closeNoCharge(reservationId, evidence), 'closed_no_charge');
    const summary = await ledger.summary('test');
    assert.deepEqual(summary, { cap: TEST_CAP, spent: 0, held: 0, remaining: TEST_CAP });
    const rows = readRows(path);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.state, 'closed_no_charge');
    assert.equal(rows[0]?.evidence, evidence);
    assert.equal(rows[0]?.micro_usd, TEST_CAP);
    const reused = await ledger.reserve(reserveInput('close-2', TEST_CAP));
    assert.equal(reused.ok, true);
    assert.equal((await ledger.summary('test')).held, TEST_CAP);
  });
});

test('markPending stores generation_id so a later settle can find the hold', async () => {
  await withLedger(async (ledger, path) => {
    const reservationId = await mustReserve(ledger, 'late-cost', 250_000);
    await assert.rejects(
      () => ledger.markPending(reservationId, 'cost_unknown', { generation_id: '   ' }),
      (err: unknown) => err instanceof LedgerError && err.code === 'invalid_argument',
    );
    assert.equal((await ledger.summary('test')).held, 250_000);
    assert.equal(readRows(path)[0]?.generation_id ?? null, null);

    const pending: unknown = await ledger.markPending(reservationId, 'cost_unknown', {
      generation_id: 'gen-late',
      provider_account: 'Infermatic',
      model: 'observed/model',
    });
    assert.equal(pending, 'pending_actual');
    assert.equal(await ledger.markPending(reservationId, 'cost_unknown', {
      generation_id: 'gen-late',
      provider_account: 'Infermatic',
      model: 'observed/model',
    }) as unknown, 'pending_actual');
    await assert.rejects(
      () => ledger.markPending(reservationId, 'cost_unknown', { generation_id: 'gen-other' }),
      (err: unknown) => err instanceof LedgerError && err.code === 'invalid_state',
    );

    const rows = readRows(path);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.state, 'pending_actual');
    assert.equal(rows[0]?.generation_id, 'gen-late');
    assert.equal(rows[0]?.micro_usd, 250_000);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as {
      rows: Array<{ provider_account?: string | null; model?: string; provider_plan?: string }>;
    };
    assert.equal(stored.rows[0]?.provider_account, 'Infermatic');
    assert.equal(stored.rows[0]?.model, 'observed/model');
    assert.equal(stored.rows[0]?.provider_plan, 'observed/model');
    assert.equal((await ledger.summary('test')).held, 250_000);
    assert.equal(rows.some(row => row.kind === 'actual'), false);

    const bareId = await mustReserve(ledger, 'no-gen', 10_000);
    await ledger.markPending(bareId, 'timeout');
    const listed = await ledger.listPendingWithGeneration();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.reservation_id, reservationId);
    assert.equal(listed[0]?.generation_id, 'gen-late');
    assert.equal(listed[0]?.provider_account, 'Infermatic');
    assert.equal(listed[0]?.model, 'observed/model');
    assert.equal(listed[0]?.project, 'test');
    assert.equal(listed[0]?.state, 'pending_actual');
    assert.equal(listed[0]?.pending_reason, 'cost_unknown');

    const doc = JSON.parse(readFileSync(path, 'utf8')) as { rows: Array<{ reservation_id?: string; state?: string }> };
    const late = doc.rows.find(row => row.reservation_id === reservationId);
    if (!late) throw new Error('missing hold');
    late.state = 'unknown';
    writeFileSync(path, JSON.stringify(doc));
    assert.equal((await ledger.summary('test')).held, 260_000);
    const unknownListed = await ledger.listPendingWithGeneration();
    assert.equal(unknownListed.length, 1);
    assert.equal(unknownListed[0]?.state, 'unknown');
    assert.equal(unknownListed[0]?.generation_id, 'gen-late');

    await ledger.settle(reservationId, settleInput('gen-late', 40_000));
    const summary = await ledger.summary('test');
    assert.equal(summary.spent, 40_000);
    assert.equal(summary.held, 10_000);
    assert.equal((await ledger.listPendingWithGeneration()).length, 0);
    const actuals = readRows(path).filter(row => row.kind === 'actual');
    assert.equal(actuals.length, 1);
    assert.equal(actuals[0]?.generation_id, 'gen-late');
  });
});

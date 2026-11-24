import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { dispatch, sendReservedChat, type ReserveInput, type SettleInput } from '../src/or-harness/client.ts';
import type { Database } from '../src/server/db.ts';
import { openD1Ledger } from '../src/server/dispatch-wire.ts';

const MODEL = 'z-ai/glm-5.3-flash';
async function fixture() {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null) } }', compatibilityDate: '2026-07-28', d1Databases: ['DB'], cf: false });
  const db = await mf.getD1Database('DB') as unknown as Database;
  const sql = await readFile('migrations/0028_budget_ledger.sql', 'utf8');
  await db.batch(sql.split(';').filter(s => s.trim()).map(s => db.prepare(s)));
  return { db, close: () => mf.dispose() };
}
function reserve(attempt = 'attempt-1', extra: Partial<ReserveInput> = {}): ReserveInput {
  return { project: 'alpha', run_id: 'run-1', attempt_id: attempt, model: MODEL, est_micro_usd: 100,
    pricing_snapshot: { model: MODEL, snapshot_utc: '2026-11-24T00:00:00Z', source: 'fixture', price_usd_per_token: { prompt: '0.1', completion: '0.2' }, prompt_chars: 5, prompt_tokens_est: 18, max_tokens: 10, estimate_micro_usd: 10, reserved_micro_usd: 100 }, ...extra };
}
function actual(extra: Partial<SettleInput> = {}): SettleInput {
  return { generation_id: 'gen-1', provider_account: 'fixture-provider', model: MODEL, micro_usd: 21, cost_field: 'total_cost', tokens: { prompt: 5, completion: 4, total: 9, reasoning: 2, content: 2 }, ...extra };
}
async function id(book: ReturnType<typeof openD1Ledger>, input = reserve()) {
  const row = await book.reserve(input);
  assert.equal(row.ok, true);
  if (!row.ok) throw new Error('reservation denied');
  return row.reservation_id;
}
async function state(db: Database) {
  return { reservations: (await db.prepare('SELECT * FROM budget_reservations ORDER BY reservation_id').all<Record<string, unknown>>()).results,
    actuals: (await db.prepare('SELECT * FROM budget_actuals ORDER BY id').all<Record<string, unknown>>()).results };
}

test('attempt replay binds principal, run, project, model, estimate and the full price card', async t => {
  const f = await fixture(); t.after(f.close);
  const book = openD1Ledger(f.db, 'agent:alpha', 1000);
  const first = await id(book);
  assert.equal(await id(book), first);
  const before = await state(f.db);
  await assert.rejects(async () => id(openD1Ledger(f.db, 'agent:beta', 1000)));
  for (const change of [{ run_id: 'other' }, { project: 'other' }, { model: 'other/model' }, { est_micro_usd: 99 }, { pricing_snapshot: { ...reserve().pricing_snapshot, source: 'changed' } }]) {
    await assert.rejects(async () => id(book, reserve('attempt-1', change)));
  }
  assert.deepEqual(await state(f.db), before);
});

test('pending generation, account and served model become immutable and owner scoped', async t => {
  const f = await fixture(); t.after(f.close);
  const book = openD1Ledger(f.db, 'agent:alpha', 1000);
  const reservation = await id(book);
  await book.markPending(reservation, 'cost_unknown', { generation_id: 'gen-1', provider_account: 'fixture-provider', model: MODEL });
  const before = await state(f.db);
  await assert.rejects(async () => openD1Ledger(f.db, 'agent:beta', 1000).markPending(reservation, 'changed'));
  for (const changed of [{ generation_id: 'gen-other' }, { provider_account: 'other-account' }, { model: 'other/model' }]) {
    await assert.rejects(async () => book.markPending(reservation, 'changed', { generation_id: 'gen-1', provider_account: 'fixture-provider', model: MODEL, ...changed }));
  }
  assert.deepEqual(await state(f.db), before);
});

test('settlement refuses bound receipt mismatches before any durable write', async t => {
  const f = await fixture(); t.after(f.close);
  const book = openD1Ledger(f.db, 'agent:alpha', 1000);
  const reservation = await id(book);
  await book.markPending(reservation, 'cost_unknown', { generation_id: 'gen-1', provider_account: 'fixture-provider', model: MODEL });
  const before = await state(f.db);
  await assert.rejects(async () => openD1Ledger(f.db, 'agent:beta', 1000).settle(reservation, actual()));
  for (const changed of [{ generation_id: 'gen-other' }, { provider_account: 'other-account' }, { model: 'other/model' }]) {
    await assert.rejects(async () => book.settle(reservation, actual(changed)));
  }
  assert.deepEqual(await state(f.db), before);
  await book.settle(reservation, actual());
  assert.equal((await state(f.db)).actuals.length, 1);
});

test('settlement replay compares complete usage payload and remains exactly once', async t => {
  const f = await fixture(); t.after(f.close);
  const book = openD1Ledger(f.db, 'agent:alpha', 1000);
  const reservation = await id(book);
  await book.settle(reservation, actual());
  await book.settle(reservation, actual({ tokens: { content: 2, reasoning: 2, total: 9, completion: 4, prompt: 5 } }));
  const before = await state(f.db);
  for (const changed of [actual({ micro_usd: 22 }), actual({ tokens: { prompt: 5, completion: 4, total: 9, reasoning: 3, content: 1 } }), actual({ tokens: { prompt: -1, completion: 4, total: 9 } })]) {
    await assert.rejects(async () => book.settle(reservation, changed));
  }
  assert.deepEqual(await state(f.db), before);
});

test('admission keeps the adopted wallet-wide cap under concurrent projects', async t => {
  const f = await fixture(); t.after(f.close);
  const book = openD1Ledger(f.db, 'agent:alpha', 100);
  const results = await Promise.all(Array.from({ length: 8 }, (_, n) => book.reserve(reserve('attempt-' + n, { project: 'project-' + n }))));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.deepEqual(await book.summary('any-project'), { cap: 100, spent: 0, held: 100, remaining: 0 });
  const winner = results.find(r => r.ok);
  assert.ok(winner?.ok);
  await book.settle(winner.reservation_id, actual({ micro_usd: 130 }));
  assert.deepEqual(await book.summary('different-project'), { cap: 100, spent: 130, held: 0, remaining: -30 });
  assert.equal((await state(f.db)).actuals[0]?.flag, 'over_budget');
});

test('a generation-only checkpoint pins the id before a canonical served model is known', async t => {
  const f = await fixture(); t.after(f.close);
  const book = openD1Ledger(f.db, 'agent:alpha', 1000);
  const reservation = await id(book);
  await book.markPending(reservation, 'generation_received', { generation_id: 'gen-1' });
  const pending = await book.listPendingWithGeneration();
  assert.equal(pending[0]?.model, MODEL);
  assert.equal((await openD1Ledger(f.db, 'agent:beta', 1000).listPendingWithGeneration()).length, 0);
  const served = actual({ model: MODEL + '-20260826' });
  await book.settle(reservation, served);
  await book.settle(reservation, served);
  await assert.rejects(async () => book.settle(reservation, actual()));
  assert.equal((await state(f.db)).actuals[0]?.model, served.model);
  assert.equal(await id(book), reservation, 'original request identity remains replayable');
});

test('concurrent client attempts and a lost provider response cause at most one chat POST', async t => {
  const f = await fixture(); t.after(f.close);
  const book = openD1Ledger(f.db, 'agent:alpha', 1000);
  let posts = 0;
  const input = { model: MODEL, project: 'alpha', run_id: 'run-concurrent', attempt_id: 'attempt-concurrent', prompt: 'hello', maxTokens: 10,
    ledger: book, apiKey: 'fixture-key', costRetries: 1, costDelayMs: 0,
    fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') { posts++; throw new Error('accepted remotely; response lost'); }
      throw new Error('no generation id to reconcile');
    } };
  const reports = await Promise.all([dispatch(input), dispatch(input)]);
  assert.equal(posts, 1);
  assert.deepEqual(reports.map(r => r.state).sort(), ['pending_actual', 'replay']);
  assert.equal((await dispatch(input)).state, 'replay');
  assert.equal(posts, 1);
  assert.equal((await state(f.db)).actuals.length, 0);
  assert.ok((await book.summary('alpha') as { held: number }).held > 0);
});

test('reserved chat verifies all bindings before network and supports an unknown start fence', async t => {
  const f = await fixture(); t.after(f.close);
  const book = openD1Ledger(f.db, 'agent:alpha', 1000);
  const reservation = await id(book);
  await f.db.prepare("UPDATE budget_reservations SET state='unknown' WHERE reservation_id=?").bind(reservation).all();
  let posts = 0;
  const input = { model: MODEL, prompt: 'hello', maxTokens: 10, timeoutMs: 1000, apiKey: 'fixture-key', ledger: book,
    reservation: { reservation_id: reservation, project: 'alpha', run_id: 'run-1', attempt_id: 'attempt-1', model: MODEL },
    fetchImpl: async () => { posts++; return Response.json({ id: 'gen-verified', choices: [{ message: { content: 'ok' } }] }); } };
  await assert.rejects(async () => sendReservedChat({ ...input, reservation: { ...input.reservation, attempt_id: 'wrong' } }));
  await assert.rejects(async () => sendReservedChat({ ...input, ledger: openD1Ledger(f.db, 'agent:beta', 1000) }));
  await assert.rejects(async () => sendReservedChat({ ...input, maxTokens: 11 }));
  await assert.rejects(async () => sendReservedChat({ ...input, prompt: 'longer prompt than the reserved estimate' }));
  await assert.rejects(async () => sendReservedChat({ ...input, maxTokens: Number.NaN }));
  assert.equal(posts, 0);
  assert.equal((await sendReservedChat(input)).generation_id, 'gen-verified');
  assert.equal(posts, 1);
});

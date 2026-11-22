import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../scripts/local-harness.ts';
import { estimateMicroUsd, loadRoster, reservationMicroUsd, type SettleInput } from '../src/or-harness/client.ts';
import { LIVE_MAX_HOLD_MICRO_USD, LIVE_MAX_PROMPT_CHARS, LIVE_MAX_TOKENS, LIVE_MODEL, VERIFIER, settleAgain, superviseRun } from '../src/server/run-supervisor.ts';
import type { Database } from '../src/server/db.ts';

const CHAT = 'https://openrouter.ai/api/v1/chat/completions';
const GENERATION = 'https://openrouter.ai/api/v1/generation';
const KEY = 'test-openrouter-key';
const PRINCIPAL = 'synthetic:alpha';

let generation = 0;
function mockFetch(mode: 'ok' | 'lost'): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    if (mode === 'lost') throw new Error('socket closed');
    const id = new URL(url).searchParams.get('id') ?? 'gen-' + (++generation);
    if (method === 'POST' && url === CHAT) {
      return Response.json({ id, choices: [{ message: { content: 'hello from model' } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
    }
    if (method === 'GET' && url.startsWith(GENERATION)) {
      return Response.json({ data: { id, total_cost: 0.000021, tokens_prompt: 4, tokens_completion: 2, provider_name: 'mock', model: LIVE_MODEL } });
    }
    throw new Error('unexpected ' + method + ' ' + url);
  };
}

async function seed(db: Database, taskId: string, epoch: number) {
  const now = Date.now();
  await db.prepare(`INSERT INTO tasks(id,room_id,creator_id,owner_id,spec_json,state,version,current_submission_id,cancel_reason,created_at_ms,updated_at_ms)
    VALUES (?,?,?,NULL,?,'in_progress',2,NULL,NULL,?,?)`).bind(taskId, 'room_main', PRINCIPAL, JSON.stringify({ goal: 'one job' }), now, now).all();
  await db.prepare('INSERT INTO task_leases(task_id,holder_id,lease_epoch,expires_at_ms) VALUES (?,?,?,?)').bind(taskId, PRINCIPAL, epoch, now + 60_000).all();
  await db.prepare('INSERT INTO execution_cancels(task_id,generation) VALUES (?,0)').bind(taskId).all();
}

async function base(db: Database) {
  await db.prepare(`INSERT INTO owner_directives(id,room_id,actor_id,text,message_id,idempotency_key,request_hash,created_at)
    VALUES ('dir_g1','room_main','user:minsung','north',NULL,'intent-key-g1','hash-g1','2026-11-22T00:00:00.000Z')`).all();
  await db.prepare(`INSERT INTO intent_versions(version,north_star,intent_md,parent_version,directive_id,author_principal,content_hash,created_at)
    VALUES (4,'north','do the one job',NULL,'dir_g1','user:minsung','hash-g1','2026-11-22T00:00:00.000Z')`).all();
}

test('the live bound holds at most 225 micro-USD', () => {
  const estimate = estimateMicroUsd(LIVE_MODEL, LIVE_MAX_PROMPT_CHARS, LIVE_MAX_TOKENS, loadRoster());
  assert.equal(reservationMicroUsd(estimate), LIVE_MAX_HOLD_MICRO_USD);
});

test('one mock attempt keeps the same ids, and the counterexamples stay visible', async () => {
  const app = await harness({ through: 81, seed: true });
  try {
    const db = app.db;
    await base(db);
    await seed(db, 'task_ok', 3);
    await seed(db, 'task_lost', 3);
    await seed(db, 'task_cancel', 3);
    await seed(db, 'task_cap', 3);
    await seed(db, 'task_stale', 5);
    const common = {
      project: 'g1', principal: PRINCIPAL, lease_epoch: 3, intent_revision: 4, cancel_generation: 0,
      model: LIVE_MODEL, prompt: 'Reply with hello', max_tokens: LIVE_MAX_TOKENS, api_key: KEY, cap_micro_usd: 3_000_000,
    };
    const happy = await superviseRun(db, {
      ...common, task_id: 'task_ok', run_id: 'run-ok', attempt_id: 'run-ok-a1', fetch: mockFetch('ok'),
    });
    assert.equal(happy.disposition, 'PASS');
    assert.equal(happy.failure, null);
    assert.equal(happy.fetches, 2);
    for (const step of ['claim', 'reserve', 'model', 'tool', 'artifact', 'settlement', 'receipt']) {
      const row = happy.trace.find(item => item.step === step);
      assert.ok(row, step);
      assert.equal(row.ok, true, step);
      assert.equal(row.task_id, 'task_ok');
      assert.equal(row.run_id, 'run-ok');
      assert.equal(row.attempt_id, 'run-ok-a1');
      assert.equal(row.lease_epoch, 3);
      assert.equal(row.intent_revision, 4);
    }
    const stored = await db.prepare('SELECT verifier, author_principal, disposition FROM execution_receipts WHERE receipt_id=?')
      .bind(happy.receipt_id).first<{ verifier: string; author_principal: string; disposition: string }>();
    assert.equal(stored?.verifier, VERIFIER);
    assert.equal(stored?.author_principal, PRINCIPAL);
    assert.notEqual(stored?.verifier, stored?.author_principal);
    assert.equal(stored?.disposition, 'PASS');
    const actor = await db.prepare('SELECT actor_id, text FROM messages WHERE id=?').bind(happy.artifact_id).first<{ actor_id: string; text: string }>();
    assert.equal(actor?.actor_id, PRINCIPAL);
    assert.equal(actor?.text.includes(KEY), false);
    const before = await db.prepare('SELECT COUNT(*) AS n, SUM(micro_usd) AS micro FROM budget_actuals').first<{ n: number; micro: number }>();
    const actual: SettleInput = {
      generation_id: happy.generation_id ?? '', micro_usd: 21, cost_field: 'total_cost', provider_account: 'mock', model: LIVE_MODEL,
      tokens: { prompt: 4, completion: 2, total: 6 },
    };
    await settleAgain(db, PRINCIPAL, common.cap_micro_usd, happy.reservation_id ?? '', actual);
    const after = await db.prepare('SELECT COUNT(*) AS n, SUM(micro_usd) AS micro FROM budget_actuals').first<{ n: number; micro: number }>();
    assert.equal(after?.n, before?.n);
    assert.equal(after?.micro, before?.micro);

    const lost = await superviseRun(db, {
      ...common, task_id: 'task_lost', run_id: 'run-lost', attempt_id: 'run-lost-a1', fetch: mockFetch('lost'),
    });
    assert.equal(lost.disposition, 'UNKNOWN');
    assert.equal(lost.failure, 'lost_response');
    assert.equal(lost.fetches, 1);
    assert.equal(lost.artifact_id, null);
    const lostHold = await db.prepare('SELECT state, pending_reason FROM budget_reservations WHERE attempt_id=?')
      .bind('run-lost-a1').first<{ state: string; pending_reason: string }>();
    assert.equal(lostHold?.state, 'pending_actual');
    assert.equal(lostHold?.pending_reason, 'lost_response');

    const canceled = await superviseRun(db, {
      ...common, task_id: 'task_cancel', run_id: 'run-cancel', attempt_id: 'run-cancel-a1', fetch: mockFetch('ok'),
      after: async step => {
        if (step === 'model') await db.prepare('UPDATE execution_cancels SET generation=1 WHERE task_id=?').bind('task_cancel').all();
      },
    });
    assert.equal(canceled.disposition, 'CANCELED');
    assert.equal(canceled.failure, 'cancel_mid_run');
    assert.equal(canceled.artifact_id, null);
    assert.equal(canceled.trace.some(item => item.step === 'artifact' && item.detail === 'not_reached'), true);
    const cancelHold = await db.prepare('SELECT state FROM budget_reservations WHERE attempt_id=?').bind('run-cancel-a1').first<{ state: string }>();
    assert.equal(cancelHold?.state, 'settled');

    const capped = await superviseRun(db, {
      ...common, task_id: 'task_cap', run_id: 'run-cap', attempt_id: 'run-cap-a1', cap_micro_usd: 1, fetch: mockFetch('ok'),
    });
    assert.equal(capped.disposition, 'FAIL');
    assert.equal(capped.failure, 'cap_overflow');
    assert.equal(capped.fetches, 0);
    const capCount = await db.prepare('SELECT COUNT(*) AS n FROM budget_reservations WHERE attempt_id=?').bind('run-cap-a1').first<{ n: number }>();
    assert.equal(capCount?.n, 0);

    const stale = await superviseRun(db, {
      ...common, task_id: 'task_stale', run_id: 'run-stale', attempt_id: 'run-stale-a1', fetch: mockFetch('ok'),
    });
    assert.equal(stale.disposition, 'FAIL');
    assert.equal(stale.failure, 'stale_epoch');
    assert.equal(stale.fetches, 0);
    const staleCount = await db.prepare('SELECT COUNT(*) AS n FROM budget_reservations WHERE attempt_id=?').bind('run-stale-a1').first<{ n: number }>();
    assert.equal(staleCount?.n, 0);
  } finally { await app.close(); }
});

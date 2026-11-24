import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../scripts/local-harness.ts';
import { Workroom } from '../src/server/domain.ts';
import { executionRunRoute } from '../src/server/run-supervisor-route.ts';
import { superviseRun, interruptRun, LIVE_MODEL, type RunInput } from '../src/server/run-supervisor.ts';

test('readback-only reconciliation settles canceled and expired runs without resending or reviving them', async () => {
  const app = await harness({ through: 84 });
  const realFetch = globalThis.fetch;
  try {
    const db = app.db, author = 'synthetic:alpha';
    await db.prepare(`INSERT INTO owner_directives(id,room_id,actor_id,text,message_id,idempotency_key,request_hash,created_at)
      VALUES ('reconcile-directive','room_main','user:minsung','one job',NULL,'reconcile-intent','hash','2026-11-24T00:00:00Z')`).all();
    await db.prepare(`INSERT INTO intent_versions(version,north_star,intent_md,parent_version,directive_id,author_principal,content_hash,created_at)
      VALUES (12,'one job','one job',NULL,'reconcile-directive','user:minsung','hash','2026-11-24T00:00:00Z')`).all();
    let posts = 0, gets = 0;
    const unavailable: RunInput['fetch'] = async (_target, init) => {
      if (init?.method === 'POST') {
        posts++;
        return Response.json({ id: `reconcile-gen-${posts}`, model: LIVE_MODEL,
          choices: [{ message: { content: 'immutable output' } }] });
      }
      return new Response('not ready', { status: 404 });
    };
    for (const mode of ['canceled', 'expired']) {
      const task = `reconcile-${mode}`, run = `run-${task}`;
      await db.prepare(`INSERT INTO tasks(id,room_id,creator_id,spec_json,state,version,created_at_ms,updated_at_ms)
        VALUES (?,'room_main',?,?,'in_progress',2,?,?)`).bind(task, author,
        JSON.stringify({ goal: 'one job', owner: null, dependencies: [], input_versions: [], done_conditions: ['immutable output'] }), Date.now(), Date.now()).all();
      await db.prepare('INSERT INTO task_leases(task_id,holder_id,lease_epoch,expires_at_ms) VALUES (?,?,3,?)')
        .bind(task, author, Date.now() + 120_000).all();
      const first = await superviseRun(db, { project: 'reconciliation', task_id: task, run_id: run, attempt_id: `${run}-a1`,
        principal: author, lease_epoch: 3, intent_revision: 12, cancel_generation: 0,
        model: LIVE_MODEL, prompt: 'one job', max_tokens: 64, api_key: 'fixture', cap_micro_usd: 3_000_000,
        fetch: unavailable, cost_retries: 1, cost_delay_ms: 0,
        after: async step => { if (step === 'model' && mode === 'canceled') await interruptRun(db, { task_id: task, run_id: run, principal: author, reason: 'cancel' }); },
      });
      if (mode === 'expired') await db.prepare('UPDATE task_leases SET expires_at_ms=1 WHERE task_id=?').bind(task).all();
      const immutable = await db.prepare('SELECT * FROM execution_receipts WHERE receipt_id=?').bind(first.receipt_id).first();
      globalThis.fetch = async (target, init) => {
        assert.equal(init?.method ?? 'GET', 'GET');
        gets++;
        const url = new URL(String(target));
        return Response.json({ data: { id: url.searchParams.get('id'), total_cost: 0.000018,
          provider_name: 'fixture', model: LIVE_MODEL, tokens_prompt: 1, tokens_completion: 2 } });
      };
      const url = new URL('https://workroom.invalid/api/v1/rooms/room_main/execution-runs/reconcile');
      const call = (principal = author) => executionRunRoute(new Workroom(db, principal), { OPENROUTER_API_KEY: 'fixture' },
        new Request(url, { method: 'POST' }), url, async () => ({ schema_version: '1', run_id: run }));
      await assert.rejects(call('synthetic:beta'), /author|owner|belong|access|principal/i);
      const result = await call();
      const data = result?.data as { disposition: string; actual_micro_usd: number; chat_posts: number; state: string };
      assert.equal(data.actual_micro_usd, 18);
      assert.equal(data.chat_posts, 0);
      assert.equal(data.disposition, mode === 'canceled' ? 'CANCELED' : 'UNKNOWN');
      assert.notEqual(data.state, 'settled');
      assert.deepEqual(await db.prepare('SELECT * FROM execution_receipts WHERE receipt_id=?').bind(first.receipt_id).first(), immutable);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM budget_actuals WHERE reservation_id=?').bind(first.reservation_id).first<{ n: number }>())?.n, 1);
      const replay = await call();
      assert.equal((replay?.data as { chat_posts: number }).chat_posts, 0);
    }
    assert.equal(posts, 2);
    assert.equal(gets, 2);
  } finally { globalThis.fetch = realFetch; await app.close(); }
});

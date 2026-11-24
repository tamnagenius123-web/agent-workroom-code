import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import type { Database } from '../src/server/db.ts';
import { Workroom } from '../src/server/domain.ts';
import { taskClaimSchema } from '../src/server/task-contracts.ts';
import { LIVE_MODEL, superviseRun, type RunInput } from '../src/server/run-supervisor.ts';

const ROOM = 'room_main', FIRST = 'synthetic:alpha', SECOND = 'synthetic:beta';
let db: Database, mf: Miniflare, cleanup: () => void;
before(async () => {
  const template = await cloneD1(84);
  cleanup = template.cleanup;
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null) } }',
    compatibilityDate: '2026-07-28', d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: template.dir, cf: false });
  db = await mf.getD1Database('DB') as Database;
  await db.batch([
    db.prepare('INSERT INTO rooms(id) VALUES (?)').bind(ROOM),
    ...[FIRST, SECOND, 'user:minsung'].map(principal => db.prepare('INSERT OR IGNORE INTO principals(id) VALUES (?)').bind(principal)),
    ...[FIRST, SECOND].map(principal => db.prepare('INSERT INTO memberships(principal_id,room_id,can_post) VALUES (?,?,1)').bind(principal, ROOM)),
    ...[FIRST, SECOND].map(principal => db.prepare("INSERT INTO principal_roles(principal_id,kind) VALUES (?,'agent')").bind(principal)),
    db.prepare(`INSERT INTO owner_directives(id,room_id,actor_id,text,message_id,idempotency_key,request_hash,created_at)
      VALUES ('cross-host-directive','room_main','user:minsung','Review cross-host recovery',NULL,'cross-host-directive','fixture','2026-11-24T00:00:00.000Z')`),
    db.prepare(`INSERT INTO intent_versions(version,north_star,intent_md,parent_version,directive_id,author_principal,content_hash,created_at)
      VALUES (4,'Review','Review cross-host recovery',NULL,'cross-host-directive','user:minsung','fixture','2026-11-24T00:00:00.000Z')`),
  ]);
});
after(async () => { await mf?.dispose(); cleanup?.(); });

test('a reclaimed task cannot escape another host unresolved provider effect through a new run id', async () => {
  const taskId = 'cross-host-task', firstRun = 'cross-host-first', secondRun = 'cross-host-replacement';
  await db.batch([
    db.prepare(`INSERT INTO tasks(id,room_id,creator_id,owner_id,spec_json,state,version,current_submission_id,cancel_reason,created_at_ms,updated_at_ms)
      VALUES (?,?,?,NULL,?,'in_progress',2,NULL,NULL,?,?)`).bind(taskId, ROOM, FIRST,
      JSON.stringify({ goal: 'Return the requested artifact', owner: null, dependencies: [], input_versions: [],
        done_conditions: ['The requested artifact is present'] }), Date.now(), Date.now()),
    db.prepare('INSERT INTO task_leases(task_id,holder_id,lease_epoch,expires_at_ms) VALUES (?,?,3,?)')
      .bind(taskId, FIRST, Date.now() + 120_000),
  ]);
  const calls = { first: 0, replacement: 0 };
  const input: RunInput = {
    project: 'cross-host', task_id: taskId, run_id: firstRun, attempt_id: 'cross-host-attempt-first', principal: FIRST,
    lease_epoch: 3, intent_revision: 4, cancel_generation: 0, model: LIVE_MODEL,
    prompt: 'Return the requested artifact.', max_tokens: 64, api_key: 'fixture-key',
    cap_micro_usd: 3_000_000, cost_retries: 1, cost_delay_ms: 0,
    fetch: async (_target, init) => {
      assert.equal(init?.method, 'POST');
      calls.first++;
      // The provider might have accepted this request. A lost response is not a free/no-effect result.
      throw new Error('synthetic accepted request with lost response');
    },
  };
  const original = await superviseRun(db, input);
  assert.equal(original.state, 'unknown');
  assert.equal(original.generation_id, null);
  assert.equal(calls.first, 1);
  const originalHold = await db.prepare('SELECT state FROM budget_reservations WHERE reservation_id=?')
    .bind(original.reservation_id).first<{ state: string }>();
  assert.ok(originalHold && ['unknown', 'pending_actual'].includes(originalHold.state));

  // Advance only the test clock's expiry fact. Reclaim itself goes through the real task CAS service.
  await db.prepare('UPDATE task_leases SET expires_at_ms=0 WHERE task_id=?').bind(taskId).all();
  const worker = new Workroom(db, SECOND);
  await worker.tasks.action('claim', taskClaimSchema.parse({ schema_version: '1', room: ROOM, task_id: taskId,
    expected_version: 2, lease_epoch: 3, idempotency_key: 'cross-host-reclaim' }));
  const reclaimed = (await worker.tasks.get({ schema_version: '1', room: ROOM, task_id: taskId })).data;
  assert.equal(reclaimed.lease.holder_id, SECOND);
  assert.equal(reclaimed.lease.lease_epoch, 4);
  assert.equal(reclaimed.lease_active, true);

  const replacement = await superviseRun(db, { ...input, principal: SECOND, run_id: secondRun,
    attempt_id: 'cross-host-attempt-replacement', lease_epoch: reclaimed.lease.lease_epoch,
    fetch: async (target, init) => {
      if (init?.method === 'POST') {
        calls.replacement++;
        return Response.json({ id: 'gen-cross-host-replacement', model: LIVE_MODEL,
          choices: [{ message: { content: 'A replacement artifact.' } }],
          usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } });
      }
      const url = new URL(typeof target === 'string' ? target : target instanceof URL ? target.href : target.url);
      return Response.json({ data: { id: url.searchParams.get('id'), total_cost: 0.000020,
        provider_name: 'fixture', model: LIVE_MODEL, tokens_prompt: 4, tokens_completion: 5 } });
    },
  });
  console.log(JSON.stringify({ case: 'cross-host-unknown', original_state: original.state,
    replacement_state: replacement.state, replacement_disposition: replacement.disposition, calls }));
  assert.equal(calls.replacement, 0, 'a new host/run identity must not resend an unresolved task effect');
  assert.notEqual(replacement.disposition, 'PASS');
  assert.equal(await db.prepare('SELECT reservation_id FROM budget_reservations WHERE run_id=?')
    .bind(secondRun).first(), null, 'recovery refusal happens before reserving a replacement effect');
  assert.deepEqual(await db.prepare('SELECT state FROM execution_runs WHERE run_id=?').bind(firstRun).first(),
    { state: 'unknown' }, 'reclaim must preserve the unresolved original execution evidence');
});

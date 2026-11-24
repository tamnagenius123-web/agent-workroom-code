import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import type { Database, Statement, Value } from '../src/server/db.ts';
import { Workroom } from '../src/server/domain.ts';
import { reconcileRunCost } from '../src/server/execution-cost.ts';
import {
  LIVE_MODEL, getRunStatus, heartbeatRun, resumeRun, superviseRun, type RunInput,
} from '../src/server/run-supervisor.ts';
import {
  freezeRunEvaluation, hashEvaluationEvidence, submitRunEvaluation, type RunEvaluationInput,
} from '../src/server/run-evaluation.ts';

const ROOM = 'room_main', AUTHOR = 'synthetic:alpha', REVIEWER = 'synthetic:beta';
let db: Database, mf: Miniflare, cleanup: () => void;
let serial = 0;
before(async () => {
  const template = await cloneD1(84);
  cleanup = template.cleanup;
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null) } }',
    compatibilityDate: '2026-07-28', d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: template.dir, cf: false });
  db = await mf.getD1Database('DB') as Database;
  await db.batch([
    db.prepare('INSERT INTO rooms(id) VALUES (?)').bind(ROOM),
    ...[AUTHOR, REVIEWER, 'user:minsung'].map(principal => db.prepare('INSERT OR IGNORE INTO principals(id) VALUES (?)').bind(principal)),
    ...[AUTHOR, REVIEWER].map(principal => db.prepare('INSERT INTO memberships(principal_id,room_id,can_post) VALUES (?,?,1)').bind(principal, ROOM)),
    ...[AUTHOR, REVIEWER].map(principal => db.prepare("INSERT INTO principal_roles(principal_id,kind) VALUES (?,'agent')").bind(principal)),
    db.prepare(`INSERT INTO owner_directives(id,room_id,actor_id,text,message_id,idempotency_key,request_hash,created_at)
      VALUES ('adversarial-directive','room_main','user:minsung','Review execution boundaries',NULL,'adversarial-directive','fixture','2026-11-24T00:00:00.000Z')`),
    db.prepare(`INSERT INTO intent_versions(version,north_star,intent_md,parent_version,directive_id,author_principal,content_hash,created_at)
      VALUES (4,'Review','Review execution boundaries',NULL,'adversarial-directive','user:minsung','fixture','2026-11-24T00:00:00.000Z')`),
  ]);
});
after(async () => { await mf?.dispose(); cleanup?.(); });

async function seed() {
  const n = ++serial;
  const task = `adversarial-task-${n}`, run = `adversarial-run-${n}`, attempt = `adversarial-attempt-${n}`;
  const output = `Requested execution artifact ${n}.`;
  await db.batch([
    db.prepare(`INSERT INTO tasks(id,room_id,creator_id,owner_id,spec_json,state,version,current_submission_id,cancel_reason,created_at_ms,updated_at_ms)
      VALUES (?,?,?,NULL,?,'in_progress',2,NULL,NULL,?,?)`).bind(task, ROOM, AUTHOR,
      JSON.stringify({ goal: 'Return the requested artifact', owner: null, dependencies: [], input_versions: [],
        done_conditions: ['The output is the requested artifact'] }), Date.now(), Date.now()),
    db.prepare('INSERT INTO task_leases(task_id,holder_id,lease_epoch,expires_at_ms) VALUES (?,?,3,?)')
      .bind(task, AUTHOR, Date.now() + 120_000),
  ]);
  const calls = { posts: 0, gets: 0 };
  const fetch: RunInput['fetch'] = async (target, init) => {
    if (init?.method === 'POST') {
      calls.posts++;
      return Response.json({ id: `gen-adversarial-${n}`, model: LIVE_MODEL,
        choices: [{ message: { content: output } }],
        usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } });
    }
    calls.gets++;
    const url = new URL(typeof target === 'string' ? target : target instanceof URL ? target.href : target.url);
    return Response.json({ data: { id: url.searchParams.get('id'), total_cost: 0.000020,
      provider_name: 'fixture', model: LIVE_MODEL, tokens_prompt: 4, tokens_completion: 5 } });
  };
  const input: RunInput = {
    project: 'adversarial', task_id: task, run_id: run, attempt_id: attempt, principal: AUTHOR,
    lease_epoch: 3, intent_revision: 4, cancel_generation: 0, model: LIVE_MODEL,
    prompt: 'Return the requested artifact.', max_tokens: 64, api_key: 'fixture-key',
    cap_micro_usd: 3_000_000, fetch, cost_retries: 1, cost_delay_ms: 0,
  };
  return { n, task, run, attempt, output, calls, input };
}

async function completed() {
  const fixture = await seed();
  const report = await superviseRun(db, fixture.input);
  assert.equal(report.disposition, 'PASS', report.failure ?? '');
  assert.equal(fixture.calls.posts, 1);
  return { ...fixture, report };
}

async function evaluate(fixture: Awaited<ReturnType<typeof completed>>) {
  const service = new Workroom(db, REVIEWER);
  const frozen = await freezeRunEvaluation(service, ROOM, fixture.run, `freeze-adversarial-${fixture.n}`);
  const input: RunEvaluationInput = {
    schema_version: '1', manifest_id: frozen.data.id, manifest_digest: frozen.data.result.manifest_digest,
    shards: await Promise.all(frozen.data.result.manifest.expected_shards.map(async shard => {
      const evidence = `Observed artifact: ${fixture.output}`;
      return { condition_id: shard.condition_id, command: 'fixture-artifact-equality', exit_code: 0,
        cases: [{ case_id: `artifact-case-${fixture.n}`, status: 'PASS' as const,
          evidence, evidence_sha256: await hashEvaluationEvidence(evidence) }] };
    })),
  };
  return submitRunEvaluation(service, ROOM, fixture.run, `submit-adversarial-${fixture.n}`, input);
}

test('a settled run without its receipt cannot report PASS', async () => {
  const f = await completed();
  await db.prepare('DELETE FROM execution_receipts WHERE receipt_id=?').bind(f.report.receipt_id).all();
  const view = await getRunStatus(db, f.run);
  assert.notEqual(view?.disposition, 'PASS', 'the state label is not kernel, reviewer or execution receipt evidence');
});

test('a settled run cannot borrow another run receipt', async () => {
  const first = await completed(), second = await completed();
  await db.prepare('UPDATE execution_runs SET receipt_id=? WHERE run_id=?').bind(second.report.receipt_id, first.run).all();
  const view = await getRunStatus(db, first.run);
  assert.notEqual(view?.disposition, 'PASS', 'a receipt ID must bind the current run and attempt');
});

test('actual supervisor settlement evaluates when actual cost differs from the reserved hold', async () => {
  const f = await completed();
  const amounts = await db.prepare(`SELECT b.micro_usd AS reserved,a.micro_usd AS actual
    FROM budget_reservations b JOIN budget_actuals a ON a.reservation_id=b.reservation_id WHERE b.reservation_id=?`)
    .bind(f.report.reservation_id).first<{ reserved: number; actual: number }>();
  assert.ok(amounts);
  assert.notEqual(amounts.reserved, amounts.actual, 'fixture must exercise ordinary estimate-versus-actual settlement');
  const result = await evaluate(f);
  assert.equal(result.data.result.disposition, 'PASS', JSON.stringify(result.data.result.reasons));
  assert.equal(result.data.current_disposition, 'PASS');
});

test('G5 rejects a settled reservation cross-bound to another principal and run', async () => {
  const f = await completed();
  // Fault injection changes stored bindings only; all reads/writes remain actual local D1.
  // Equal actual/hold isolates the ownership defect from the amount defect above.
  await db.batch([
    db.prepare(`UPDATE budget_reservations SET principal_id=?,run_id=?,attempt_id=?,project='foreign-project',micro_usd=20
      WHERE reservation_id=?`).bind(REVIEWER, `foreign-${f.run}`, `foreign-${f.attempt}`, f.report.reservation_id),
    db.prepare("UPDATE budget_actuals SET project='foreign-project' WHERE reservation_id=?").bind(f.report.reservation_id),
  ]);
  const result = await evaluate(f);
  assert.equal(result.data.result.disposition, 'HOLD', 'actual-reservation consistency cannot substitute for execution ownership');
  assert.equal(result.data.current_disposition, 'HOLD');
});

test('an old run heartbeat cannot renew a newly reclaimed task epoch before resume', async () => {
  const f = await seed();
  await assert.rejects(() => superviseRun(db, { ...f.input, after(step) {
    if (step === 'reserve') throw new Error('fixture host stopped before send');
  } }), /fixture host stopped/);
  assert.equal(f.calls.posts, 0);
  // Reclaim by the same authenticated principal is a new task authority epoch.
  await db.batch([
    db.prepare('UPDATE task_leases SET lease_epoch=4,expires_at_ms=? WHERE task_id=?').bind(Date.now() + 120_000, f.task),
    db.prepare('UPDATE tasks SET version=version+1 WHERE id=?').bind(f.task),
  ]);
  const result = await heartbeatRun(db, {
    task_id: f.task, run_id: f.run, attempt_id: f.attempt, principal: AUTHOR,
    lease_epoch: 4, intent_revision: 4, cancel_generation: 0,
  });
  assert.equal(result.alive, false, 'resume must explicitly bind the run to the new epoch first');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM task_audit WHERE target_id=? AND operation='task.renew'")
    .bind(f.task).first<{ n: number }>())?.n, 0);
});

test('G5 accepts a resumed execution while retaining its original billing attempt', async () => {
  const f = await seed();
  await assert.rejects(() => superviseRun(db, { ...f.input, after(step) {
    if (step === 'reserve') throw new Error('fixture stopped after reservation');
  } }), /fixture stopped after reservation/);
  const attempt = `${f.attempt}-resumed`;
  const report = await resumeRun(db, { ...f.input, attempt_id: attempt });
  assert.equal(report.disposition, 'PASS', report.failure ?? '');
  assert.equal(f.calls.posts, 1);
  const attempts = await db.prepare(`SELECT r.attempt_id AS execution_attempt,b.attempt_id AS billing_attempt
    FROM execution_runs r JOIN budget_reservations b ON b.reservation_id=r.reservation_id WHERE r.run_id=?`)
    .bind(f.run).first<{ execution_attempt: string; billing_attempt: string }>();
  assert.deepEqual(attempts, { execution_attempt: attempt, billing_attempt: f.attempt });
  const result = await evaluate({ ...f, report });
  assert.equal(result.data.result.disposition, 'PASS', JSON.stringify(result.data.result.reasons));
});

test('resume after artifact publication binds the new attempt and epoch before final receipt', async () => {
  const f = await seed();
  await assert.rejects(() => superviseRun(db, { ...f.input, after(step) {
    if (step === 'artifact') throw new Error('fixture stopped after artifact');
  } }), /fixture stopped after artifact/);
  const attempt = `${f.attempt}-resumed`;
  await db.batch([
    db.prepare('UPDATE task_leases SET lease_epoch=4,expires_at_ms=? WHERE task_id=?').bind(Date.now() + 120_000, f.task),
    db.prepare('UPDATE tasks SET version=version+1 WHERE id=?').bind(f.task),
  ]);
  const result = await resumeRun(db, { ...f.input, attempt_id: attempt, lease_epoch: 4 });
  assert.equal(result.disposition, 'PASS', result.failure ?? '');
  assert.equal(f.calls.posts, 1);
  const status = await getRunStatus(db, f.run);
  assert.equal(status?.attempt_id, attempt, 'the execution row must advance with the resumed receipt');
  assert.equal(status?.lease_epoch, 4);
  assert.equal(status?.disposition, 'PASS');
});

test('revoking the task-engine agent role before send forbids provider transmission', async () => {
  const f = await seed();
  try {
    const result = await superviseRun(db, { ...f.input, after: async step => {
      if (step === 'reserve') await db.prepare('DELETE FROM principal_roles WHERE principal_id=?').bind(AUTHOR).all();
    } });
    assert.equal(f.calls.posts, 0, 'membership alone does not retain task-engine execution authority');
    assert.equal(result.disposition, 'FAIL');
    assert.equal(result.artifact_id, null);
  } finally {
    await db.prepare("INSERT OR REPLACE INTO principal_roles(principal_id,kind) VALUES (?,'agent')").bind(AUTHOR).all();
  }
});

test('known generation recovers from sending crash through cost readback without resend', async () => {
  const f = await seed();
  let crashed = false;
  const entries = new WeakMap<Statement, { raw: Statement; sql: string; args: Value[] }>();
  const crash = () => { throw new Error('fixture process lost after generation pin'); };
  const wrap = (raw: Statement, sql: string, args: Value[] = []): Statement => {
    const statement: Statement = {
      bind(...values: Value[]) { return wrap(raw.bind(...values), sql, values); },
      first<T>() { if (crashed) return crash(); return raw.first<T>(); },
      all<T>() { if (crashed) return crash(); return raw.all<T>(); },
    };
    entries.set(statement, { raw, sql, args });
    return statement;
  };
  const failingDb: Database = {
    prepare(sql) { return wrap(db.prepare(sql), sql); },
    batch<T>(statements: Statement[]) {
      if (crashed || statements.some(statement => {
        const entry = entries.get(statement);
        return entry && /INSERT INTO execution_runs/.test(entry.sql) && entry.args[13] === 'modeled';
      })) { crashed = true; return crash(); }
      return db.batch<T>(statements.map(statement => entries.get(statement)?.raw ?? statement));
    },
  };
  await assert.rejects(() => superviseRun(failingDb, f.input), /fixture process lost after generation pin/);
  const interrupted = await db.prepare(`SELECT r.state,r.generation_id AS run_generation,b.generation_id AS held_generation
    FROM execution_runs r JOIN budget_reservations b ON b.reservation_id=r.reservation_id WHERE r.run_id=?`)
    .bind(f.run).first<{ state: string; run_generation: string | null; held_generation: string | null }>();
  assert.deepEqual(interrupted, { state: 'sending', run_generation: null, held_generation: `gen-adversarial-${f.n}` });
  await db.prepare(`UPDATE unit_leases SET lease_until=0
    WHERE holder=(SELECT holder FROM unit_leases WHERE unit_id=?)`).bind(`execution/run/${encodeURIComponent(f.run)}`).all();
  const input = { run_id: f.run, principal: AUTHOR, api_key: 'fixture-key', cap_micro_usd: 3_000_000,
    fetch: async (target: string | URL | Request, init?: RequestInit) => {
      assert.notEqual(init?.method, 'POST', 'cost reconciliation is a provider readback only');
      return f.input.fetch(target, init);
    } };
  const recovered = await reconcileRunCost(db, input);
  assert.equal(recovered.state, 'unknown', 'a resolved billing fact must not leave an active sending checkpoint');
  assert.equal(recovered.disposition, 'UNKNOWN');
  assert.equal(recovered.reservation_state, 'settled');
  assert.equal(recovered.actual_micro_usd, 20);
  assert.ok(recovered.receipt_id);
  const resumed = await resumeRun(db, f.input);
  assert.equal(resumed.disposition, 'UNKNOWN');
  assert.equal(resumed.fetches, 0);
  assert.equal(f.calls.posts, 1);
  const replay = await reconcileRunCost(db, input);
  assert.equal(replay.fetches, 0);
  assert.equal(replay.receipt_id, recovered.receipt_id);
});

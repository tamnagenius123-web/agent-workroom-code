import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../scripts/local-harness.ts';
import type { Database, Statement, Value } from '../src/server/db.ts';
import { LIVE_MODEL, getRunStatus, heartbeatRun, interruptRun, resumeRun, superviseRun, type RunInput } from '../src/server/run-supervisor.ts';
import { admitExecution, ExecutionFenceLost, fencedDatabase, releaseExecution } from '../src/server/execution-fence.ts';
import { claimUnitLease } from '../src/server/unit-leases.ts';

async function seed(db: Database, task = 'safety-task', principal = 'synthetic:alpha') {
  await db.prepare(`INSERT OR IGNORE INTO owner_directives(id,room_id,actor_id,text,message_id,idempotency_key,request_hash,created_at)
    VALUES ('safety-dir','room_main','user:minsung','north',NULL,'safety-intent','safety-hash','2026-11-24T00:00:00.000Z')`).all();
  await db.prepare(`INSERT OR IGNORE INTO intent_versions(version,north_star,intent_md,parent_version,directive_id,author_principal,content_hash,created_at)
    VALUES (4,'north','one job',NULL,'safety-dir','user:minsung','safety-hash','2026-11-24T00:00:00.000Z')`).all();
  await db.prepare(`INSERT INTO tasks(id,room_id,creator_id,owner_id,spec_json,state,version,current_submission_id,cancel_reason,created_at_ms,updated_at_ms)
    VALUES (?,'room_main',?,NULL,?,'in_progress',2,NULL,NULL,?,?)`).bind(task, principal,
    JSON.stringify({ goal: 'one job', owner: null, dependencies: [], input_versions: [], done_conditions: ['Return the requested text'] }), Date.now(), Date.now()).all();
  await db.prepare('INSERT INTO task_leases(task_id,holder_id,lease_epoch,expires_at_ms) VALUES (?,?,3,?)')
    .bind(task, principal, Date.now() + 120_000).all();
}

function provider() {
  const calls = { posts: 0, gets: 0 };
  const fetch: RunInput['fetch'] = async (target, init) => {
    const url = new URL(typeof target === 'string' ? target : target instanceof URL ? target.href : target.url);
    if (init?.method === 'POST') {
      calls.posts++;
      return Response.json({ id: `gen-safety-${calls.posts}`, model: LIVE_MODEL,
        choices: [{ message: { content: 'The actual requested artifact.' } }],
        usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } });
    }
    calls.gets++;
    return Response.json({ data: { id: url.searchParams.get('id'), total_cost: 0.000020,
      provider_name: 'fixture', model: LIVE_MODEL, tokens_prompt: 4, tokens_completion: 5 } });
  };
  return { calls, fetch };
}

function input(fetch: RunInput['fetch'], task = 'safety-task'): RunInput {
  return { project: 'safety', task_id: task, run_id: `run-${task}`, attempt_id: `attempt-${task}`,
    principal: 'synthetic:alpha', lease_epoch: 3, intent_revision: 4, cancel_generation: 0,
    model: LIVE_MODEL, prompt: 'Return the requested text.', max_tokens: 64,
    api_key: 'fixture-key', cap_micro_usd: 3_000_000, fetch, cost_retries: 1, cost_delay_ms: 0 };
}

/** Change scheduling only: all statements still execute against the actual local D1. */
function interleaveInitialRunReads(db: Database): Database {
  let reads = 0;
  let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  const raw = new WeakMap<Statement, Statement>();
  const wrap = (statement: Statement, sql: string): Statement => {
    const wrapped: Statement = {
      bind(...args: Value[]) { return wrap(statement.bind(...args), sql); },
      async first<T>() {
        const row = await statement.first<T>();
        if (/FROM execution_runs WHERE run_id=\?/.test(sql) && reads < 2) {
          if (++reads === 2) release();
          await both;
        }
        return row;
      },
      all<T>() { return statement.all<T>(); },
    };
    raw.set(wrapped, statement);
    return wrapped;
  };
  return { prepare(sql) { return wrap(db.prepare(sql), sql); }, batch<T>(statements: Statement[]) {
    return db.batch<T>(statements.map(statement => raw.get(statement) ?? statement));
  } };
}

test('simultaneous initial reads cannot issue two model POSTs for one run', { timeout: 30_000 }, async () => {
  const app = await harness({ through: 84 });
  try {
    await seed(app.db);
    const mock = provider();
    const db = interleaveInitialRunReads(app.db);
    const results = await Promise.allSettled([superviseRun(db, input(mock.fetch)), superviseRun(db, input(mock.fetch))]);
    assert.equal(mock.calls.posts, 1, JSON.stringify(results));
    assert.equal((await app.db.prepare('SELECT COUNT(*) AS n FROM budget_reservations').first<{ n: number }>())?.n, 1);
    assert.equal((await app.db.prepare('SELECT COUNT(*) AS n FROM budget_actuals').first<{ n: number }>())?.n, 1);
  } finally { await app.close(); }
});

test('a historical run id never replays a PASS for another principal or changed prompt', async () => {
  const app = await harness({ through: 84 });
  try {
    await seed(app.db);
    const mock = provider();
    await superviseRun(app.db, input(mock.fetch));
    const other = await superviseRun(app.db, { ...input(mock.fetch), principal: 'synthetic:beta' });
    assert.equal(other.disposition, 'FAIL');
    assert.equal(other.failure, 'principal_mismatch');
    const changed = await superviseRun(app.db, { ...input(mock.fetch), prompt: 'Different requested artifact.' });
    assert.equal(changed.disposition, 'FAIL');
    assert.equal(changed.failure, 'context_mismatch');
    assert.equal(mock.calls.posts, 1);
  } finally { await app.close(); }
});

test('the stored immutable artifact contains the actual model result', async () => {
  const app = await harness({ through: 84 });
  try {
    await seed(app.db);
    const mock = provider();
    const result = await superviseRun(app.db, input(mock.fetch));
    const artifact = await app.db.prepare('SELECT text FROM messages WHERE id=?').bind(result.artifact_id).first<{ text: string }>();
    assert.equal(artifact?.text, 'The actual requested artifact.');
  } finally { await app.close(); }
});

test('a different room writer cannot interrupt the task owner execution', async () => {
  const app = await harness({ through: 84 });
  try {
    await seed(app.db);
    const result = await interruptRun(app.db, { task_id: 'safety-task', principal: 'synthetic:beta', reason: 'unrelated writer' });
    assert.equal(result.ok, false);
    assert.equal(result.failure, 'forbidden');
    assert.equal((await app.db.prepare('SELECT generation FROM execution_cancels WHERE task_id=?').bind('safety-task').first<{ generation: number }>())?.generation ?? 0, 0);
  } finally { await app.close(); }
});

test('an accepted send followed by unavailable persistence stays unknown after restart', async () => {
  const app = await harness({ through: 84 });
  try {
    await seed(app.db);
    const mock = provider();
    let failed = false;
    const raws = new WeakMap<Statement, Statement>();
    const wrapped = (statement: Statement): Statement => {
      const out: Statement = {
        bind(...args) { return wrapped(statement.bind(...args)); },
        first<T>() { if (failed) throw new Error('simulated process crash'); return statement.first<T>(); },
        all<T>() { if (failed) throw new Error('simulated process crash'); return statement.all<T>(); },
      };
      raws.set(out, statement); return out;
    };
    const crashDb: Database = { prepare(sql) { return wrapped(app.db.prepare(sql)); }, batch<T>(statements: Statement[]) {
      if (failed) throw new Error('simulated process crash');
      return app.db.batch<T>(statements.map(statement => raws.get(statement) ?? statement));
    } };
    const fetch: RunInput['fetch'] = async (target, init) => {
      const response = await mock.fetch(target, init);
      if (init?.method === 'POST') failed = true;
      return response;
    };
    await assert.rejects(() => superviseRun(crashDb, input(fetch)), /simulated process crash/);
    // A dead host does not run cleanup. Simulate authoritative expiry before a new host reclaims.
    await app.db.prepare("UPDATE unit_leases SET lease_until=0 WHERE state='held'").all();
    const resumed = await resumeRun(app.db, input(mock.fetch));
    assert.equal(mock.calls.posts, 1);
    assert.equal(resumed.disposition, 'UNKNOWN');
    assert.equal(resumed.artifact_id, null);
    const hold = await app.db.prepare('SELECT state FROM budget_reservations').first<{ state: string }>();
    assert.ok(['unknown', 'pending_actual'].includes(hold?.state ?? ''));
  } finally { await app.close(); }
});

test('bounded admission, same-holder fencing, and transactional stale-write rejection share D1 authority', async () => {
  const app = await harness({ through: 84 });
  try {
    const params = (n: number) => ({ run_id: `pool-run-${n}`, task_id: `pool-task-${n}`,
      principal: `pool-agent-${n}`, model: LIVE_MODEL, limits: { model_calls: 1, processes: 2, logical_agents: 2 } });
    const first = await admitExecution(app.db, params(1));
    assert.equal(first.admitted, true);
    if (!first.admitted) throw new Error('first admission failed');
    const second = await admitExecution(app.db, params(2));
    assert.deepEqual(second, { admitted: false, reason: 'capacity', plane: 'model_calls' });
    const others = await app.db.prepare("SELECT COUNT(*) AS n FROM unit_leases WHERE state='held' AND holder<>?")
      .bind(first.fence.holder).first<{ n: number }>();
    assert.equal(others?.n, 0, 'failed partial admission releases its acquired resources');
    const before = first.fence.leases[0]!;
    const successor = await claimUnitLease(app.db, before.unit_id, first.fence.holder, Date.now(), 30_000);
    assert.ok(successor.lease && successor.lease.generation > before.generation);
    const stale = fencedDatabase(app.db, first.fence);
    await assert.rejects(() => stale.batch([
      stale.prepare("INSERT INTO execution_cancels(task_id,generation) VALUES ('must-not-write',1)"),
    ]), ExecutionFenceLost);
    assert.equal(await app.db.prepare("SELECT 1 FROM execution_cancels WHERE task_id='must-not-write'").first(), null);
    await releaseExecution(app.db, first.fence);
    assert.equal((await app.db.prepare('SELECT generation,state FROM unit_leases WHERE unit_id=?')
      .bind(before.unit_id).first<{ generation: number; state: string }>())?.state, 'held', 'stale cleanup cannot release successor');
  } finally { await app.close(); }
});

test('late cost cancellation is reported accurately and original UNKNOWN receipt is preserved', async () => {
  const app = await harness({ through: 84 });
  try {
    await seed(app.db);
    const mock = provider();
    const missing: RunInput['fetch'] = (target, init) => init?.method === 'POST'
      ? mock.fetch(target, init) : Promise.resolve(new Response(null, { status: 404 }));
    const before = await superviseRun(app.db, input(missing));
    assert.equal(before.disposition, 'UNKNOWN');
    const late: RunInput['fetch'] = async (target, init) => {
      assert.notEqual(init?.method, 'POST');
      await interruptRun(app.db, { task_id: 'safety-task', principal: 'synthetic:alpha', reason: 'cancel during cost readback' });
      return mock.fetch(target, init);
    };
    const after = await resumeRun(app.db, input(late));
    assert.equal(after.disposition, 'CANCELED');
    assert.equal(after.state, 'canceled');
    assert.equal((await getRunStatus(app.db, 'run-safety-task'))?.disposition, after.disposition);
    assert.equal((await app.db.prepare('SELECT disposition FROM execution_receipts WHERE receipt_id=?')
      .bind(before.receipt_id).first<{ disposition: string }>())?.disposition, 'UNKNOWN');
    assert.equal(mock.calls.posts, 1);
    assert.equal((await app.db.prepare('SELECT state FROM budget_reservations').first<{ state: string }>())?.state, 'settled');
  } finally { await app.close(); }
});

test('active heartbeat renews the task engine and rejects a stale execution generation', async () => {
  const app = await harness({ through: 84 });
  try {
    await seed(app.db);
    const mock = provider();
    const result = await superviseRun(app.db, { ...input(mock.fetch), after: async step => {
      if (step !== 'reserve') return;
      const status = await getRunStatus(app.db, 'run-safety-task');
      assert.ok(status?.execution_generation);
      const heartbeat = { task_id: 'safety-task', run_id: 'run-safety-task', attempt_id: 'attempt-safety-task',
        principal: 'synthetic:alpha', lease_epoch: 3, intent_revision: 4, cancel_generation: 0 };
      const missing = await heartbeatRun(app.db, heartbeat);
      assert.equal(missing.alive, false);
      assert.equal(missing.failure, 'execution_generation_mismatch');
      const current = await heartbeatRun(app.db, { ...heartbeat, execution_generation: status!.execution_generation! });
      assert.equal(current.alive, true, current.failure ?? '');
      const stale = await heartbeatRun(app.db, { ...heartbeat, execution_generation: status!.execution_generation! + 1 });
      assert.equal(stale.alive, false);
    } });
    assert.equal(result.disposition, 'PASS', result.failure ?? '');
    assert.ok((await app.db.prepare("SELECT COUNT(*) AS n FROM task_audit WHERE operation='task.renew'").first<{ n: number }>())!.n > 0);
  } finally { await app.close(); }
});

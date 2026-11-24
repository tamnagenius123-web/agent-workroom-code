import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { sha256 } from '../src/auth/crypto.ts';
import { Fault } from '../src/server/contracts.ts';
import { Workroom } from '../src/server/domain.ts';
import type { Database, Statement, Value } from '../src/server/db.ts';
import {
  freezeRunEvaluation, getRunEvaluation, hashEvaluationEvidence, runEvaluationRoute, submitRunEvaluation,
  type RunEvaluationInput,
} from '../src/server/run-evaluation.ts';

const ROOM = 'room_main', AUTHOR = 'synthetic:alpha', REVIEWER = 'synthetic:beta';
let db: Database, mf: Miniflare, cleanup: () => void;
let serial = 0;
before(async () => {
  const template = await cloneD1(82);
  cleanup = template.cleanup;
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null) } }',
    compatibilityDate: '2026-07-28', d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: template.dir, cf: false });
  db = await mf.getD1Database('DB') as Database;
  await db.batch([
    db.prepare('INSERT INTO rooms(id) VALUES (?)').bind(ROOM),
    ...[AUTHOR, REVIEWER, 'synthetic:other', 'user:minsung'].map(principal => db.prepare('INSERT OR IGNORE INTO principals(id) VALUES (?)').bind(principal)),
    ...[AUTHOR, REVIEWER, 'synthetic:other'].map(principal => db.prepare('INSERT INTO memberships(principal_id,room_id,can_post) VALUES (?,?,1)').bind(principal, ROOM)),
    ...[AUTHOR, REVIEWER, 'synthetic:other'].map(principal => db.prepare("INSERT OR IGNORE INTO principal_roles(principal_id,kind) VALUES (?,'agent')").bind(principal)),
    db.prepare(`INSERT INTO owner_directives(id,room_id,actor_id,text,message_id,idempotency_key,request_hash,created_at)
      VALUES ('eval-directive','room_main','user:minsung','Evaluate completed output',NULL,'eval-directive-key','hash','2026-11-24T00:00:00.000Z')`),
    db.prepare(`INSERT INTO intent_versions(version,north_star,intent_md,parent_version,directive_id,author_principal,content_hash,created_at)
      VALUES (17,'Evaluate','Evaluate completed output',NULL,'eval-directive','user:minsung','hash','2026-11-24T00:00:00.000Z')`),
  ]);
});
after(async () => { await mf?.dispose(); cleanup?.(); });

async function seed(options: { conditions?: string[]; artifact?: string; source?: string } = {}) {
  serial += 1;
  const n = serial, run = `eval-run-${n}`, task = `eval-task-${n}`, artifact = `eval-artifact-${n}`;
  const output = `model output ${n}`;
  const spec = JSON.stringify({ goal: 'Complete a bounded task', owner: null, dependencies: [],
    input_versions: options.source ? [{ message_id: options.source, revision: 1 }] : [],
    done_conditions: options.conditions ?? ['Output contains the requested result', 'Output obeys the format contract'] });
  const specDigest = await sha256(spec), toolDigest = await sha256(output);
  await db.batch([
    db.prepare(`INSERT INTO tasks(id,room_id,creator_id,owner_id,spec_json,state,version,current_submission_id,cancel_reason,created_at_ms,updated_at_ms)
      VALUES (?,?,?,NULL,?,'in_progress',2,NULL,NULL,?,?)`).bind(task, ROOM, AUTHOR, spec, Date.now(), Date.now()),
    db.prepare('INSERT INTO task_leases(task_id,holder_id,lease_epoch,expires_at_ms) VALUES (?,?,3,?)').bind(task, AUTHOR, Date.now() + 60_000),
    db.prepare('INSERT INTO execution_cancels(task_id,generation) VALUES (?,0)').bind(task),
    db.prepare('INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES (?,?,?,?,?,?)')
      .bind(artifact, ROOM, AUTHOR, options.artifact ?? output, 'text', new Date().toISOString()),
    db.prepare(`INSERT INTO budget_reservations(reservation_id,attempt_id,run_id,project,principal_id,model,state,micro_usd,pricing_snapshot_json,generation_id,provider_account,created_at)
      VALUES (?,?,?,?,?,?,'settled',782,'{}',?,'fixture',?)`).bind(`res-${n}`, `attempt-${n}`, run, 'eval-fixture', AUTHOR, 'fixture/model', `gen-${n}`, new Date().toISOString()),
    db.prepare(`INSERT INTO budget_actuals(id,reservation_id,project,provider,provider_account,generation_id,model,micro_usd,cost_field,tokens_json,created_at)
      VALUES (?,?,'eval-fixture','openrouter','fixture',?,'fixture/model',18,'total_cost','{}',?)`)
      .bind(`actual-${n}`, `res-${n}`, `gen-${n}`, new Date().toISOString()),
    db.prepare(`INSERT INTO execution_runs(run_id,attempt_id,project,task_id,principal_id,spec_digest,lease_epoch,intent_revision,cancel_generation,
      harness_digest,model_digest,policy_digest,context_digest,state,failure,generation_id,reservation_id,artifact_id,receipt_id,trace_json,created_at)
      VALUES (?,?,'eval-fixture',?,?,?,3,17,0,?,?,?,?,'settled',NULL,?,?,?,NULL,'[]',?)`)
      .bind(run, `attempt-${n}`, task, AUTHOR, specDigest, '1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64), `gen-${n}`, `res-${n}`, artifact, Date.now()),
    db.prepare(`INSERT INTO execution_checkpoints(run_id,task_id,attempt_id,lease_epoch,intent_revision,cancel_generation,checkpoint_step,model_text,tool_digest,updated_at)
      VALUES (?,?,?,3,17,0,'settled',?,?,?)`).bind(run, task, `attempt-${n}`, output, toolDigest, Date.now()),
  ]);
  return { n, run, task, artifact, output, specDigest, service: new Workroom(db, REVIEWER) };
}

async function plan(fixture: Awaited<ReturnType<typeof seed>>) {
  return freezeRunEvaluation(fixture.service, ROOM, fixture.run, `freeze-${fixture.n}`);
}
async function passInput(frozen: Awaited<ReturnType<typeof plan>>): Promise<RunEvaluationInput> {
  return {
    schema_version: '1', manifest_id: frozen.data.id, manifest_digest: frozen.data.result.manifest_digest,
    shards: await Promise.all(frozen.data.result.manifest.expected_shards.map(async (condition, index) => {
      const evidence = `fixture consumer checked ${condition.condition_id}: actual expected output matched`;
      return { condition_id: condition.condition_id, command: `fixture-check-${index}`, exit_code: 0,
        cases: [{ case_id: `case-${index}`, status: 'PASS' as const, evidence, evidence_sha256: await hashEvaluationEvidence(evidence) }] };
    })),
  };
}

test('expectations come from immutable task data and a durable manifest precedes submission', async () => {
  const f = await seed(), frozen = await plan(f);
  assert.equal(frozen.data.result.disposition, 'HOLD');
  assert.deepEqual(frozen.data.result.reasons, ['evaluation_not_submitted']);
  const manifest = frozen.data.result.manifest;
  assert.equal(manifest.spec_digest, f.specDigest);
  assert.equal(manifest.artifact_digest, await hashEvaluationEvidence(f.output));
  assert.equal(manifest.reviewer_principal, REVIEWER);
  assert.equal(manifest.author_principal, AUTHOR);
  assert.equal(manifest.reserved_micro_usd, 782);
  assert.equal(manifest.actual_micro_usd, 18);
  assert.equal(manifest.actual_exceeds_reserved_hold, false);
  assert.equal(manifest.expected_shards.length, 2);
  const retry = await plan(f);
  assert.equal(retry.meta.replayed, true);
  assert.equal(retry.data.id, frozen.data.id);
  const result = await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}`, await passInput(frozen));
  assert.equal(result.data.result.disposition, 'PASS');
  assert.equal(result.data.result.case_count, 2);
  assert.equal(result.data.result.proof_mode, 'authenticated_reviewer_evidence');
  assert.equal(result.data.result.live_proof, false);
  assert.equal(result.data.result.task_approved, false);
  const restarted = new Workroom(db, REVIEWER);
  const view = await getRunEvaluation(restarted, ROOM, f.run);
  assert.equal(view.data.disposition, 'PASS');
  assert.equal(view.data.receipts.length, 1);
  const replay = await submitRunEvaluation(restarted, ROOM, f.run, `submit-${f.n}`, await passInput(frozen));
  assert.equal(replay.data.id, result.data.id);
  assert.equal(replay.meta.replayed, true);
  const task = await db.prepare('SELECT state FROM tasks WHERE id=?').bind(f.task).first<{ state: string }>();
  assert.equal(task?.state, 'in_progress');
});

test('the author cannot freeze or submit and one reviewer cannot use another reviewer manifest', async () => {
  const f = await seed(), author = new Workroom(db, AUTHOR);
  await assert.rejects(freezeRunEvaluation(author, ROOM, f.run, 'author-freeze'), (e: unknown) => e instanceof Fault && e.code === 'FORBIDDEN');
  const frozen = await plan(f), input = await passInput(frozen);
  await assert.rejects(submitRunEvaluation(author, ROOM, f.run, 'author-submit', input), (e: unknown) => e instanceof Fault && e.code === 'NOT_FOUND');
  await assert.rejects(submitRunEvaluation(new Workroom(db, 'synthetic:other'), ROOM, f.run, 'other-submit', input), (e: unknown) => e instanceof Fault && e.code === 'NOT_FOUND');
  await assert.rejects(submitRunEvaluation(f.service, ROOM, f.run, 'missing-manifest', { ...input, manifest_id: 'unfrozen' }), /manifest not found/);
});

test('posting permission alone does not grant an independent reviewer role', async () => {
  const f = await seed();
  await db.prepare("INSERT INTO principals(id) VALUES ('synthetic:untyped-reviewer')").all();
  await db.prepare("INSERT INTO memberships(principal_id,room_id,can_post) VALUES ('synthetic:untyped-reviewer','room_main',1)").all();
  await assert.rejects(freezeRunEvaluation(new Workroom(db, 'synthetic:untyped-reviewer'), ROOM, f.run, 'untyped-reviewer-plan'),
    (e: unknown) => e instanceof Fault && e.code === 'FORBIDDEN');
});

test('a changed request cannot replay an existing receipt key', async () => {
  const f = await seed(), frozen = await plan(f), input = await passInput(frozen);
  await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}`, input);
  input.shards[0]!.command = 'another check';
  await assert.rejects(submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}`, input), (e: unknown) => e instanceof Fault && e.code === 'IDEMPOTENCY_CONFLICT');
});

for (const scenario of ['missing', 'extra', 'duplicate', 'zero', 'not_run', 'unknown', 'skipped', 'aborted', 'failed', 'tamper', 'blank', 'duplicate_case'] as const) {
  test(`${scenario} evidence cannot pass the frozen census`, async () => {
    const f = await seed(), frozen = await plan(f), input = await passInput(frozen);
    if (scenario === 'missing') input.shards.pop();
    if (scenario === 'extra') input.shards.push({ ...input.shards[0]!, condition_id: 'invented' });
    if (scenario === 'duplicate') input.shards.push(structuredClone(input.shards[0]!));
    if (scenario === 'zero') input.shards[0]!.cases = [];
    if (scenario === 'not_run') input.shards[0]!.cases[0]!.status = 'NOT_RUN';
    if (scenario === 'unknown') input.shards[0]!.cases[0]!.status = 'UNKNOWN';
    if (scenario === 'skipped') input.shards[0]!.cases[0]!.status = 'SKIPPED';
    if (scenario === 'aborted') input.shards[0]!.cases[0]!.status = 'ABORTED';
    if (scenario === 'failed') { input.shards[0]!.cases[0]!.status = 'FAIL'; input.shards[0]!.exit_code = 1; }
    if (scenario === 'tamper') input.shards[0]!.cases[0]!.evidence += ' tampered';
    if (scenario === 'blank') { input.shards[0]!.cases[0]!.evidence = ''; input.shards[0]!.cases[0]!.evidence_sha256 = await hashEvaluationEvidence(''); }
    if (scenario === 'duplicate_case') input.shards[1]!.cases[0]!.case_id = input.shards[0]!.cases[0]!.case_id;
    const result = await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}`, input);
    assert.equal(result.data.result.disposition, 'HOLD');
    assert.ok(result.data.result.reasons.length > 0);
  });
}

test('zero expected conditions cannot pass vacuously', async () => {
  const f = await seed({ conditions: [] }), frozen = await plan(f);
  assert.ok(frozen.data.result.reasons.includes('missing_done_conditions'));
  const result = await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}`, await passInput(frozen));
  assert.equal(result.data.result.disposition, 'HOLD');
  assert.ok(result.data.result.reasons.includes('empty_expected_shards'));
});

test('historical digest-only artifacts are not accepted as the actual model output', async () => {
  const f = await seed({ artifact: '1'.repeat(64) }), frozen = await plan(f);
  assert.ok(frozen.data.result.reasons.includes('artifact_output_mismatch'));
  const result = await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}`, await passInput(frozen));
  assert.equal(result.data.result.disposition, 'HOLD');
});

test('late FAIL is retained and prevents a later PASS from masking it', async () => {
  const f = await seed(), frozen = await plan(f), input = await passInput(frozen);
  await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}-first`, input);
  const failed = structuredClone(input);
  failed.shards[0]!.cases[0]!.status = 'FAIL';
  failed.shards[0]!.exit_code = 1;
  await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}-late`, failed);
  const retry = await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}-again`, input);
  assert.equal(retry.data.result.disposition, 'HOLD');
  assert.ok(retry.data.result.reasons.includes('prior_failed_evidence'));
  const view = await getRunEvaluation(f.service, ROOM, f.run);
  assert.equal(view.data.disposition, 'HOLD');
  assert.equal(view.data.receipts.length, 3);
  assert.equal(view.data.receipts[2]!.result.disposition, 'PASS');
  const replacement = await freezeRunEvaluation(f.service, ROOM, f.run, `freeze-${f.n}-replacement`);
  const sameRun = await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}-replacement`, await passInput(replacement));
  assert.equal(sameRun.data.result.disposition, 'HOLD');
  assert.ok(sameRun.data.result.reasons.includes('prior_failed_evidence'));
});

test('artifact revisions and canceled generations invalidate historical PASS on readback', async () => {
  const f = await seed(), frozen = await plan(f), input = await passInput(frozen);
  await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}`, input);
  await db.prepare('INSERT INTO message_revisions(id,message_id,version,editor_id,text,format,created_at) VALUES (?,?,2,?,?,?,?)')
    .bind(`rev-${f.n}`, f.artifact, AUTHOR, 'changed output', 'text', new Date().toISOString()).all();
  let view = await getRunEvaluation(f.service, ROOM, f.run);
  assert.equal(view.data.disposition, 'HOLD');
  assert.ok(view.data.reasons.includes('manifest_stale'));
  const result = await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}-stale`, input);
  assert.equal(result.data.result.disposition, 'HOLD');
  await db.prepare('UPDATE execution_cancels SET generation=1 WHERE task_id=?').bind(f.task).all();
  view = await getRunEvaluation(f.service, ROOM, f.run);
  assert.equal(view.data.disposition, 'HOLD');
  assert.ok(view.data.reasons.includes('canceled'));
  const replay = await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}`, input);
  assert.equal(replay.data.result.disposition, 'PASS');
  assert.equal(replay.data.current_disposition, 'HOLD');
  assert.equal(replay.meta.result_is_historical_receipt, true);
});

test('changed lease and revised task inputs cannot pass', async () => {
  const source = `source-${serial + 1}`;
  await db.prepare('INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES (?,?,?,?,?,?)')
    .bind(source, ROOM, AUTHOR, 'input', 'text', new Date().toISOString()).all();
  const f = await seed({ source }), frozen = await plan(f), input = await passInput(frozen);
  await db.prepare('UPDATE task_leases SET lease_epoch=4 WHERE task_id=?').bind(f.task).all();
  await db.prepare('INSERT INTO message_revisions(id,message_id,version,editor_id,text,format,created_at) VALUES (?,?,2,?,?,?,?)')
    .bind(`source-rev-${f.n}`, source, AUTHOR, 'new input', 'text', new Date().toISOString()).all();
  const result = await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}`, input);
  assert.equal(result.data.result.disposition, 'HOLD');
  assert.ok(result.data.result.reasons.includes('stale_lease_epoch'));
  assert.ok(result.data.result.reasons.includes('stale_task_inputs'));
});

test('foreign-room task inputs are not valid evaluation sources', async () => {
  const source = `foreign-source-${serial + 1}`, foreignRoom = `foreign-room-${serial + 1}`;
  await db.prepare('INSERT INTO rooms(id) VALUES (?)').bind(foreignRoom).all();
  await db.prepare('INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES (?,?,?,?,?,?)')
    .bind(source, foreignRoom, AUTHOR, 'foreign input', 'text', new Date().toISOString()).all();
  const f = await seed({ source }), frozen = await plan(f);
  assert.ok(frozen.data.result.reasons.includes('stale_task_inputs'));
  const result = await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}`, await passInput(frozen));
  assert.equal(result.data.current_disposition, 'HOLD');
});

test('revoked reviewer membership invalidates current PASS without deleting evidence', async () => {
  const f = await seed();
  f.service = new Workroom(db, 'synthetic:other');
  const frozen = await plan(f);
  await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}`, await passInput(frozen));
  await db.prepare('UPDATE memberships SET active=0 WHERE principal_id=? AND room_id=?').bind('synthetic:other', ROOM).all();
  try {
    const view = await getRunEvaluation(new Workroom(db, REVIEWER), ROOM, f.run);
    assert.equal(view.data.disposition, 'HOLD');
    assert.ok(view.data.reasons.includes('evaluation_snapshot_changed'));
    assert.equal(view.data.receipts[0]!.result.disposition, 'PASS');
  } finally {
    await db.prepare('UPDATE memberships SET active=1 WHERE principal_id=? AND room_id=?').bind('synthetic:other', ROOM).all();
  }
});

test('multiple or mismatched actual cost rows cannot certify settlement', async () => {
  const f = await seed();
  await db.prepare(`INSERT INTO budget_actuals(id,reservation_id,project,provider,provider_account,generation_id,model,micro_usd,cost_field,tokens_json,created_at)
    VALUES (?,?,'eval-fixture','openrouter','fixture',?,'fixture/model',18,'total_cost','{}',?)`)
    .bind(`duplicate-actual-${f.n}`, `res-${f.n}`, `gen-extra-${f.n}`, new Date().toISOString()).all();
  const frozen = await plan(f);
  assert.ok(frozen.data.result.reasons.includes('settlement_unbound'));
  const result = await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}`, await passInput(frozen));
  assert.equal(result.data.result.disposition, 'HOLD');
});

test('settlement binds reservation principal, run and project to the evaluated execution', async () => {
  for (const field of ['principal_id', 'run_id', 'project'] as const) {
    const f = await seed();
    const foreign = field === 'principal_id' ? 'synthetic:other' : `foreign-${field}`;
    await db.prepare(`UPDATE budget_reservations SET ${field}=? WHERE reservation_id=?`).bind(foreign, `res-${f.n}`).all();
    if (field === 'project') await db.prepare('UPDATE budget_actuals SET project=? WHERE reservation_id=?').bind(foreign, `res-${f.n}`).all();
    const frozen = await plan(f);
    assert.ok(frozen.data.result.reasons.includes('settlement_unbound'), field);
    const result = await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}`, await passInput(frozen));
    assert.equal(result.data.result.disposition, 'HOLD', field);
  }
});

test('resumed execution and immutable original billing attempts are represented separately', async () => {
  const f = await seed(), recovered = `recovered-attempt-${f.n}`;
  await db.prepare('UPDATE execution_runs SET attempt_id=? WHERE run_id=?').bind(recovered, f.run).all();
  await db.prepare('UPDATE execution_checkpoints SET attempt_id=? WHERE run_id=?').bind(recovered, f.run).all();
  const frozen = await plan(f);
  assert.equal(frozen.data.result.manifest.attempt_id, recovered);
  assert.equal(frozen.data.result.manifest.billing_attempt_id, `attempt-${f.n}`);
  const result = await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}`, await passInput(frozen));
  assert.equal(result.data.result.disposition, 'PASS');
});

test('actual cost above the reserved estimate is reported without rewriting either amount', async () => {
  const f = await seed();
  await db.prepare('UPDATE budget_actuals SET micro_usd=900 WHERE reservation_id=?').bind(`res-${f.n}`).all();
  const frozen = await plan(f);
  assert.equal(frozen.data.result.manifest.reserved_micro_usd, 782);
  assert.equal(frozen.data.result.manifest.actual_micro_usd, 900);
  assert.equal(frozen.data.result.manifest.actual_exceeds_reserved_hold, true);
  assert.equal(frozen.data.result.reasons.includes('settlement_unbound'), false);
});

test('the SQL write guard rejects cancellation between readback and receipt insert', async () => {
  const f = await seed(), frozen = await plan(f), input = await passInput(frozen);
  let fired = false;
  const racing: Database = {
    prepare(sql) {
      const statement = db.prepare(sql);
      let args: Value[] = [];
      const wrapped: Statement = {
        bind(...values) { args = values; return wrapped; },
        first: <T>() => statement.bind(...args).first<T>(),
        async all<T>() {
          if (!fired && /INSERT INTO verifier_receipts/.test(sql)) {
            fired = true;
            await db.prepare('UPDATE execution_cancels SET generation=1 WHERE task_id=?').bind(f.task).all();
          }
          return statement.bind(...args).all<T>();
        },
      };
      return wrapped;
    },
    batch: statements => db.batch(statements),
  };
  await assert.rejects(submitRunEvaluation(new Workroom(racing, REVIEWER), ROOM, f.run, `submit-${f.n}`, input),
    (e: unknown) => e instanceof Fault && e.code === 'VERSION_CONFLICT');
  assert.equal(fired, true);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM verifier_receipts WHERE principal_id=? AND idempotency_key=?')
    .bind(REVIEWER, `submit-${f.n}`).first<{ n: number }>();
  assert.equal(count?.n, 0);
});

test('a cancellation during status readback cannot leave a stale current PASS', async () => {
  const f = await seed(), frozen = await plan(f);
  await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}`, await passInput(frozen));
  let fired = false;
  const racing: Database = {
    prepare(sql) {
      const statement = db.prepare(sql);
      let args: Value[] = [];
      const wrapped: Statement = {
        bind(...values) { args = values; return wrapped; },
        async first<T>() {
          if (!fired && /evaluation_snapshot_current/.test(sql)) {
            fired = true;
            await db.prepare('UPDATE execution_cancels SET generation=1 WHERE task_id=?').bind(f.task).all();
          }
          return statement.bind(...args).first<T>();
        },
        all: <T>() => statement.bind(...args).all<T>(),
      };
      return wrapped;
    },
    batch: statements => db.batch(statements),
  };
  const view = await getRunEvaluation(new Workroom(racing, REVIEWER), ROOM, f.run);
  assert.equal(fired, true);
  assert.equal(view.data.disposition, 'HOLD');
  assert.ok(view.data.reasons.includes('evaluation_snapshot_changed'));
});

test('the route rejects caller-chosen expectations and identity, and supports durable freeze then evaluate', async () => {
  const f = await seed();
  const base = `http://localhost/api/v1/rooms/${ROOM}/execution-runs/${f.run}/evaluation`;
  const call = (path: string, key: string, body: unknown) => runEvaluationRoute(f.service,
    new Request(path, { method: 'POST', headers: { 'idempotency-key': key } }), new URL(path), async () => body);
  await assert.rejects(call(`${base}/manifest`, 'spoofed-plan', { schema_version: '1', expected_shards: [] }));
  const frozen = await call(`${base}/manifest`, `route-freeze-${f.n}`, { schema_version: '1' });
  assert.ok(frozen && 'result' in frozen.data && frozen.data.result.kind === 'execution_evaluation_manifest');
  const typed = frozen as Awaited<ReturnType<typeof plan>>;
  const input = await passInput(typed);
  await assert.rejects(call(base, 'spoofed-reviewer', { ...input, reviewer_principal: 'user:minsung' }));
  const result = await call(base, `route-submit-${f.n}`, input);
  assert.ok(result && 'result' in result.data);
  assert.equal(result.data.result.disposition, 'PASS');
  const view = await runEvaluationRoute(f.service, new Request(base), new URL(base), async () => null);
  assert.ok(view && 'disposition' in view.data);
  assert.equal(view.data.disposition, 'PASS');
});

test('corrupt persisted receipt census cannot be replayed or reported as current PASS', async () => {
  const f = await seed(), frozen = await plan(f), input = await passInput(frozen);
  const stored = await submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}`, input);
  await db.prepare("UPDATE verifier_receipts SET result_json=json_set(result_json,'$.case_count',0) WHERE id=?")
    .bind(stored.data.id).all();
  const corrupt = (error: unknown) => error instanceof Fault && error.code === 'CORRUPT_EVIDENCE';
  await assert.rejects(getRunEvaluation(f.service, ROOM, f.run), corrupt);
  await assert.rejects(submitRunEvaluation(f.service, ROOM, f.run, `submit-${f.n}`, input), corrupt);
});

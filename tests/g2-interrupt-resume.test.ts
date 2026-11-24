import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../scripts/local-harness.ts';
import type { SettleInput } from '../src/or-harness/client.ts';
import { claimUnitId } from '../src/server/decision-shadow.ts';
import type { Database } from '../src/server/db.ts';
import {
  getRunStatus, heartbeatRun, interruptRun, LIVE_MAX_TOKENS, LIVE_MODEL,
  resumeRun, settleAgain, superviseRun, type RunInput,
} from '../src/server/run-supervisor.ts';

const CHAT = 'https://openrouter.ai/api/v1/chat/completions';
const GENERATION = 'https://openrouter.ai/api/v1/generation';
const KEY = 'test-openrouter-key';
const PRINCIPAL = 'synthetic:alpha';

async function seedBase(db: Database) {
  await db.prepare(`INSERT INTO owner_directives(id,room_id,actor_id,text,message_id,idempotency_key,request_hash,created_at)
    VALUES ('dir_g2','room_main','user:minsung','north',NULL,'intent-key-g2','hash-g2','2026-11-23T00:00:00.000Z')`).all();
  await db.prepare(`INSERT INTO intent_versions(version,north_star,intent_md,parent_version,directive_id,author_principal,content_hash,created_at)
    VALUES (4,'north','do the g2 job',NULL,'dir_g2','user:minsung','hash-g2','2026-11-23T00:00:00.000Z')`).all();
}

async function seedTask(db: Database, taskId: string, epoch = 3, holder = PRINCIPAL, expiresInMs = 60_000) {
  const now = Date.now();
  await db.prepare(`INSERT INTO tasks(id,room_id,creator_id,owner_id,spec_json,state,version,current_submission_id,cancel_reason,created_at_ms,updated_at_ms)
    VALUES (?,?,?,NULL,?,'in_progress',2,NULL,NULL,?,?)`).bind(taskId, 'room_main', holder, JSON.stringify({ goal: 'g2 job', owner: null, dependencies: [], input_versions: [], done_conditions: ['Produce the requested result'] }), now, now).all();
  await db.prepare('INSERT INTO task_leases(task_id,holder_id,lease_epoch,expires_at_ms) VALUES (?,?,?,?)')
    .bind(taskId, holder, epoch, now + expiresInMs).all();
  await db.prepare('INSERT INTO execution_cancels(task_id,generation) VALUES (?,0)').bind(taskId).all();
}

function makeMockFetch(opts: {
  genId?: string;
  content?: string;
  costStatus?: number;
  throwChat?: boolean;
  onCall?: (method: string, url: string) => void;
} = {}) {
  const genId = opts.genId ?? 'gen-g2-1';
  const content = opts.content ?? 'one short sentence.';
  const stats = { posts: 0, gets: 0 };
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    opts.onCall?.(method, url);
    if (method === 'POST' && url === CHAT) {
      stats.posts += 1;
      if (opts.throwChat) throw new Error('socket closed');
      return Response.json({
        id: genId,
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 8, completion_tokens: 137, total_tokens: 145, completion_tokens_details: { reasoning_tokens: 100 } },
      });
    }
    if (method === 'GET' && url.startsWith(GENERATION)) {
      stats.gets += 1;
      if (opts.costStatus && opts.costStatus !== 200) return new Response(null, { status: opts.costStatus });
      return Response.json({
        data: {
          id: genId,
          total_cost: 0.000028,
          tokens_prompt: 8,
          tokens_completion: 137,
          native_tokens_prompt: 18,
          native_tokens_completion: 112,
          native_tokens_reasoning: 100,
          provider_name: 'Wafer',
          model: `${LIVE_MODEL}-20260826`,
        },
      });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fetch, stats };
}

function baseInput(task_id: string, run_id: string, attempt_id: string, fetch: RunInput['fetch']): RunInput {
  return {
    project: 'g2',
    task_id,
    run_id,
    attempt_id,
    principal: PRINCIPAL,
    lease_epoch: 3,
    intent_revision: 4,
    cancel_generation: 0,
    model: LIVE_MODEL,
    prompt: 'Reply with one short sentence.',
    max_tokens: LIVE_MAX_TOKENS,
    api_key: KEY,
    cap_micro_usd: 3_000_000,
    cost_retries: 1,
    cost_delay_ms: 0,
    fetch,
  };
}

test('G2 crash recovery across claim, reserve, model, and artifact resumes without double billing and persists reasoning split', async () => {
  const app = await harness({ through: 84, seed: true });
  try {
    const db = app.db;
    await seedBase(db);

    // 1. Crash after claim -> resume with bumped lease_epoch
    await seedTask(db, 't_claim', 3);
    const mClaim = makeMockFetch({ genId: 'gen-claim' });
    await assert.rejects(
      () => superviseRun(db, {
        ...baseInput('t_claim', 'run-claim', 'run-claim-a1', mClaim.fetch),
        after: step => { if (step === 'claim') throw new Error('crash_claim'); },
      }),
      /crash_claim/,
    );
    assert.equal(mClaim.stats.posts, 0);
    await db.prepare('UPDATE task_leases SET lease_epoch=4, expires_at_ms=? WHERE task_id=?').bind(Date.now() + 60_000, 't_claim').all();
    const resClaim = await resumeRun(db, { ...baseInput('t_claim', 'run-claim', 'run-claim-a2', mClaim.fetch), lease_epoch: 4 });
    assert.equal(resClaim.disposition, 'PASS');
    assert.equal(mClaim.stats.posts, 1);
    assert.equal(mClaim.stats.gets, 1);

    // 2. Crash after reserve -> resume reuses single open reservation
    await seedTask(db, 't_reserve', 3);
    const mReserve = makeMockFetch({ genId: 'gen-reserve' });
    await assert.rejects(
      () => superviseRun(db, {
        ...baseInput('t_reserve', 'run-reserve', 'run-reserve-a1', mReserve.fetch),
        after: step => { if (step === 'reserve') throw new Error('crash_reserve'); },
      }),
      /crash_reserve/,
    );
    assert.equal(mReserve.stats.posts, 0);
    await db.prepare('UPDATE task_leases SET lease_epoch=4, expires_at_ms=? WHERE task_id=?').bind(Date.now() + 60_000, 't_reserve').all();
    const resReserve = await resumeRun(db, { ...baseInput('t_reserve', 'run-reserve', 'run-reserve-a2', mReserve.fetch), lease_epoch: 4 });
    assert.equal(resReserve.disposition, 'PASS');
    assert.equal(mReserve.stats.posts, 1);
    assert.equal(mReserve.stats.gets, 1);
    const reserveCount = await db.prepare('SELECT COUNT(*) AS n FROM budget_reservations WHERE run_id=?').bind('run-reserve').first<{ n: number }>();
    assert.equal(reserveCount?.n, 1);

    // 3. Crash after model -> resume does ZERO model POSTs, writes 1 artifact, settles once, stores reasoning split
    await seedTask(db, 't_model', 3);
    const mModel = makeMockFetch({ genId: 'gen-model', content: 'checkpointed output' });
    await assert.rejects(
      () => superviseRun(db, {
        ...baseInput('t_model', 'run-model', 'run-model-a1', mModel.fetch),
        after: step => { if (step === 'model') throw new Error('crash_model'); },
      }),
      /crash_model/,
    );
    assert.equal(mModel.stats.posts, 1);
    assert.equal(mModel.stats.gets, 0);
    await db.prepare('UPDATE task_leases SET lease_epoch=4, expires_at_ms=? WHERE task_id=?').bind(Date.now() + 60_000, 't_model').all();
    const resModel = await resumeRun(db, { ...baseInput('t_model', 'run-model', 'run-model-a2', mModel.fetch), lease_epoch: 4 });
    assert.equal(resModel.disposition, 'PASS');
    assert.equal(resModel.state, 'settled');
    assert.equal(resModel.generation_id, 'gen-model');
    assert.equal(mModel.stats.posts, 1);
    assert.equal(mModel.stats.gets, 1);
    const actualRow = await db.prepare('SELECT micro_usd, tokens_json FROM budget_actuals WHERE generation_id=?')
      .bind('gen-model').first<{ micro_usd: number; tokens_json: string }>();
    assert.equal(actualRow?.micro_usd, 28);
    assert.deepEqual(JSON.parse(actualRow?.tokens_json ?? '{}'), {
      prompt: 8, completion: 137, total: 145, reasoning: 100, content: 12, native_prompt: 18, native_completion: 112,
    });
    const statusView = await getRunStatus(db, 'run-model');
    assert.equal(statusView?.resumed_count, 1);
    assert.equal(statusView?.checkpoint_step, 'settled');
    assert.equal(statusView?.actual_micro_usd, 28);

    // Replaying or resuming an already-settled run makes 0 fetches and does not double bill
    const replaySettled = await resumeRun(db, { ...baseInput('t_model', 'run-model', 'run-model-a3', mModel.fetch), lease_epoch: 4 });
    assert.equal(replaySettled.disposition, 'PASS');
    assert.equal(replaySettled.fetches, 0);
    assert.equal(mModel.stats.posts, 1);
    assert.equal(mModel.stats.gets, 1);

    // 4. Crash after artifact (before settle) -> resume makes 0 POSTs, reuses artifact, settles once
    await seedTask(db, 't_art', 3);
    const mArt = makeMockFetch({ genId: 'gen-art' });
    await assert.rejects(
      () => superviseRun(db, {
        ...baseInput('t_art', 'run-art', 'run-art-a1', mArt.fetch),
        after: step => { if (step === 'artifact') throw new Error('crash_art'); },
      }),
      /crash_art/,
    );
    const resArt = await resumeRun(db, baseInput('t_art', 'run-art', 'run-art-a2', mArt.fetch));
    assert.equal(resArt.disposition, 'PASS');
    assert.equal(mArt.stats.posts, 1);
    assert.equal(mArt.stats.gets, 2);
    const msgCount = await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id=?').bind(resArt.artifact_id).first<{ n: number }>();
    assert.equal(msgCount?.n, 1);
  } finally { await app.close(); }
});

test('G2 interrupt bumps cancel_generation and blocks pre-send, mid-flight, and resumed artifact commits', async () => {
  const app = await harness({ through: 84, seed: true });
  try {
    const db = app.db;
    await seedBase(db);

    // 1. Crashed at reserved, then interrupted -> resume releases open hold and cancels with 0 fetches
    await seedTask(db, 't_int_res', 3);
    const mRes = makeMockFetch({ genId: 'gen-never' });
    await assert.rejects(
      () => superviseRun(db, {
        ...baseInput('t_int_res', 'run-int-res', 'run-int-res-a1', mRes.fetch),
        after: step => { if (step === 'reserve') throw new Error('pause_res'); },
      }),
      /pause_res/,
    );
    const intr1 = await interruptRun(db, { task_id: 't_int_res', run_id: 'run-int-res', principal: PRINCIPAL, reason: 'stop_before_model' });
    assert.equal(intr1.ok, true);
    assert.equal(intr1.cancel_generation, 1);
    const canceledRes = await resumeRun(db, baseInput('t_int_res', 'run-int-res', 'run-int-res-a2', mRes.fetch));
    assert.equal(canceledRes.disposition, 'CANCELED');
    assert.equal(canceledRes.state, 'canceled');
    assert.equal(canceledRes.fetches, 0);
    assert.equal(mRes.stats.posts, 0);
    const holdClosed = await db.prepare('SELECT state, pending_reason FROM budget_reservations WHERE run_id=?')
      .bind('run-int-res').first<{ state: string; pending_reason: string }>();
    assert.equal(holdClosed?.state, 'closed_no_charge');
    assert.equal(holdClosed?.pending_reason, 'canceled_on_resume');

    // 2. Crashed at modeled, then interrupted -> resume settles OpenRouter cost (0 POSTs) and writes NO artifact
    await seedTask(db, 't_int_mod', 3);
    const mMod = makeMockFetch({ genId: 'gen-int-mod' });
    await assert.rejects(
      () => superviseRun(db, {
        ...baseInput('t_int_mod', 'run-int-mod', 'run-int-mod-a1', mMod.fetch),
        after: step => { if (step === 'model') throw new Error('pause_mod'); },
      }),
      /pause_mod/,
    );
    const intr2 = await interruptRun(db, { task_id: 't_int_mod', run_id: 'run-int-mod', principal: PRINCIPAL, reason: 'abort_after_model' });
    assert.equal(intr2.ok, true);
    assert.equal(intr2.cancel_generation, 1);
    const canceledMod = await resumeRun(db, baseInput('t_int_mod', 'run-int-mod', 'run-int-mod-a2', mMod.fetch));
    assert.equal(canceledMod.disposition, 'CANCELED');
    assert.equal(canceledMod.artifact_id, null);
    assert.equal(mMod.stats.posts, 1);
    assert.equal(mMod.stats.gets, 1);
    const settledAfterCancel = await db.prepare('SELECT state FROM budget_reservations WHERE run_id=?').bind('run-int-mod').first<{ state: string }>();
    assert.equal(settledAfterCancel?.state, 'settled');

    // Trying to resume a canceled run again stays CANCELED with 0 fetches
    const retryCanceled = await resumeRun(db, { ...baseInput('t_int_mod', 'run-int-mod', 'run-int-mod-a3', mMod.fetch), cancel_generation: 1 });
    assert.equal(retryCanceled.disposition, 'CANCELED');
    assert.equal(retryCanceled.fetches, 0);

    // 3. Mid-flight interrupt during tool step -> settles cost, refuses late artifact write
    await seedTask(db, 't_int_tool', 3);
    const mTool = makeMockFetch({ genId: 'gen-int-tool' });
    const midCanceled = await superviseRun(db, {
      ...baseInput('t_int_tool', 'run-int-tool', 'run-int-tool-a1', mTool.fetch),
      after: async step => {
        if (step === 'tool') await interruptRun(db, { task_id: 't_int_tool', run_id: 'run-int-tool', principal: PRINCIPAL, reason: 'late_cancel' });
      },
    });
    assert.equal(midCanceled.disposition, 'CANCELED');
    assert.equal(midCanceled.artifact_id, null);
    assert.equal(mTool.stats.posts, 1);
    const intRows = await db.prepare('SELECT COUNT(*) AS n FROM execution_interrupts WHERE task_id=?').bind('t_int_tool').first<{ n: number }>();
    assert.equal(intRows?.n, 1);
  } finally { await app.close(); }
});

test('G2 fences reject stale epoch, expired lease, intent change, wrong principal, and mid-run expiry', async () => {
  const app = await harness({ through: 84, seed: true });
  try {
    const db = app.db;
    await seedBase(db);
    await seedTask(db, 't_fence', 3);
    const m = makeMockFetch({ genId: 'gen-fence' });
    await assert.rejects(
      () => superviseRun(db, {
        ...baseInput('t_fence', 'run-fence', 'run-fence-a1', m.fetch),
        after: step => { if (step === 'model') throw new Error('crash'); },
      }),
      /crash/,
    );
    assert.equal(m.stats.posts, 1);

    // Different principal cannot hijack run
    const wrongPrincipal = await resumeRun(db, {
      ...baseInput('t_fence', 'run-fence', 'run-fence-hijack', m.fetch),
      principal: 'synthetic:beta',
    });
    assert.equal(wrongPrincipal.disposition, 'FAIL');
    assert.equal(wrongPrincipal.failure, 'principal_mismatch');
    assert.equal(wrongPrincipal.fetches, 0);

    // Bump lease_epoch to 4, then reject stale epoch 3 without corrupting stored run state
    await db.prepare('UPDATE task_leases SET lease_epoch=4, expires_at_ms=? WHERE task_id=?').bind(Date.now() + 60_000, 't_fence').all();
    const staleEpoch = await resumeRun(db, { ...baseInput('t_fence', 'run-fence', 'run-fence-old', m.fetch), lease_epoch: 3 });
    assert.equal(staleEpoch.disposition, 'FAIL');
    assert.equal(staleEpoch.failure, 'stale_epoch');
    assert.equal(staleEpoch.fetches, 0);
    const stillModeled = await db.prepare('SELECT state FROM execution_runs WHERE run_id=?').bind('run-fence').first<{ state: string }>();
    assert.equal(stillModeled?.state, 'modeled');

    // Expired lease rejected
    await db.prepare('UPDATE task_leases SET expires_at_ms=? WHERE task_id=?').bind(Date.now() - 1000, 't_fence').all();
    const expired = await resumeRun(db, { ...baseInput('t_fence', 'run-fence', 'run-fence-exp', m.fetch), lease_epoch: 4 });
    assert.equal(expired.disposition, 'FAIL');
    assert.equal(expired.failure, 'stale_epoch');
    assert.equal(expired.fetches, 0);

    // Restore lease expiry, bump intent_revision to 5 -> both old and new intent_revision rejected
    await db.prepare('UPDATE task_leases SET expires_at_ms=? WHERE task_id=?').bind(Date.now() + 60_000, 't_fence').all();
    await db.prepare(`INSERT INTO intent_versions(version,north_star,intent_md,parent_version,directive_id,author_principal,content_hash,created_at)
      VALUES (5,'north','changed goal',4,'dir_g2','user:minsung','hash-g2-v5','2026-11-23T00:01:00.000Z')`).all();
    const oldIntent = await resumeRun(db, { ...baseInput('t_fence', 'run-fence', 'run-fence-i4', m.fetch), lease_epoch: 4, intent_revision: 4 });
    assert.equal(oldIntent.disposition, 'FAIL');
    assert.equal(oldIntent.failure, 'stale_intent');
    assert.equal(oldIntent.fetches, 0);
    const newIntent = await resumeRun(db, { ...baseInput('t_fence', 'run-fence', 'run-fence-i5', m.fetch), lease_epoch: 4, intent_revision: 5 });
    assert.equal(newIntent.disposition, 'FAIL');
    assert.equal(newIntent.failure, 'stale_intent');
    assert.equal(newIntent.fetches, 0);

    // Mid-run lease expiry during model call settles cost and refuses late artifact
    await seedTask(db, 't_mid_exp', 3);
    const mMid = makeMockFetch({ genId: 'gen-mid-exp' });
    const midExp = await superviseRun(db, {
      ...baseInput('t_mid_exp', 'run-mid-exp', 'run-mid-exp-a1', mMid.fetch),
      intent_revision: 5,
      after: async step => {
        if (step === 'model') await db.prepare('UPDATE task_leases SET expires_at_ms=? WHERE task_id=?').bind(Date.now() - 500, 't_mid_exp').all();
      },
    });
    assert.equal(midExp.disposition, 'FAIL');
    assert.equal(midExp.failure, 'stale_epoch_mid_run');
    assert.equal(midExp.artifact_id, null);
    assert.equal(mMid.stats.posts, 1);
    assert.equal(mMid.stats.gets, 1);
  } finally { await app.close(); }
});

test('G2 fails closed on ambiguity, refuses blind redispatch from UNKNOWN, and reconciles late cost', async () => {
  const app = await harness({ through: 84, seed: true });
  try {
    const db = app.db;
    await seedBase(db);

    // 1. lost_response -> UNKNOWN preserved, no blind redispatch on resume
    await seedTask(db, 't_lost', 3);
    const mLost = makeMockFetch({ throwChat: true });
    const lost = await superviseRun(db, baseInput('t_lost', 'run-lost', 'run-lost-a1', mLost.fetch));
    assert.equal(lost.disposition, 'UNKNOWN');
    assert.equal(lost.failure, 'lost_response');
    assert.equal(mLost.stats.posts, 1);
    const mAfterLost = makeMockFetch({ genId: 'gen-must-not-run' });
    const resumeLost = await resumeRun(db, baseInput('t_lost', 'run-lost', 'run-lost-a2', mAfterLost.fetch));
    assert.equal(resumeLost.disposition, 'UNKNOWN');
    assert.equal(resumeLost.failure, 'lost_response');
    assert.equal(resumeLost.fetches, 0);
    assert.equal(mAfterLost.stats.posts, 0);

    // 2. Ambiguous checkpoint: modeled row missing checkpoint model_text -> fails closed with 0 fetches
    await seedTask(db, 't_ambig', 3);
    const mAmbig = makeMockFetch({ genId: 'gen-ambig' });
    await assert.rejects(
      () => superviseRun(db, {
        ...baseInput('t_ambig', 'run-ambig', 'run-ambig-a1', mAmbig.fetch),
        after: step => { if (step === 'model') throw new Error('crash'); },
      }),
      /crash/,
    );
    await db.prepare('DELETE FROM execution_checkpoints WHERE run_id=?').bind('run-ambig').all();
    const ambigRes = await resumeRun(db, baseInput('t_ambig', 'run-ambig', 'run-ambig-a2', mAmbig.fetch));
    assert.equal(ambigRes.disposition, 'UNKNOWN');
    assert.equal(ambigRes.failure, 'ambiguous_checkpoint');
    assert.equal(ambigRes.fetches, 0);
    assert.equal(mAmbig.stats.posts, 1);

    // 3. Context/prompt mismatch on resume -> rejected with 0 fetches
    await seedTask(db, 't_ctx', 3);
    const mCtx = makeMockFetch({ genId: 'gen-ctx' });
    await assert.rejects(
      () => superviseRun(db, {
        ...baseInput('t_ctx', 'run-ctx', 'run-ctx-a1', mCtx.fetch),
        after: step => { if (step === 'reserve') throw new Error('crash'); },
      }),
      /crash/,
    );
    const ctxMismatch = await resumeRun(db, {
      ...baseInput('t_ctx', 'run-ctx', 'run-ctx-a2', mCtx.fetch),
      prompt: 'Different prompt must fail closed.',
    });
    assert.equal(ctxMismatch.disposition, 'FAIL');
    assert.equal(ctxMismatch.failure, 'context_mismatch');
    assert.equal(ctxMismatch.fetches, 0);

    // 4. Duplicate non-resume superviseRun on an active run is rejected (no concurrent double billing)
    const dupNonResume = await superviseRun(db, baseInput('t_ctx', 'run-ctx', 'run-ctx-a3', mCtx.fetch));
    assert.equal(dupNonResume.disposition, 'FAIL');
    assert.equal(dupNonResume.failure, 'run_id_conflict');
    assert.equal(dupNonResume.fetches, 0);

    // 5. Late cost appends a new receipt; the original UNKNOWN evidence remains immutable
    await seedTask(db, 't_late1', 3);
    const mLate1 = makeMockFetch({ genId: 'gen-late1', costStatus: 404 });
    const unk1 = await superviseRun(db, baseInput('t_late1', 'run-late1', 'run-late1-a1', mLate1.fetch));
    assert.equal(unk1.state, 'unknown');
    assert.equal(unk1.disposition, 'UNKNOWN');
    assert.ok(unk1.artifact_id);
    const lateActual: SettleInput = {
      generation_id: 'gen-late1',
      micro_usd: 28,
      cost_field: 'total_cost',
      provider_account: 'Wafer',
      model: `${LIVE_MODEL}-20260826`,
      tokens: { prompt: 8, completion: 137, total: 145, reasoning: 100, content: 12 },
    };
    const settled1 = await settleAgain(db, PRINCIPAL, 3_000_000, unk1.reservation_id ?? '', lateActual);
    assert.deepEqual(settled1, { updated_run: true, state: 'settled', disposition: 'PASS' });
    const runRow1 = await db.prepare('SELECT state, failure FROM execution_runs WHERE run_id=?').bind('run-late1').first<{ state: string; failure: string | null }>();
    const rcptRow1 = await db.prepare('SELECT disposition, detail FROM execution_receipts WHERE receipt_id=?').bind(unk1.receipt_id).first<{ disposition: string; detail: string }>();
    assert.equal(runRow1?.state, 'settled');
    assert.equal(runRow1?.failure, null);
    assert.equal(rcptRow1?.disposition, 'UNKNOWN');
    assert.equal(rcptRow1?.detail, 'cost_unknown');
    const latestReceipt = await db.prepare('SELECT c.disposition,c.detail FROM execution_receipts c JOIN execution_runs r ON r.receipt_id=c.receipt_id WHERE r.run_id=?').bind('run-late1').first<{ disposition: string; detail: string }>();
    assert.equal(latestReceipt?.disposition, 'PASS');
    assert.equal(latestReceipt?.detail, 'execution_check:late_cost_settled');

    // 6. Late cost via resumeRun on cost_unknown makes 0 POSTs and 1 GET and transitions to settled/PASS
    await seedTask(db, 't_late2', 3);
    const mLate2Fail = makeMockFetch({ genId: 'gen-late2', costStatus: 404 });
    const unk2 = await superviseRun(db, baseInput('t_late2', 'run-late2', 'run-late2-a1', mLate2Fail.fetch));
    assert.equal(unk2.state, 'unknown');
    const mLate2Ok = makeMockFetch({ genId: 'gen-late2', costStatus: 200 });
    const resLate2 = await resumeRun(db, baseInput('t_late2', 'run-late2', 'run-late2-a2', mLate2Ok.fetch));
    assert.equal(resLate2.state, 'settled');
    assert.equal(resLate2.disposition, 'PASS');
    assert.equal(mLate2Ok.stats.posts, 0);
    assert.equal(mLate2Ok.stats.gets, 1);

    // 7. settleAgain on cancel_cost_unknown preserves canceled/CANCELED
    await seedTask(db, 't_canc_unk', 3);
    const mCancUnk = makeMockFetch({ genId: 'gen-canc-unk', costStatus: 404 });
    const cancUnk = await superviseRun(db, {
      ...baseInput('t_canc_unk', 'run-canc-unk', 'run-canc-unk-a1', mCancUnk.fetch),
      after: async step => {
        if (step === 'model') await interruptRun(db, { task_id: 't_canc_unk', run_id: 'run-canc-unk', principal: PRINCIPAL, reason: 'cancel_unk' });
      },
    });
    assert.equal(cancUnk.disposition, 'CANCELED');
    const cancSettled = await settleAgain(db, PRINCIPAL, 3_000_000, cancUnk.reservation_id ?? '', { ...lateActual, generation_id: 'gen-canc-unk' });
    assert.deepEqual(cancSettled, { updated_run: false, state: 'canceled', disposition: 'CANCELED' });

    // 8. settleAgain on lost_response (no artifact_id) does NOT flip to PASS
    const lostSettled = await settleAgain(db, PRINCIPAL, 3_000_000, lost.reservation_id ?? '', { ...lateActual, generation_id: 'gen-lost-found' });
    assert.deepEqual(lostSettled, { updated_run: true, state: 'unknown', disposition: 'UNKNOWN' });
    const lostRcpt = await db.prepare('SELECT disposition, detail FROM execution_receipts WHERE receipt_id=?').bind(lost.receipt_id).first<{ disposition: string; detail: string }>();
    assert.equal(lostRcpt?.disposition, 'UNKNOWN');
    assert.equal(lostRcpt?.detail, 'lost_response');
    const reconciledReceipt = await db.prepare('SELECT c.detail FROM execution_receipts c JOIN execution_runs r ON r.receipt_id=c.receipt_id WHERE r.run_id=?').bind('run-lost').first<{ detail: string }>();
    assert.equal(reconciledReceipt?.detail, 'reconciled_no_artifact');
  } finally { await app.close(); }
});

test('G2 HTTP routes (/interrupt, /heartbeat, /resume, GET /:run_id) enforce auth and never trigger shadowClaim', async () => {
  const calls: { url: string; method: string }[] = [];
  const outboundService = async (request: Request) => {
    calls.push({ url: request.url, method: request.method });
    if (request.method === 'POST' && request.url === CHAT) {
      return Response.json({
        id: 'gen-http-g2',
        choices: [{ message: { content: 'http ok' } }],
        usage: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25, completion_tokens_details: { reasoning_tokens: 15 } },
      });
    }
    if (request.method === 'GET' && request.url.startsWith(GENERATION)) {
      return Response.json({
        data: {
          id: 'gen-http-g2',
          total_cost: 0.00002,
          tokens_prompt: 5,
          tokens_completion: 20,
          native_tokens_prompt: 5,
          native_tokens_completion: 20,
          native_tokens_reasoning: 15,
          provider_name: 'mock',
          model: LIVE_MODEL,
        },
      });
    }
    return new Response('unexpected', { status: 599 });
  };
  const app = await harness({ through: 84, seed: true, bindings: { OPENROUTER_API_KEY: KEY }, outboundService });
  try {
    await seedBase(app.db);
    await seedTask(app.db, 't_http', 3);

    for (const p of ['execution-runs/resume', 'execution-runs/interrupt', 'execution-runs/heartbeat']) {
      assert.equal(claimUnitId(`http://127.0.0.1/api/v1/rooms/room_main/${p}`, 'POST'), null);
    }

    // Seed a crashed reserved run on t_http
    const dummyFetch = async () => new Response('never', { status: 500 });
    await assert.rejects(
      () => superviseRun(app.db, {
        ...baseInput('t_http', 'run-http', 'run-http-a1', dummyFetch),
        after: step => { if (step === 'reserve') throw new Error('pause'); },
      }),
      /pause/,
    );

    // Heartbeat passes before interrupt, fails after interrupt
    const hbOk = await app.mf.dispatchFetch('http://127.0.0.1/api/v1/rooms/room_main/execution-runs/heartbeat', {
      method: 'POST',
      headers: { Authorization: 'Bearer local-alpha-fixture', 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema_version: '1', task_id: 't_http', run_id: 'run-http', attempt_id: 'run-http-a1', lease_epoch: 3, intent_revision: 4, cancel_generation: 0 }),
    });
    const hbOkBody = await hbOk.json() as { ok: boolean; data: { alive: boolean; cancel_generation: number } };
    assert.equal(hbOk.status, 200);
    assert.equal(hbOkBody.data.alive, true);
    assert.equal(hbOkBody.data.cancel_generation, 0);

    // Reader cannot interrupt (403), unauth cannot (401), alpha can (200)
    const unauth = await app.mf.dispatchFetch('http://127.0.0.1/api/v1/rooms/room_main/execution-runs/interrupt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema_version: '1', task_id: 't_http', run_id: 'run-http', reason: 'test' }),
    });
    assert.equal(unauth.status, 401);
    const readerPost = await app.mf.dispatchFetch('http://127.0.0.1/api/v1/rooms/room_main/execution-runs/interrupt', {
      method: 'POST', headers: { Authorization: 'Bearer local-reader-fixture', 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema_version: '1', task_id: 't_http', run_id: 'run-http', reason: 'test' }),
    });
    assert.equal(readerPost.status, 403);

    const intr = await app.mf.dispatchFetch('http://127.0.0.1/api/v1/rooms/room_main/execution-runs/interrupt', {
      method: 'POST', headers: { Authorization: 'Bearer local-alpha-fixture', 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema_version: '1', task_id: 't_http', run_id: 'run-http', reason: 'owner_preempt' }),
    });
    const intrBody = await intr.json() as { ok: boolean; data: { cancel_generation: number } };
    assert.equal(intr.status, 200);
    assert.equal(intrBody.data.cancel_generation, 1);

    const hbAfter = await app.mf.dispatchFetch('http://127.0.0.1/api/v1/rooms/room_main/execution-runs/heartbeat', {
      method: 'POST',
      headers: { Authorization: 'Bearer local-alpha-fixture', 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema_version: '1', task_id: 't_http', run_id: 'run-http', attempt_id: 'run-http-a1', lease_epoch: 3, intent_revision: 4, cancel_generation: 0 }),
    });
    const hbAfterBody = await hbAfter.json() as { ok: boolean; data: { alive: boolean; failure: string; cancel_generation: number } };
    assert.equal(hbAfterBody.data.alive, false);
    assert.equal(hbAfterBody.data.failure, 'cancel_bumped');
    assert.equal(hbAfterBody.data.cancel_generation, 1);

    // Resume via HTTP cancels cleanly with 0 outbound OpenRouter calls
    const resCanceled = await app.mf.dispatchFetch('http://127.0.0.1/api/v1/rooms/room_main/execution-runs/resume', {
      method: 'POST',
      headers: { Authorization: 'Bearer local-alpha-fixture', 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema_version: '1', project: 'g2', task_id: 't_http', run_id: 'run-http', attempt_id: 'run-http-a2', lease_epoch: 3, intent_revision: 4, prompt: 'Reply with one short sentence.' }),
    });
    const resCanceledBody = await resCanceled.json() as { ok: boolean; data: { disposition: string; fetches: number } };
    assert.equal(resCanceled.status, 200);
    assert.equal(resCanceledBody.data.disposition, 'CANCELED');
    assert.equal(resCanceledBody.data.fetches, 0);
    assert.equal(calls.length, 0);

    // Seed a crashed modeled run on a second task, resume via HTTP -> 0 POSTs, 1 GET, settled/PASS
    await seedTask(app.db, 't_http2', 3);
    const mOnce = makeMockFetch({ genId: 'gen-http-g2', content: 'from model' });
    await assert.rejects(
      () => superviseRun(app.db, {
        ...baseInput('t_http2', 'run-http2', 'run-http2-a1', mOnce.fetch),
        after: step => { if (step === 'model') throw new Error('crash'); },
      }),
      /crash/,
    );
    const resOk = await app.mf.dispatchFetch('http://127.0.0.1/api/v1/rooms/room_main/execution-runs/resume', {
      method: 'POST',
      headers: { Authorization: 'Bearer local-alpha-fixture', 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema_version: '1', project: 'g2', task_id: 't_http2', run_id: 'run-http2', attempt_id: 'run-http2-a2', lease_epoch: 3, intent_revision: 4, prompt: 'Reply with one short sentence.' }),
    });
    const resOkBody = await resOk.json() as { ok: boolean; data: { disposition: string; fetches: number; state: string } };
    assert.equal(resOk.status, 200, JSON.stringify(resOkBody));
    assert.equal(resOkBody.data.disposition, 'PASS');
    assert.equal(resOkBody.data.state, 'settled');
    assert.equal(resOkBody.data.fetches, 1);
    assert.equal(calls.filter(c => c.method === 'POST').length, 0);
    assert.equal(calls.filter(c => c.method === 'GET').length, 1);

    // Reader can inspect GET /execution-runs/:run_id
    const statusRes = await app.mf.dispatchFetch('http://127.0.0.1/api/v1/rooms/room_main/execution-runs/run-http2', {
      method: 'GET',
      headers: { Authorization: 'Bearer local-reader-fixture' },
    });
    const statusBody = await statusRes.json() as { ok: boolean; data: { state: string; resumed_count: number; tokens: { reasoning?: number; content?: number } } };
    assert.equal(statusRes.status, 200);
    assert.equal(statusBody.data.state, 'settled');
    assert.equal(statusBody.data.resumed_count, 1);
    assert.equal(statusBody.data.tokens.reasoning, 15);
    assert.equal(statusBody.data.tokens.content, 5);
    assert.equal(JSON.stringify(statusBody).includes(KEY), false);

    // Direct heartbeat sanity check via function
    const hbDone = await heartbeatRun(app.db, { task_id: 't_http2', run_id: 'run-http2', attempt_id: 'run-http2-a2', principal: PRINCIPAL, lease_epoch: 3, intent_revision: 4, cancel_generation: 0 });
    assert.equal(hbDone.alive, false);
    assert.equal(hbDone.failure, 'terminal_settled');
  } finally { await app.close(); }
});

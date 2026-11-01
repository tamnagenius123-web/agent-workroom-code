// Submit records the workspace head. Merge runs only when the phase-contract receipt
// is PASS at that exact sha, then fast-forwards canonical main under the merge lock.
// Receipt lookup stays outside the lock. The submission is re-read under the lock and
// must still be the sha that receipt names.
// A D1 fence cannot cover the Artifacts ref write. When Artifacts supports compare-and-set,
// the write swaps the expected canonical sha and the captured lock generation together.
// Otherwise the generation is rechecked in D1 immediately before the write and again when
// that write returns. The Artifacts call then gets an AbortSignal for the lock time left
// minus skew, capped at ARTIFACTS_CALL_TIMEOUT_MS and measured from when the timer is armed.
// That bound is soft: reconcile is the backstop. If the time left is at or
// under skew, the call is skipped and the attempt holds. Reconciliation records merged
// only when the fence still matches, or when fence_ok was set by it. A sha or generation
// mismatch stays a hold. A live ref that matches neither sha is canonical drift and stays
// a hold. An expired write_open lease is taken by a compare-and-set on the fence
// generation; the loser writes no lease.

import { Fault, ROOM } from '../contracts.ts';
import type { Database } from '../db.ts';
import { gateDisposition, validateVerifierReceipt, type VerifierReceipt } from '../../phase-contracts/verifier-receipt.ts';
import type { ArtifactsBinding } from './artifacts-binding.ts';
import { acquireMergeLock, releaseMergeLock } from './store.ts';
import { AUTH } from '../policy.ts';

const SHA = /^[0-9a-f]{40}$/;
const LOCK_TTL_MS = 30_000;

/** Configured ceiling for one Artifacts canonical write. The lease must outlast this plus skew. */
export const ARTIFACTS_CALL_TIMEOUT_MS = 20_000;
/** Subtracted from the lock time left after the generation re-check. At or under this, the call is skipped. */
export const MERGE_CLOCK_SKEW_MS = 1_000;
/** write_open stays in flight this long. Strictly longer than the call timeout plus skew. */
export const WRITE_OPEN_LEASE_MS = ARTIFACTS_CALL_TIMEOUT_MS + MERGE_CLOCK_SKEW_MS + 1;

function systemNow(): number {
  return Date.now();
}

export const mergeClock = { now: systemNow };

// Capped at ARTIFACTS_CALL_TIMEOUT_MS so an abort-honoring provider stops inside WRITE_OPEN_LEASE_MS.
// The abort is cooperative: a provider that ignores it has no hard bound (docs/specs/wrgit-open-contract.md).
export function artifactsCallBudget(timeLeftMs: number): { action: 'hold' } | { action: 'call'; timeoutMs: number } {
  if (timeLeftMs <= MERGE_CLOCK_SKEW_MS) return { action: 'hold' };
  return { action: 'call', timeoutMs: Math.min(timeLeftMs - MERGE_CLOCK_SKEW_MS, ARTIFACTS_CALL_TIMEOUT_MS) };
}

// The worker bundle is platform 'browser' and has no nodejs_compat. setTimeout returns
// a number there, so timer.unref() throws. AbortSignal.timeout is the lock bound.
function lockAbortSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

export interface CanonicalFastForward {
  ref: string;
  expectedHead: string;
  sha: string;
  message: string;
  lockGeneration?: number;
  signal?: AbortSignal;
}

export interface FastForwardRecord {
  operationId: string;
  ref: string;
  from: string;
  to: string;
  message: string;
}

export interface MergeArtifacts extends ArtifactsBinding {
  fastForward(repo: string, input: CanonicalFastForward): Promise<{ ref: string; from: string; to: string; message: string }>;
  fastForwardLog(repo: string): Promise<FastForwardRecord[]>;
}

interface WorkspaceRow {
  id: string;
  task_id: string;
  repo: string;
  canonical_repo: string | null;
  base_sha: string;
  head_sha: string | null;
  submitted_sha: string | null;
  agent_id: string;
  unit: string | null;
  merged_sha: string | null;
  status: string;
  created_at: number;
  merged_at: number | null;
}

export interface SubmitResult {
  workspace_id: string;
  task_id: string;
  sha: string;
}

export interface MergeResult {
  workspace_id: string;
  task_id: string;
  receipt_id: string;
  sha: string;
  base_sha: string;
  canonical_repo: string;
  fast_forward: true;
  message: string;
}

const WORKSPACE_COLS = 'id, task_id, repo, canonical_repo, base_sha, head_sha, submitted_sha, agent_id, unit, merged_sha, status, created_at, merged_at';

function writer(artifacts: ArtifactsBinding): MergeArtifacts {
  const candidate = artifacts as Partial<MergeArtifacts>;
  if (typeof candidate.fastForward !== 'function' || typeof candidate.fastForwardLog !== 'function') {
    throw new Fault('UNAVAILABLE', 'Artifacts fast-forward is not configured.', 503);
  }
  return artifacts as MergeArtifacts;
}

const LOCK_HELD = `EXISTS (SELECT 1 FROM wrgit_merge_lock WHERE id=1 AND holder=? AND expires_at>?)`;
const SUBMISSION_HELD = `EXISTS (SELECT 1 FROM wrgit_workspaces WHERE id=? AND submitted_sha=?)`;
// can_post is rechecked in the write statement itself. A revoke after app.ts's authorize writes nothing.
const CAN_POST = `EXISTS (${AUTH} AND m.can_post=1)`;

async function canPost(db: Database, principal: string): Promise<boolean> {
  return (await db.prepare(`${AUTH} AND m.can_post=1`).bind(principal, ROOM).first()) !== null;
}

async function withMergeLock<T>(db: Database, run: (token: string) => Promise<T>): Promise<T> {
  const holder = crypto.randomUUID();
  const acquired = await acquireMergeLock(db, { holder, ttlMs: LOCK_TTL_MS, nowMs: mergeClock.now() });
  if (!acquired.acquired) {
    throw new Fault('merge_locked', 'Another merge holds the canonical main lock.', 409, 'not_applied', true);
  }
  try {
    return await run(holder);
  } finally {
    await releaseMergeLock(db, { holder });
  }
}

async function lockHeld(db: Database, token: string, now: number): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS ok FROM wrgit_merge_lock WHERE id=1 AND holder=? AND expires_at>?`)
    .bind(token, now).first<{ ok: number }>();
  return row != null;
}

function staleLock(): Fault {
  return new Fault('stale_lock', 'Merge lock no longer belongs to this execution.', 409, 'not_applied', true);
}

function isStaleLock(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof Fault) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'stale_lock' || error.message === 'stale_lock';
}

function mergeHold(): Fault {
  return new Fault('merge_hold', 'An open merge intent is in doubt. Reconcile it from Artifacts before another merge.', 409, 'not_applied', true);
}

async function fenceFault(db: Database, token: string, workspaceId: string, sha: string): Promise<Fault> {
  const now = mergeClock.now();
  if (!await lockHeld(db, token, now)) return staleLock();
  const current = await workspaceById(db, workspaceId);
  if (!current || current.submitted_sha !== sha) {
    return new Fault('sha_mismatch', 'Verifier receipt sha does not match the submitted sha.', 409);
  }
  return staleLock();
}

async function workspaceById(db: Database, id: string): Promise<WorkspaceRow | null> {
  return db.prepare(`SELECT ${WORKSPACE_COLS} FROM wrgit_workspaces WHERE id=?`).bind(id).first<WorkspaceRow>();
}

// A task can hold one workspace per agent (PK task_id, agent_id). Merge targets the single row
// whose submitted sha is the receipt's sha, never an arbitrary row of the task.
async function resolveWorkspace(db: Database, taskId: string, sha: string): Promise<WorkspaceRow> {
  const rows = (await db.prepare(`SELECT ${WORKSPACE_COLS} FROM wrgit_workspaces WHERE task_id=? AND submitted_sha=?`)
    .bind(taskId, sha).all<WorkspaceRow>()).results;
  if (rows.length > 1) throw new Fault('ambiguous', 'More than one workspace submitted this sha.', 409);
  if (rows[0]) return rows[0];
  const any = await db.prepare('SELECT submitted_sha FROM wrgit_workspaces WHERE task_id=?')
    .bind(taskId).all<{ submitted_sha: string | null }>();
  if (any.results.length === 0) throw new Fault('NOT_FOUND', 'No workspace for this task.', 404);
  if (any.results.every(r => !r.submitted_sha)) throw new Fault('not_submitted', 'Workspace has no submitted sha.', 409);
  throw new Fault('sha_mismatch', 'Verifier receipt sha does not match the submitted sha.', 409);
}

async function repoHead(artifacts: ArtifactsBinding, name: string): Promise<string | null> {
  try {
    return (await artifacts.get(name)).headSha;
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault('NOT_FOUND', 'Artifacts repo is not available.', 404);
  }
}

function trailer(key: string, value: string): string {
  if (value.trim().length === 0 || /[\r\n]/.test(value)) {
    throw new Fault('INVALID_INPUT', `${key} trailer value must be one non-empty line.`);
  }
  return `${key}: ${value}`;
}

function mergeMessage(input: { sha: string; unit: string; authorAgent: string; verifier: string; receiptId: string; intentId: string }): string {
  return [
    `Merge ${input.sha}`,
    '',
    trailer('Unit', input.unit),
    trailer('Author-Agent', input.authorAgent),
    trailer('Verifier', input.verifier),
    trailer('Receipt', input.receiptId),
    trailer('Intent', input.intentId),
  ].join('\n');
}

interface StoredReceipt {
  receipt?: unknown;
  observation?: { task_id?: unknown; verifier_id?: unknown };
}

function parsePass(resultJson: string, taskId: string): { receipt: VerifierReceipt; verifierId: string } {
  let parsed: StoredReceipt;
  try {
    parsed = JSON.parse(resultJson) as StoredReceipt;
  } catch {
    throw new Fault('verifier_hold', 'Verifier receipt is not PASS.', 409);
  }
  if (parsed.observation?.task_id !== taskId) {
    throw new Fault('task_mismatch', 'Verifier receipt is for a different task.', 409);
  }
  const checked = validateVerifierReceipt(parsed.receipt);
  if (!checked.ok || gateDisposition(checked.value) !== 'PASS') {
    throw new Fault('verifier_hold', 'Verifier receipt is not PASS.', 409);
  }
  if (checked.value.sha !== checked.value.observed_sha) {
    throw new Fault('sha_mismatch', 'Verifier receipt sha does not match the submitted sha.', 409);
  }
  const verifierId = typeof parsed.observation?.verifier_id === 'string' ? parsed.observation.verifier_id : '';
  return { receipt: checked.value, verifierId };
}

function rejectSelfVerification(authorAgent: string, receipt: VerifierReceipt, verifierId: string): void {
  if (authorAgent === receipt.acceptor_id || authorAgent === verifierId) {
    throw new Fault('self_verification', 'Workspace author cannot verify their own submission.', 409);
  }
}

interface IntentRow {
  id: string;
  workspace_id: string;
  task_id: string;
  receipt_id: string;
  sha: string;
  expected_sha: string | null;
  write_open?: number | null;
  write_open_at?: number | null;
  outcome?: string | null;
  lock_generation?: number | null;
  fence_fault?: string | null;
  fence_ok?: number | null;
}

async function intentFence(db: Database, id: string): Promise<IntentRow | null> {
  return db.prepare(
    `SELECT id, workspace_id, task_id, receipt_id, sha, expected_sha, write_open, write_open_at, outcome, lock_generation, fence_fault, fence_ok
     FROM wrgit_merge_intents WHERE id=?`,
  ).bind(id).first<IntentRow>();
}

async function openIntents(db: Database): Promise<IntentRow[]> {
  const rows = await db.prepare(
    `SELECT id, workspace_id, task_id, receipt_id, sha, expected_sha
     FROM wrgit_merge_intents
     WHERE outcome IS NULL
       AND NOT EXISTS (SELECT 1 FROM wrgit_merges WHERE workspace_id=wrgit_merge_intents.workspace_id)`,
  ).all<IntentRow>();
  return rows.results;
}

// An unsettled intent whose merge row was written before the worker died. openIntents skips it,
// so without this a retry sees canonical at the sha with no attempt and the recovery is stranded.
async function partialIntent(db: Database, workspaceId: string, receiptId: string, sha: string): Promise<IntentRow | null> {
  return db.prepare(
    `SELECT id, workspace_id, task_id, receipt_id, sha, expected_sha
     FROM wrgit_merge_intents
     WHERE workspace_id=? AND receipt_id=? AND sha=? AND outcome IS NULL
       AND EXISTS (SELECT 1 FROM wrgit_merges WHERE workspace_id=? AND receipt_id=? AND sha=?)`,
  ).bind(workspaceId, receiptId, sha, workspaceId, receiptId, sha).first<IntentRow>();
}

function messageHasLine(message: string, line: string): boolean {
  return message.split('\n').includes(line);
}

function matchingFastForwards(intent: IntentRow, ops: readonly FastForwardRecord[]): FastForwardRecord[] {
  if (!intent.expected_sha) return [];
  return ops.filter(op =>
    op.ref === 'main'
    && op.from === intent.expected_sha
    && op.to === intent.sha
    && messageHasLine(op.message, `Intent: ${intent.id}`)
    && messageHasLine(op.message, `Receipt: ${intent.receipt_id}`));
}

function provesIntent(intent: IntentRow, ops: readonly FastForwardRecord[]): boolean {
  return matchingFastForwards(intent, ops).length === 1;
}

async function claimIntent(db: Database, principal: string, workspace: WorkspaceRow, receiptId: string, sha: string, expectedSha: string, token: string): Promise<string> {
  const now = mergeClock.now();
  const row = await db.prepare(
    `INSERT INTO wrgit_merge_intents (id, workspace_id, task_id, receipt_id, sha, lock_token, created_at, expected_sha)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE ${LOCK_HELD} AND ${SUBMISSION_HELD} AND ${CAN_POST}
     ON CONFLICT(workspace_id, receipt_id, sha) DO UPDATE SET
       lock_token=excluded.lock_token,
       expected_sha=excluded.expected_sha,
       outcome=NULL,
       settled_at=NULL,
       write_open=0,
       write_open_at=NULL,
       fence_ok=0,
       fence_fault=NULL,
       lock_generation=NULL
     WHERE ${LOCK_HELD} AND ${SUBMISSION_HELD} AND ${CAN_POST}
     RETURNING id`,
  ).bind(
    crypto.randomUUID(), workspace.id, workspace.task_id, receiptId, sha, token, now, expectedSha,
    token, now, workspace.id, sha, principal, ROOM,
    token, now, workspace.id, sha, principal, ROOM,
  ).first<{ id: string }>();
  if (!row && !await canPost(db, principal)) throw new Fault('FORBIDDEN', 'Room access denied.', 403);
  if (!row) throw await fenceFault(db, token, workspace.id, sha);
  return row.id;
}

async function heldIntent(db: Database, workspaceId: string, receiptId: string, sha: string, token: string): Promise<void> {
  const now = mergeClock.now();
  const row = await db.prepare(
    `UPDATE wrgit_merge_intents SET lock_token=?
     WHERE workspace_id=? AND receipt_id=? AND sha=? AND ${LOCK_HELD} AND ${SUBMISSION_HELD}
     RETURNING id`,
  ).bind(token, workspaceId, receiptId, sha, token, now, workspaceId, sha).first<{ id: string }>();
  if (!row) throw await fenceFault(db, token, workspaceId, sha);
}

// Used by the normal path and the recovery path. can_post is rechecked in the first write (the merge row,
// or the workspace mark when the row already exists); a caller revoked before it writes nothing (403),
// and reconcile or an authorized retry records the landed write. The workspace mark also carries CAN_POST.
// The final intent settlement does not: it only records the merge row and merged workspace already written.
async function finishBookkeeping(db: Database, principal: string, workspace: WorkspaceRow, sha: string, receiptId: string, message: string, token: string): Promise<void> {
  const existing = await db.prepare('SELECT sha, receipt_id FROM wrgit_merges WHERE workspace_id=?')
    .bind(workspace.id).first<{ sha: string; receipt_id: string }>();
  if (existing) {
    if (existing.sha !== sha || existing.receipt_id !== receiptId) {
      throw new Fault('CONFLICT', 'Workspace already has a merge record.', 409);
    }
    if (!await canPost(db, principal)) throw new Fault('FORBIDDEN', 'Room access denied.', 403);
  } else {
    const now = mergeClock.now();
    const inserted = await db.prepare(
      `INSERT INTO wrgit_merges(id, task_id, workspace_id, receipt_id, sha, base_sha, message, merged_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${LOCK_HELD}
         AND EXISTS (SELECT 1 FROM wrgit_merge_intents WHERE workspace_id=? AND receipt_id=? AND sha=?)
         AND ${SUBMISSION_HELD}
         AND ${CAN_POST}
       RETURNING id`,
    ).bind(
      crypto.randomUUID(), workspace.task_id, workspace.id, receiptId, sha, workspace.base_sha, message, now,
      token, now, workspace.id, receiptId, sha, workspace.id, sha, principal, ROOM,
    ).all<{ id: string }>();
    if (inserted.results.length === 0) {
      if (!await canPost(db, principal)) throw new Fault('FORBIDDEN', 'Room access denied.', 403);
      throw await fenceFault(db, token, workspace.id, sha);
    }
  }
  const now = mergeClock.now();
  const marked = await db.prepare(
    `UPDATE wrgit_workspaces
     SET head_sha=?, merged_sha=?, status='merged', merged_at=COALESCE(merged_at, ?)
     WHERE id=? AND submitted_sha=? AND status IN ('open', 'submitted', 'merged')
       AND (merged_sha IS NULL OR merged_sha=?)
       AND ${LOCK_HELD}
       AND EXISTS (SELECT 1 FROM wrgit_merge_intents WHERE workspace_id=? AND receipt_id=? AND sha=?)
       AND ${CAN_POST}
     RETURNING id`,
  ).bind(
    sha, sha, now, workspace.id, sha, sha, token, now, workspace.id, receiptId, sha, principal, ROOM,
  ).all<{ id: string }>();
  if (marked.results.length === 0) {
    if (!await canPost(db, principal)) throw new Fault('FORBIDDEN', 'Room access denied.', 403);
    throw await fenceFault(db, token, workspace.id, sha);
  }
  const current = await workspaceById(db, workspace.id);
  if (!current || current.merged_sha !== sha || current.submitted_sha !== sha || current.status !== 'merged') {
    throw new Fault('sha_mismatch', 'Verifier receipt sha does not match the submitted sha.', 409);
  }
  const settledAt = mergeClock.now();
  const settled = await db.prepare(
    `UPDATE wrgit_merge_intents SET outcome='merged', settled_at=?
     WHERE workspace_id=? AND receipt_id=? AND sha=?
       AND EXISTS (SELECT 1 FROM wrgit_merges WHERE workspace_id=? AND receipt_id=? AND sha=?)
       AND ${LOCK_HELD}
     RETURNING id`,
  ).bind(settledAt, workspace.id, receiptId, sha, workspace.id, receiptId, sha, token, settledAt).first<{ id: string }>();
  if (!settled) throw await fenceFault(db, token, workspace.id, sha);
}

// Only the workspace owner submits; only a non-author merges. Write scope is checked in app.ts before routing.
export async function submitWorkspace(db: Database, artifacts: ArtifactsBinding, principal: string, workspaceId: string, sha: string): Promise<SubmitResult> {
  if (!SHA.test(sha)) throw new Fault('INVALID_INPUT', 'sha must be 40 lowercase hex characters.');
  return withMergeLock(db, async token => {
    const workspace = await workspaceById(db, workspaceId);
    if (!workspace) throw new Fault('NOT_FOUND', 'Workspace not found.', 404);
    if (workspace.agent_id !== principal) throw new Fault('FORBIDDEN', 'Only the workspace owner can submit.', 403);
    if (workspace.status === 'merged' || workspace.status === 'canceled') {
      throw new Fault('CONFLICT', 'Workspace status does not allow this change.', 409);
    }
    const head = await repoHead(artifacts, workspace.repo);
    if (head !== sha) throw new Fault('not_head', 'sha is not the workspace head.', 409);
    const now = mergeClock.now();
    const wrote = await db.prepare(
      `UPDATE wrgit_workspaces SET head_sha=?, submitted_sha=?, status='submitted'
       WHERE id=? AND status IN ('open', 'submitted') AND ${LOCK_HELD} AND ${CAN_POST}
       RETURNING id`,
    ).bind(sha, sha, workspace.id, token, now, principal, ROOM).first<{ id: string }>();
    if (!wrote) {
      if (!await canPost(db, principal)) throw new Fault('FORBIDDEN', 'Room access denied.', 403);
      if (!await lockHeld(db, token, mergeClock.now())) throw staleLock();
      throw new Fault('CONFLICT', 'Workspace status does not allow this change.', 409);
    }
    return { workspace_id: workspace.id, task_id: workspace.task_id, sha };
  });
}

export async function mergeTask(db: Database, artifacts: ArtifactsBinding, principal: string, taskId: string, receiptId: string): Promise<MergeResult> {
  const fastForward = writer(artifacts);
  const row = await db.prepare('SELECT id, result_json FROM verifier_receipts WHERE id=?')
    .bind(receiptId).first<{ id: string; result_json: string }>();
  if (!row) throw new Fault('NOT_FOUND', 'Verifier receipt not found.', 404);
  const parsed = parsePass(row.result_json, taskId);
  const known = await resolveWorkspace(db, taskId, parsed.receipt.sha);
  if (known.agent_id === principal) throw new Fault('FORBIDDEN', 'The workspace author cannot merge their own submission.', 403);
  return withMergeLock(db, async token => {
    // A submit can land between the resolve above and this lock, so resolve again under the lock.
    // The outside check is only a fast path; this one decides.
    const workspace = await resolveWorkspace(db, taskId, parsed.receipt.sha);
    if (workspace.id !== known.id) {
      throw new Fault('sha_mismatch', 'Verifier receipt sha does not match the submitted sha.', 409);
    }
    if (workspace.agent_id === principal) throw new Fault('FORBIDDEN', 'The workspace author cannot merge their own submission.', 403);
    rejectSelfVerification(workspace.agent_id, parsed.receipt, parsed.verifierId);
    const sha = parsed.receipt.sha;
    const open = await openIntents(db);
    const mine = open.find(intent => intent.workspace_id === workspace.id && intent.receipt_id === receiptId && intent.sha === sha)
      ?? await partialIntent(db, workspace.id, receiptId, sha);
    if (open.some(intent => intent.id !== mine?.id)) throw mergeHold();
    if (!workspace.canonical_repo || !workspace.unit) throw new Fault('NOT_READY', 'Workspace merge fields are missing.', 503);
    const head = await repoHead(artifacts, workspace.canonical_repo);
    const messageFor = (intentId: string) => mergeMessage({
      sha,
      unit: workspace.unit ?? '',
      authorAgent: workspace.agent_id,
      verifier: parsed.receipt.acceptor_id,
      receiptId,
      intentId,
    });
    if (mine) {
      const ops = await fastForward.fastForwardLog(workspace.canonical_repo);
      const fenced = head === sha && provesIntent(mine, ops) ? await intentFence(db, mine.id) : null;
      if (fenced && acceptFenced(fenced, await currentGeneration(db))) {
        const message = messageFor(mine.id);
        await finishBookkeeping(db, principal, workspace, sha, receiptId, message, token);
        return mergeResult(workspace, taskId, receiptId, sha, message);
      }
      throw mergeHold();
    }
    if (head === sha) {
      throw new Fault('unproven_fast_forward', 'Canonical main is already at this sha without a recorded merge attempt for this submission.', 409);
    }
    if (head !== workspace.base_sha) {
      // TODO(WG-5): Sandbox rebase onto canonical main is out of scope.
      throw new Fault('needs_rebase', 'Canonical main is not at base_sha.', 409);
    }
    const intentId = await claimIntent(db, principal, workspace, receiptId, sha, head, token);
    const message = messageFor(intentId);
    await heldIntent(db, workspace.id, receiptId, sha, token);
    const generation = await currentGeneration(db);
    await markWriteOpen(db, principal, intentId, generation, token);
    try {
      await fencedForward(db, fastForward, workspace.canonical_repo, {
        ref: 'main', expectedHead: head, sha, message, lockGeneration: generation,
      }, intentId, token);
    } finally {
      await clearWriteOpen(db, intentId);
    }
    await finishBookkeeping(db, principal, workspace, sha, receiptId, message, token);
    return mergeResult(workspace, taskId, receiptId, sha, message);
  });
}

function mergeResult(workspace: WorkspaceRow, taskId: string, receiptId: string, sha: string, message: string): MergeResult {
  return {
    workspace_id: workspace.id,
    task_id: taskId,
    receipt_id: receiptId,
    sha,
    base_sha: workspace.base_sha,
    canonical_repo: workspace.canonical_repo ?? '',
    fast_forward: true,
    message,
  };
}

async function recordProvenMerge(db: Database, workspace: WorkspaceRow, intent: IntentRow, message: string, token: string): Promise<void> {
  const now = mergeClock.now();
  const existing = await db.prepare('SELECT sha, receipt_id FROM wrgit_merges WHERE workspace_id=?')
    .bind(workspace.id).first<{ sha: string; receipt_id: string }>();
  if (existing) {
    if (existing.sha !== intent.sha || existing.receipt_id !== intent.receipt_id) {
      throw new Fault('CONFLICT', 'Workspace already has a merge record.', 409);
    }
  } else {
    const inserted = await db.prepare(
      `INSERT INTO wrgit_merges(id, task_id, workspace_id, receipt_id, sha, base_sha, message, merged_at, stale)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1
       WHERE ${LOCK_HELD}
         AND EXISTS (SELECT 1 FROM wrgit_merge_intents WHERE id=? AND (outcome IS NULL OR outcome='not_merged'))
       RETURNING id`,
    ).bind(
      crypto.randomUUID(), intent.task_id, workspace.id, intent.receipt_id, intent.sha, workspace.base_sha, message, now,
      token, now, intent.id,
    ).all<{ id: string }>();
    if (inserted.results.length === 0) {
      if (!await lockHeld(db, token, mergeClock.now())) throw staleLock();
      throw new Fault('NOT_READY', 'Proven merge could not be recorded.', 503);
    }
  }
  await db.prepare(
    `UPDATE wrgit_workspaces
     SET head_sha=?, merged_sha=?, status='merged', merged_at=COALESCE(merged_at, ?)
     WHERE id=? AND status IN ('open', 'submitted', 'merged')
       AND (merged_sha IS NULL OR merged_sha=?)
       AND ${LOCK_HELD}`,
  ).bind(intent.sha, intent.sha, now, workspace.id, intent.sha, token, now).all();
  const settled = await db.prepare(
    `UPDATE wrgit_merge_intents SET outcome='merged', settled_at=?
     WHERE id=? AND (outcome IS NULL OR outcome='not_merged') AND ${LOCK_HELD}
     RETURNING id`,
  ).bind(now, intent.id, token, now).first<{ id: string }>();
  if (!settled) throw staleLock();
}

async function settleUnproven(db: Database, intentId: string, token: string): Promise<void> {
  const now = mergeClock.now();
  const settled = await db.prepare(
    `UPDATE wrgit_merge_intents SET outcome='not_merged', settled_at=?
     WHERE id=? AND outcome IS NULL
       AND NOT EXISTS (SELECT 1 FROM wrgit_merges WHERE workspace_id=wrgit_merge_intents.workspace_id)
       AND ${LOCK_HELD}
     RETURNING id`,
  ).bind(now, intentId, token, now).first<{ id: string }>();
  if (!settled) {
    if (!await lockHeld(db, token, mergeClock.now())) throw staleLock();
    throw new Fault('NOT_READY', 'Merge intent could not be settled.', 503);
  }
}

async function currentGeneration(db: Database): Promise<number> {
  const row = await db.prepare('SELECT generation FROM wrgit_merge_fence WHERE id=1').first<{ generation: number }>();
  if (row == null || !Number.isSafeInteger(row.generation)) throw new Fault('NOT_READY', 'Merge fence is not ready.', 503);
  return row.generation;
}

// The last statement before the external fast-forward. A revoke here settles the intent, so it holds nothing.
async function markWriteOpen(db: Database, principal: string, intentId: string, generation: number, token: string): Promise<void> {
  const now = mergeClock.now();
  const row = await db.prepare(
    `UPDATE wrgit_merge_intents SET write_open=1, write_open_at=?, lock_generation=?
     WHERE id=? AND ${LOCK_HELD} AND ${CAN_POST}
     RETURNING id`,
  ).bind(now, generation, intentId, token, now, principal, ROOM).first<{ id: string }>();
  if (row) return;
  if (!await canPost(db, principal)) {
    await settleUnproven(db, intentId, token);
    throw new Fault('FORBIDDEN', 'Room access denied.', 403);
  }
  throw staleLock();
}

async function clearWriteOpen(db: Database, intentId: string): Promise<void> {
  await db.prepare('UPDATE wrgit_merge_intents SET write_open=0 WHERE id=?').bind(intentId).all();
}

async function recordFenceFault(db: Database, intentId: string): Promise<void> {
  await db.prepare(`UPDATE wrgit_merge_intents SET fence_fault='stale_lock' WHERE id=?`).bind(intentId).all();
}

async function markFenceOk(db: Database, intentId: string): Promise<void> {
  await db.prepare(`UPDATE wrgit_merge_intents SET fence_ok=1, fence_fault=NULL WHERE id=?`).bind(intentId).all();
}

async function generationMatches(db: Database, token: string, lockGeneration: number): Promise<boolean> {
  if (!await lockHeld(db, token, mergeClock.now())) return false;
  return await currentGeneration(db) === lockGeneration;
}

type CompareAndSet = (repo: string, input: CanonicalFastForward) => Promise<{ ref: string; from: string; to: string; message: string }>;

function compareAndSetOf(artifacts: MergeArtifacts): CompareAndSet | null {
  const candidate = artifacts as MergeArtifacts & { compareAndSet?: unknown };
  if (typeof candidate.compareAndSet !== 'function') return null;
  return candidate.compareAndSet.bind(artifacts) as CompareAndSet;
}

async function lostFence(db: Database, intentId: string): Promise<never> {
  await recordFenceFault(db, intentId);
  throw staleLock();
}

async function lockTimeLeft(db: Database, token: string): Promise<number | null> {
  const now = mergeClock.now();
  const row = await db.prepare(
    'SELECT expires_at FROM wrgit_merge_lock WHERE id=1 AND holder=? AND expires_at>?',
  ).bind(token, now).first<{ expires_at: number }>();
  if (!row || !Number.isFinite(row.expires_at)) return null;
  return row.expires_at - now;
}

async function fencedForward(
  db: Database,
  artifacts: MergeArtifacts,
  repo: string,
  input: CanonicalFastForward,
  intentId: string,
  token: string,
): Promise<void> {
  const lockGeneration = input.lockGeneration;
  if (typeof lockGeneration !== 'number' || !await generationMatches(db, token, lockGeneration)) {
    return lostFence(db, intentId);
  }
  const budget = artifactsCallBudget((await lockTimeLeft(db, token)) ?? 0);
  if (budget.action === 'hold') return lostFence(db, intentId);
  const forwarded = { ...input, signal: lockAbortSignal(budget.timeoutMs) };
  const compareAndSet = compareAndSetOf(artifacts);
  if (compareAndSet) {
    try {
      await compareAndSet(repo, forwarded);
    } catch (error) {
      if (!isStaleLock(error)) throw error;
      return lostFence(db, intentId);
    }
    await markFenceOk(db, intentId);
    return;
  }
  try {
    await artifacts.fastForward(repo, forwarded);
  } catch (error) {
    if (!isStaleLock(error)) throw error;
    return lostFence(db, intentId);
  }
  if (!await generationMatches(db, token, lockGeneration)) return lostFence(db, intentId);
  await markFenceOk(db, intentId);
}

function acceptFenced(intent: IntentRow, generationBefore: number): boolean {
  if (intent.fence_fault === 'stale_lock') return false;
  if (Number(intent.fence_ok) === 1) return true;
  if (intent.lock_generation == null) return false;
  return Number(intent.lock_generation) === generationBefore;
}

function writeMayStillAct(intent: IntentRow, now: number): boolean {
  if (Number(intent.write_open) !== 1) return false;
  const opened = intent.write_open_at;
  if (typeof opened !== 'number' || !Number.isFinite(opened)) return true;
  return now - opened < WRITE_OPEN_LEASE_MS;
}

function refIsKnown(head: string | null, intent: IntentRow, submitted: string | null): boolean {
  if (head == null) return true;
  if (head === intent.sha) return true;
  if (submitted != null && head === submitted) return true;
  if (intent.expected_sha != null && head === intent.expected_sha) return true;
  return false;
}

type ChangedRows<T> = { results: T[]; meta?: { changes?: number } };

function changedRows(result: ChangedRows<unknown>): number {
  if (typeof result.meta?.changes === 'number') return result.meta.changes;
  return result.results.length;
}

export interface ReclaimResult {
  rowsChanged: number;
  wroteLease: boolean;
  ref: string | null;
  owner: string;
}

export async function reclaimWriteOpen(
  db: Database,
  artifacts: ArtifactsBinding,
  intentId: string,
  seenGeneration: number,
  owner: string,
): Promise<ReclaimResult> {
  const none = { rowsChanged: 0, wroteLease: false, ref: null, owner };
  if (!Number.isSafeInteger(seenGeneration) || seenGeneration < 0) return none;
  const updated = await db.prepare(
    'UPDATE wrgit_merge_fence SET generation = generation + 1 WHERE id = 1 AND generation = ? RETURNING generation',
  ).bind(seenGeneration).all<{ generation: number }>() as ChangedRows<{ generation: number }>;
  const rowsChanged = changedRows(updated);
  if (rowsChanged !== 1) return { ...none, rowsChanged };
  const nextGen = updated.results[0]?.generation;
  if (nextGen == null) return none;
  const intent = await intentFence(db, intentId);
  if (!intent) return { rowsChanged, wroteLease: false, ref: null, owner };
  const now = mergeClock.now();
  const lease = await db.prepare(
    'INSERT INTO wrgit_write_open_lease (intent_id, owner, generation, opened_at) VALUES (?, ?, ?, ?) RETURNING intent_id',
  ).bind(intentId, owner, nextGen, now).all<{ intent_id: string }>();
  await db.prepare('UPDATE wrgit_merge_intents SET write_open_owner=? WHERE id=?').bind(owner, intentId).all();
  const workspace = await workspaceById(db, intent.workspace_id);
  const repo = workspace?.canonical_repo;
  const ref = repo ? await repoHead(artifacts, repo) : null;
  return { rowsChanged, wroteLease: lease.results.length === 1, ref, owner };
}

export async function takeoverExpiredLease(
  db: Database,
  artifacts: ArtifactsBinding,
  intentId: string,
  owner: string,
): Promise<ReclaimResult> {
  const none = { rowsChanged: 0, wroteLease: false, ref: null, owner };
  const intent = await intentFence(db, intentId);
  if (!intent || writeMayStillAct(intent, mergeClock.now())) return none;
  return reclaimWriteOpen(db, artifacts, intentId, await currentGeneration(db), owner);
}

async function reconcilableIntents(db: Database): Promise<IntentRow[]> {
  const rows = await db.prepare(
    `SELECT id, workspace_id, task_id, receipt_id, sha, expected_sha, write_open, write_open_at, outcome, lock_generation, fence_fault, fence_ok
     FROM wrgit_merge_intents
     WHERE (outcome IS NULL OR outcome='not_merged')
       AND NOT EXISTS (SELECT 1 FROM wrgit_merges WHERE workspace_id=wrgit_merge_intents.workspace_id)`,
  ).all<IntentRow>();
  return rows.results;
}

export async function reconcileMergeIntents(db: Database, artifacts: ArtifactsBinding): Promise<{ recorded: number; released: number }> {
  const generationBefore = await currentGeneration(db);
  const api = writer(artifacts);
  return withMergeLock(db, async token => {
    const open = await reconcilableIntents(db);
    let recorded = 0;
    let released = 0;
    for (const intent of open) {
      const workspace = await workspaceById(db, intent.workspace_id);
      const repo = workspace?.canonical_repo;
      const ops = repo ? await api.fastForwardLog(repo) : [];
      const matched = matchingFastForwards(intent, ops);
      if (matched.length > 1) continue;
      const proof = matched[0];
      const head = repo ? await repoHead(api, repo) : null;
      const submitted = workspace?.submitted_sha ?? null;
      if (!refIsKnown(head, intent, submitted)) continue;
      if (workspace && proof && head === intent.sha && acceptFenced(intent, generationBefore)) {
        await recordProvenMerge(db, workspace, intent, proof.message, token);
        recorded += 1;
        continue;
      }
      if (Number(intent.write_open) === 1 && !writeMayStillAct(intent, mergeClock.now())) {
        const claim = await reclaimWriteOpen(db, api, intent.id, await currentGeneration(db), 'reconcile');
        if (claim.rowsChanged !== 1) continue;
        const landed = workspace && claim.ref === intent.sha && provesIntent(intent, ops) && proof;
        if (landed && proof) {
          await recordProvenMerge(db, workspace, intent, proof.message, token);
          recorded += 1;
          continue;
        }
      }
      if (intent.outcome === 'not_merged' || writeMayStillAct(intent, mergeClock.now()) || proof) continue;
      await settleUnproven(db, intent.id, token);
      released += 1;
    }
    return { recorded, released };
  });
}

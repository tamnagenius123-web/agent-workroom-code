// WR-GIT D1 index. Artifacts stores the git objects. These helpers store the workspace,
// the attributed push, and the singleton merge lock. Lock time is unix milliseconds.
// A holder may renew before expiry. Another holder may take the row once expires_at <= now.
import { Fault } from '../contracts.ts';
import type { Database } from '../db.ts';

export const WORKSPACE_STATUSES = ['open', 'submitted', 'merged', 'canceled'] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export interface WrgitWorkspace {
  id: string;
  task_id: string;
  agent_id: string;
  repo: string;
  base_sha: string;
  head_sha: string | null;
  status: WorkspaceStatus;
  created_at: number;
  merged_at: number | null;
}

export interface NewWorkspace {
  id: string;
  task_id: string;
  agent_id: string;
  repo: string;
  base_sha: string;
  created_at: number;
  canonical_repo?: string;
  unit?: string;
}

export interface WrgitCommit {
  repo: string;
  sha: string;
  agent_id: string;
  task_id: string;
  pushed_at: number;
}

export interface WrgitMergeLock {
  id: 1;
  holder: string | null;
  acquired_at: number | null;
  expires_at: number | null;
}

export interface AcquireMergeLockInput {
  holder: string;
  ttlMs: number;
  nowMs: number;
}

export interface MergeLockAcquire {
  acquired: boolean;
  lock: WrgitMergeLock;
}

export interface MergeLockRelease {
  released: boolean;
  lock: WrgitMergeLock;
}

interface WorkspaceRow {
  id: string;
  task_id: string;
  agent_id: string;
  repo: string;
  base_sha: string;
  head_sha: string | null;
  status: string;
  created_at: number;
  merged_at: number | null;
}

interface LockRow {
  id: number;
  holder: string | null;
  acquired_at: number | null;
  expires_at: number | null;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
const WORKSPACE_COLS = 'id, task_id, agent_id, repo, base_sha, head_sha, status, created_at, merged_at';
const COMMIT_COLS = 'repo, sha, agent_id, task_id, pushed_at';
const LOCK_COLS = 'id, holder, acquired_at, expires_at';

function textId(value: string, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || value.includes('\0')) {
    throw new Fault('INVALID_INPUT', `${label} is invalid.`);
  }
  return value;
}

function shaOf(value: string, label: string): string {
  if (typeof value !== 'string' || !SHA_RE.test(value)) throw new Fault('INVALID_INPUT', `${label} must be a 40-character git sha.`);
  return value;
}

function repoName(value: string): string {
  if (typeof value !== 'string' || !REPO_RE.test(value)) throw new Fault('INVALID_INPUT', 'repo is invalid.');
  return value;
}

function millis(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Fault('INVALID_INPUT', `${label} must be a unix millisecond timestamp.`);
  }
  return value;
}

function ttlMs(value: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Fault('INVALID_INPUT', 'ttlMs must be a positive integer.');
  }
  return value;
}

function isUnique(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

function workspaceFrom(row: WorkspaceRow): WrgitWorkspace {
  if (!WORKSPACE_STATUSES.includes(row.status as WorkspaceStatus)) {
    throw new Fault('NOT_READY', 'Workspace status is not recognized.', 503);
  }
  return {
    id: row.id,
    task_id: row.task_id,
    agent_id: row.agent_id,
    repo: row.repo,
    base_sha: row.base_sha,
    head_sha: row.head_sha,
    status: row.status as WorkspaceStatus,
    created_at: row.created_at,
    merged_at: row.merged_at,
  };
}

function lockFrom(row: LockRow): WrgitMergeLock {
  if (row.id !== 1) throw new Fault('NOT_READY', 'Merge lock is not ready.', 503);
  return { id: 1, holder: row.holder, acquired_at: row.acquired_at, expires_at: row.expires_at };
}

function conflict(message: string): Fault {
  return new Fault('CONFLICT', message, 409);
}

async function requireWorkspace(db: Database, id: string): Promise<WrgitWorkspace> {
  const found = await getWorkspace(db, id);
  if (!found) throw new Fault('NOT_FOUND', 'Workspace not found.', 404);
  return found;
}

async function mergeColumnsPresent(db: Database): Promise<boolean> {
  const info = await db.prepare("SELECT name FROM pragma_table_info('wrgit_workspaces')").all<{ name: string }>();
  const names = new Set(info.results.map(row => row.name));
  return names.has('canonical_repo') && names.has('unit');
}

function boundedText(value: string | undefined, label: string, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0')) {
    throw new Fault('INVALID_INPUT', `${label} is invalid.`);
  }
  return value;
}

export async function createWorkspace(db: Database, input: NewWorkspace): Promise<WrgitWorkspace> {
  const row = {
    id: textId(input.id, 'id'),
    task_id: textId(input.task_id, 'task_id'),
    agent_id: textId(input.agent_id, 'agent_id'),
    repo: repoName(input.repo),
    base_sha: shaOf(input.base_sha, 'base_sha'),
    created_at: millis(input.created_at, 'created_at'),
  };
  // 0063 (WG-5) adds these columns. WG-3 does not ship that migration. Fill them when present.
  const merge = await mergeColumnsPresent(db);
  const canonical = merge ? boundedText(input.canonical_repo, 'canonical_repo', 200) : null;
  const unit = merge ? boundedText(input.unit, 'unit', 128) : null;
  try {
    const stored = merge
      ? await db.prepare(
        `INSERT INTO wrgit_workspaces (id, task_id, agent_id, repo, base_sha, head_sha, status, created_at, merged_at, canonical_repo, unit)
         VALUES (?, ?, ?, ?, ?, NULL, 'open', ?, NULL, ?, ?) RETURNING ${WORKSPACE_COLS}`,
      ).bind(row.id, row.task_id, row.agent_id, row.repo, row.base_sha, row.created_at, canonical, unit).first<WorkspaceRow>()
      : await db.prepare(
        `INSERT INTO wrgit_workspaces (id, task_id, agent_id, repo, base_sha, head_sha, status, created_at, merged_at)
         VALUES (?, ?, ?, ?, ?, NULL, 'open', ?, NULL) RETURNING ${WORKSPACE_COLS}`,
      ).bind(row.id, row.task_id, row.agent_id, row.repo, row.base_sha, row.created_at).first<WorkspaceRow>();
    if (!stored) throw new Fault('NOT_READY', 'Workspace was not stored.', 503);
    return workspaceFrom(stored);
  } catch (error) {
    if (error instanceof Fault) throw error;
    if (isUnique(error)) throw conflict('Workspace id or repo already exists.');
    throw error;
  }
}

// Fills only a null canonical_repo or unit. A stored value is left as it is.
// derive runs before the write, so a refusal leaves the row unchanged.
export async function fillMissingMergeFields(
  db: Database,
  row: { id: string; task_id: string; agent_id: string; repo: string },
  derive: {
    canonicalRepo: (row: { id: string; task_id: string; agent_id: string; repo: string }) => string;
    unit: (row: { task_id: string }) => string;
  },
): Promise<void> {
  if (!await mergeColumnsPresent(db)) return;
  const key = textId(row.id, 'id');
  const stored = await db.prepare('SELECT canonical_repo, unit FROM wrgit_workspaces WHERE id=?').bind(key).first<{ canonical_repo: string | null; unit: string | null }>();
  if (!stored) throw new Fault('NOT_FOUND', 'Workspace not found.', 404);
  if (stored.canonical_repo !== null && stored.unit !== null) return;
  const canonical = stored.canonical_repo ?? boundedText(derive.canonicalRepo(row), 'canonical_repo', 200);
  const unit = stored.unit ?? boundedText(derive.unit(row), 'unit', 128);
  await db.prepare(
    `UPDATE wrgit_workspaces SET canonical_repo=COALESCE(canonical_repo, ?), unit=COALESCE(unit, ?)
     WHERE id=? AND (canonical_repo IS NULL OR unit IS NULL)`,
  ).bind(canonical, unit, key).all();
  const after = await db.prepare('SELECT canonical_repo, unit FROM wrgit_workspaces WHERE id=?').bind(key).first<{ canonical_repo: string | null; unit: string | null }>();
  if (!after?.canonical_repo || !after.unit) throw new Fault('NOT_READY', 'Workspace merge fields could not be stored.', 503);
}

export async function getWorkspace(db: Database, id: string): Promise<WrgitWorkspace | null> {
  const key = textId(id, 'id');
  const row = await db.prepare(`SELECT ${WORKSPACE_COLS} FROM wrgit_workspaces WHERE id=?`).bind(key).first<WorkspaceRow>();
  return row ? workspaceFrom(row) : null;
}

export async function listWorkspacesByTask(db: Database, taskId: string): Promise<WrgitWorkspace[]> {
  const key = textId(taskId, 'task_id');
  const rows = await db.prepare(
    `SELECT ${WORKSPACE_COLS} FROM wrgit_workspaces WHERE task_id=? ORDER BY created_at ASC, id ASC`,
  ).bind(key).all<WorkspaceRow>();
  return rows.results.map(workspaceFrom);
}

export async function setWorkspaceHead(db: Database, input: { id: string; head_sha: string }): Promise<WrgitWorkspace> {
  const head = shaOf(input.head_sha, 'head_sha');
  const current = await requireWorkspace(db, input.id);
  if (current.head_sha === head) return current;
  if (current.status !== 'open') throw conflict('Workspace status does not allow this change.');
  const row = await db.prepare(
    `UPDATE wrgit_workspaces SET head_sha=? WHERE id=? AND status='open' RETURNING ${WORKSPACE_COLS}`,
  ).bind(head, current.id).first<WorkspaceRow>();
  if (!row) throw conflict('Workspace status does not allow this change.');
  return workspaceFrom(row);
}

export async function markWorkspaceSubmitted(db: Database, id: string): Promise<WrgitWorkspace> {
  const current = await requireWorkspace(db, id);
  if (current.status === 'submitted') return current;
  if (current.status !== 'open' || current.head_sha === null) throw conflict('Workspace status does not allow this change.');
  const row = await db.prepare(
    `UPDATE wrgit_workspaces SET status='submitted' WHERE id=? AND status='open' AND head_sha IS NOT NULL RETURNING ${WORKSPACE_COLS}`,
  ).bind(current.id).first<WorkspaceRow>();
  if (!row) throw conflict('Workspace status does not allow this change.');
  return workspaceFrom(row);
}

export async function markWorkspaceMerged(db: Database, input: { id: string; merged_at: number }): Promise<WrgitWorkspace> {
  const current = await requireWorkspace(db, input.id);
  const mergedAt = millis(input.merged_at, 'merged_at');
  if (mergedAt < current.created_at) throw new Fault('INVALID_INPUT', 'merged_at is before created_at.');
  if (current.status === 'merged') {
    if (current.merged_at !== mergedAt) throw conflict('Workspace is already merged at a different time.');
    return current;
  }
  if (current.status !== 'submitted') throw conflict('Workspace status does not allow this change.');
  const row = await db.prepare(
    `UPDATE wrgit_workspaces SET status='merged', merged_at=? WHERE id=? AND status='submitted' RETURNING ${WORKSPACE_COLS}`,
  ).bind(mergedAt, current.id).first<WorkspaceRow>();
  if (!row) throw conflict('Workspace status does not allow this change.');
  return workspaceFrom(row);
}

export async function markWorkspaceCanceled(db: Database, id: string): Promise<WrgitWorkspace> {
  const current = await requireWorkspace(db, id);
  if (current.status === 'canceled') return current;
  if (current.status !== 'open' && current.status !== 'submitted') throw conflict('Workspace status does not allow this change.');
  const row = await db.prepare(
    `UPDATE wrgit_workspaces SET status='canceled' WHERE id=? AND status IN ('open', 'submitted') RETURNING ${WORKSPACE_COLS}`,
  ).bind(current.id).first<WorkspaceRow>();
  if (!row) throw conflict('Workspace status does not allow this change.');
  return workspaceFrom(row);
}

async function getCommit(db: Database, repo: string, sha: string): Promise<WrgitCommit | null> {
  return db.prepare(`SELECT ${COMMIT_COLS} FROM wrgit_commits WHERE repo=? AND sha=?`).bind(repo, sha).first<WrgitCommit>();
}

function sameCommit(existing: WrgitCommit, incoming: WrgitCommit): WrgitCommit {
  if (existing.agent_id !== incoming.agent_id || existing.task_id !== incoming.task_id) {
    throw conflict('Commit is already attributed to another agent or task.');
  }
  return existing;
}

export async function recordCommit(db: Database, input: WrgitCommit): Promise<WrgitCommit> {
  const row: WrgitCommit = {
    repo: repoName(input.repo),
    sha: shaOf(input.sha, 'sha'),
    agent_id: textId(input.agent_id, 'agent_id'),
    task_id: textId(input.task_id, 'task_id'),
    pushed_at: millis(input.pushed_at, 'pushed_at'),
  };
  const existing = await getCommit(db, row.repo, row.sha);
  if (existing) return sameCommit(existing, row);
  try {
    await db.prepare(
      `INSERT INTO wrgit_commits (repo, sha, agent_id, task_id, pushed_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(row.repo, row.sha, row.agent_id, row.task_id, row.pushed_at).all();
  } catch (error) {
    if (!isUnique(error)) throw error;
    const again = await getCommit(db, row.repo, row.sha);
    if (again) return sameCommit(again, row);
    throw error;
  }
  return row;
}

export async function listCommits(db: Database, repo: string): Promise<WrgitCommit[]> {
  const key = repoName(repo);
  const rows = await db.prepare(
    `SELECT ${COMMIT_COLS} FROM wrgit_commits WHERE repo=? ORDER BY pushed_at ASC, sha ASC`,
  ).bind(key).all<WrgitCommit>();
  return rows.results;
}

export async function readMergeLock(db: Database): Promise<WrgitMergeLock> {
  const row = await db.prepare(`SELECT ${LOCK_COLS} FROM wrgit_merge_lock WHERE id=1`).first<LockRow>();
  if (!row) throw new Fault('NOT_READY', 'Merge lock is not ready.', 503);
  return lockFrom(row);
}

export async function acquireMergeLock(db: Database, input: AcquireMergeLockInput): Promise<MergeLockAcquire> {
  const holder = textId(input.holder, 'holder');
  const ttl = ttlMs(input.ttlMs);
  const now = millis(input.nowMs, 'nowMs');
  if (!Number.isSafeInteger(now + ttl)) throw new Fault('INVALID_INPUT', 'ttlMs is too large.');
  const expires = now + ttl;
  // Same holder renews. A different holder takes the row only after expiry, including the exact instant.
  const row = await db.prepare(
    `UPDATE wrgit_merge_lock SET holder=?, acquired_at=?, expires_at=?
     WHERE id=1 AND (holder IS NULL OR holder=? OR expires_at<=?)
     RETURNING ${LOCK_COLS}`,
  ).bind(holder, now, expires, holder, now).first<LockRow>();
  if (row) return { acquired: true, lock: lockFrom(row) };
  return { acquired: false, lock: await readMergeLock(db) };
}

function cleanRemote(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500) throw new Fault('INVALID_INPUT', 'remote_url is invalid.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Fault('INVALID_INPUT', 'remote_url is invalid.'); }
  if (url.username || url.password || url.searchParams.has('token') || url.protocol !== 'https:') {
    throw new Fault('INVALID_INPUT', 'remote_url is invalid.');
  }
  return url.toString();
}

export async function getWorkspaceRemote(db: Database, id: string): Promise<string | null> {
  const key = textId(id, 'id');
  const row = await db.prepare('SELECT remote_url FROM wrgit_workspaces WHERE id=?').bind(key).first<{ remote_url: string | null }>();
  return row?.remote_url ?? null;
}

export async function setWorkspaceRemote(db: Database, id: string, remoteUrl: string): Promise<string> {
  const key = textId(id, 'id');
  const remote = cleanRemote(remoteUrl);
  const row = await db.prepare('SELECT remote_url FROM wrgit_workspaces WHERE id=?').bind(key).first<{ remote_url: string | null }>();
  if (!row) throw new Fault('NOT_FOUND', 'Workspace not found.', 404);
  if (row.remote_url !== null) return row.remote_url;
  await db.prepare('UPDATE wrgit_workspaces SET remote_url=? WHERE id=? AND remote_url IS NULL').bind(remote, key).all();
  return remote;
}

export interface WorkspacePending {
  task_id: string;
  agent_id: string;
  repo: string;
  created_at: number;
}

export async function upsertWorkspacePending(db: Database, input: WorkspacePending): Promise<void> {
  const row = {
    task_id: textId(input.task_id, 'task_id'),
    agent_id: textId(input.agent_id, 'agent_id'),
    repo: repoName(input.repo),
    created_at: millis(input.created_at, 'created_at'),
  };
  await db.prepare(
    `INSERT INTO wrgit_workspace_pending (task_id, agent_id, repo, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(task_id, agent_id) DO UPDATE SET repo=excluded.repo`,
  ).bind(row.task_id, row.agent_id, row.repo, row.created_at).all();
}

export async function getWorkspacePending(db: Database, taskId: string, agentId: string): Promise<WorkspacePending | null> {
  const task = textId(taskId, 'task_id');
  const agent = textId(agentId, 'agent_id');
  return db.prepare(
    'SELECT task_id, agent_id, repo, created_at FROM wrgit_workspace_pending WHERE task_id=? AND agent_id=?',
  ).bind(task, agent).first<WorkspacePending>();
}

export async function deleteWorkspacePending(db: Database, taskId: string, agentId: string): Promise<void> {
  const task = textId(taskId, 'task_id');
  const agent = textId(agentId, 'agent_id');
  await db.prepare('DELETE FROM wrgit_workspace_pending WHERE task_id=? AND agent_id=?').bind(task, agent).all();
}

export async function releaseMergeLock(db: Database, input: { holder: string }): Promise<MergeLockRelease> {
  const holder = textId(input.holder, 'holder');
  const row = await db.prepare(
    `UPDATE wrgit_merge_lock SET holder=NULL, acquired_at=NULL, expires_at=NULL
     WHERE id=1 AND holder=? RETURNING ${LOCK_COLS}`,
  ).bind(holder).first<LockRow>();
  if (row) return { released: true, lock: lockFrom(row) };
  return { released: false, lock: await readMergeLock(db) };
}

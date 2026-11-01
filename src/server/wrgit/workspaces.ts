import { createHash } from 'node:crypto';
import { Fault, ROOM } from '../contracts.ts';
import { AUTH } from '../policy.ts';
import { DB_NOW } from '../tasks.ts';
import type { Database, Env, Statement, Value } from '../db.ts';
import type { ArtifactsBinding, ArtifactsRepoRef } from './artifacts-binding.ts';
import { createWorkspace, deleteWorkspacePending, fillMissingMergeFields, getWorkspace, getWorkspaceRemote, setWorkspaceRemote, upsertWorkspacePending, type WrgitWorkspace } from './store.ts';

// Native repo names allow only letters, digits, dots, hyphens, and underscores. The namespace is already `workroom`.
export const WRGIT_CANONICAL_REPO = 'agent-workroom';
// Write tokens are not revocable through the binding; the ttl bounds how long a disclosed token outlives its lease.
export const WRGIT_TOKEN_TTL_S = 900;
export const WRGIT_NAMESPACE = 'workroom';

// Sanitizing punctuation maps agent:a and agent-a onto one string. The repo name is the
// sha256 of a length-prefixed pair, so distinct principals never share a workspace.
export function workspaceRepoName(taskId: string, agentId: string): string {
  const digest = createHash('sha256').update(`${taskId.length}:${taskId}`, 'utf8').update(`${agentId.length}:${agentId}`, 'utf8').digest('hex');
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Fault('INVALID_INPUT', 'Workspace repo name is not valid.');
  return digest;
}

// Insert lands only when `fresh` is true, which is the claim operation row in the same batch.
export function pendingMarkerStatement(db: Database, fresh: string, args: Value[], taskId: string, agentId: string): Statement {
  const repo = workspaceRepoName(taskId, agentId);
  return db.prepare(
    `INSERT INTO wrgit_workspace_pending (task_id, agent_id, repo, created_at)
     SELECT ?, ?, ?, ? WHERE ${fresh}
     ON CONFLICT(task_id, agent_id) DO UPDATE SET repo=excluded.repo`,
  ).bind(taskId, agentId, repo, Date.now(), ...args);
}

interface ReadyWorkspace extends WrgitWorkspace {
  remote_url: string;
}

function fallbackRemote(repo: string): string {
  return `https://artifacts.cloudflare.net/${WRGIT_NAMESPACE}/${repo}.git`;
}

// Clone URLs returned to clients and stored in D1 never carry userinfo or a token query.
function publicRemote(remote: string, repo: string): string {
  try {
    const url = new URL(remote);
    url.username = '';
    url.password = '';
    url.searchParams.delete('token');
    url.hash = '';
    if (url.protocol !== 'https:') return fallbackRemote(repo);
    return url.toString();
  } catch {
    return fallbackRemote(repo);
  }
}

function artifactsDown(error: unknown): Fault {
  if (error instanceof Fault) return error;
  return new Fault('UNAVAILABLE', 'Artifacts request failed.', 503, 'unknown', true);
}

function missingRepo(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return message === 'NOT_FOUND';
}

async function binding(artifacts: ArtifactsBinding | undefined): Promise<ArtifactsBinding> {
  if (!artifacts) throw new Fault('UNAVAILABLE', 'Artifacts binding is not configured.', 503, 'unknown', true);
  try { await artifacts.get(WRGIT_CANONICAL_REPO); }
  catch (error) { throw artifactsDown(error); }
  return artifacts;
}

export async function prepareWrgit(artifacts: ArtifactsBinding | undefined): Promise<void> {
  await binding(artifacts);
}

async function readyFrom(env: Env, row: WrgitWorkspace, repo: string): Promise<ReadyWorkspace> {
  const remote = await getWorkspaceRemote(env.DB, row.id);
  return { ...row, remote_url: remote ?? fallbackRemote(repo) };
}

// The task version trigger only allows version+1, and operation rows are append-only, so a
// claim cannot be rolled back. The pending marker is inserted in the same D1 batch as the
// claim, before any Artifacts call. A failure after that batch (binding lookup, fork, or the
// workspace row write) leaves the task in_progress with the marker. A later claim, claimNext,
// or POST /git/workspaces by the holder calls ensureWorkspace again and finishes the fork.
// The marker is deleted only after the workspace row exists.
// canonical_repo and unit are WG-5 columns (migration 0063, not added here). A new row stores
// the fork source and the task id when those columns exist. Reopen fills a null from the stored
// row and leaves a value that is already stored unchanged.
export function deriveWorkspaceUnit(row: { task_id: string }): string {
  if (typeof row.task_id !== 'string' || row.task_id.length < 1 || row.task_id.length > 128 || row.task_id.includes('\0')) {
    throw new Fault('NOT_READY', 'Workspace unit cannot be derived from the stored task.', 503);
  }
  return row.task_id;
}

export function deriveWorkspaceCanonicalRepo(row: { id: string; task_id: string; agent_id: string; repo: string }): string {
  const digest = workspaceRepoName(row.task_id, row.agent_id);
  if (row.id !== digest || row.repo !== digest) {
    throw new Fault('NOT_READY', 'Workspace canonical repo cannot be derived from the stored task and agent.', 503);
  }
  return WRGIT_CANONICAL_REPO;
}

async function fillMergeFields(env: Env, row: WrgitWorkspace): Promise<void> {
  await fillMissingMergeFields(env.DB, row, { canonicalRepo: deriveWorkspaceCanonicalRepo, unit: deriveWorkspaceUnit });
}

export async function ensureWorkspace(env: Env, binder: ArtifactsBinding | undefined, taskId: string, agentId: string): Promise<ReadyWorkspace> {
  const repo = workspaceRepoName(taskId, agentId);
  const storeId = repo;
  const existing = await getWorkspace(env.DB, storeId);
  if (!existing) {
    const other = await env.DB.prepare(
      'SELECT id, repo FROM wrgit_workspaces WHERE task_id=? AND agent_id=? LIMIT 1',
    ).bind(taskId, agentId).first<{ id: string; repo: string }>();
    if (other && (other.id !== repo || other.repo !== repo)) {
      throw new Fault('NOT_READY', 'Workspace canonical repo cannot be derived from the stored task and agent.', 503);
    }
  }
  const artifacts = await binding(binder);
  if (existing) {
    if (existing.task_id !== taskId || existing.agent_id !== agentId) throw new Fault('TASK_CONFLICT', 'Workspace id is already in use.', 409);
    await fillMergeFields(env, existing);
    await deleteWorkspacePending(env.DB, taskId, agentId);
    return readyFrom(env, existing, repo);
  }
  await upsertWorkspacePending(env.DB, { task_id: taskId, agent_id: agentId, repo, created_at: Date.now() });
  let forked: ArtifactsRepoRef;
  try { forked = await artifacts.fork(WRGIT_CANONICAL_REPO, repo); }
  catch (error) {
    try {
      const raced = await artifacts.get(repo);
      forked = { name: raced.name, remote: raced.remote, defaultBranch: raced.defaultBranch, token: '' };
    } catch (getError) {
      if (missingRepo(getError)) throw artifactsDown(error);
      throw artifactsDown(getError);
    }
  }
  let baseSha: string | undefined;
  try { baseSha = (await artifacts.log(repo))[0]?.hash; }
  catch (error) { throw artifactsDown(error); }
  if (!baseSha) throw new Fault('UNAVAILABLE', 'Fork has no base commit.', 503, 'unknown', true);
  const remote = publicRemote(forked.remote, repo);
  try {
    const created = await createWorkspace(env.DB, {
      id: storeId, task_id: taskId, agent_id: agentId, repo, base_sha: baseSha, created_at: Date.now(),
      canonical_repo: WRGIT_CANONICAL_REPO, unit: taskId,
    });
    const storedRemote = await setWorkspaceRemote(env.DB, created.id, remote);
    await deleteWorkspacePending(env.DB, taskId, agentId);
    return { ...created, remote_url: storedRemote };
  } catch (error) {
    if (!(error instanceof Fault) || error.code !== 'CONFLICT') throw artifactsDown(error);
    const winner = await getWorkspace(env.DB, storeId);
    if (!winner || winner.task_id !== taskId || winner.agent_id !== agentId) throw new Fault('TASK_CONFLICT', 'Workspace id is already in use.', 409);
    await fillMergeFields(env, winner);
    await deleteWorkspacePending(env.DB, taskId, agentId);
    return readyFrom(env, winner, repo);
  }
}

export async function pendingHeldTask(env: Env, agentId: string, taskId?: string): Promise<string | null> {
  const row = taskId
    ? await env.DB.prepare(
      `SELECT p.task_id AS task_id FROM wrgit_workspace_pending p
       JOIN tasks t ON t.id=p.task_id JOIN task_leases l ON l.task_id=t.id
       WHERE p.agent_id=? AND p.task_id=? AND t.state='in_progress' AND l.holder_id=?`,
    ).bind(agentId, taskId, agentId).first<{ task_id: string }>()
    : await env.DB.prepare(
      `SELECT p.task_id AS task_id FROM wrgit_workspace_pending p
       JOIN tasks t ON t.id=p.task_id JOIN task_leases l ON l.task_id=t.id
       WHERE p.agent_id=? AND t.state='in_progress' AND l.holder_id=?
       ORDER BY p.created_at ASC, p.task_id ASC LIMIT 1`,
    ).bind(agentId, agentId).first<{ task_id: string }>();
  return row?.task_id ?? null;
}

// The opener must hold a live lease on an in_progress task and still have can_post=1.
// D1 cannot hold this across the external fork and mint, so open checks it before the fork,
// again before the mint, and again after the mint. A token minted across a revoke or a lease
// change is withheld: it is never returned, and it expires after WRGIT_TOKEN_TTL_S.
async function liveClaimant(env: Env, taskId: string, agentId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM tasks t JOIN task_leases l ON l.task_id=t.id
     WHERE t.id=? AND t.state='in_progress' AND l.holder_id=? AND l.expires_at_ms>${DB_NOW}
       AND EXISTS (${AUTH} AND m.can_post=1)`,
  ).bind(taskId, agentId, agentId, ROOM).first<{ ok: number }>();
  return row !== null;
}

async function requireClaimant(env: Env, taskId: string, agentId: string): Promise<void> {
  if (!await liveClaimant(env, taskId, agentId)) throw new Fault('FORBIDDEN', 'Only the task claimant can open its workspace.', 403);
}

export async function openWorkspace(env: Env, binder: ArtifactsBinding | undefined, taskId: string, agentId: string): Promise<{ remote_url: string; token: string; base_sha: string }> {
  const found = await env.DB.prepare('SELECT id FROM tasks WHERE id=?').bind(taskId).first<{ id: string }>();
  if (!found) throw new Fault('NOT_FOUND', 'Task not found.', 404);
  await requireClaimant(env, taskId, agentId);
  const row = await ensureWorkspace(env, binder, taskId, agentId);
  await requireClaimant(env, taskId, agentId);
  const artifacts = await binding(binder);
  let issued: { token: string; scope: string };
  try { issued = await artifacts.issueToken(row.repo, 'write', WRGIT_TOKEN_TTL_S); }
  catch { throw new Fault('UNAVAILABLE', 'Artifacts request failed.', 503, 'unknown', true); }
  if (issued.scope !== 'write' || !issued.token) throw new Fault('UNAVAILABLE', 'Artifacts request failed.', 503, 'unknown', true);
  await requireClaimant(env, taskId, agentId);
  return { remote_url: row.remote_url, token: issued.token, base_sha: row.base_sha };
}

export async function readWorkspace(env: Env, binder: ArtifactsBinding | undefined, id: string) {
  const artifacts = await binding(binder);
  const row = await getWorkspace(env.DB, id);
  if (!row) throw new Fault('NOT_FOUND', 'Workspace not found.', 404);
  const remote = (await getWorkspaceRemote(env.DB, row.id)) ?? fallbackRemote(row.repo);
  let status = 'ready';
  let head = row.base_sha;
  let commits = 0;
  try { await artifacts.get(row.repo); }
  catch (error) {
    if (!missingRepo(error)) throw artifactsDown(error);
    status = 'missing';
  }
  if (status === 'ready') {
    try {
      const log = await artifacts.log(row.repo);
      if (log[0]) head = log[0].hash;
      for (const commit of log) {
        if (commit.hash === row.base_sha) break;
        commits += 1;
      }
    } catch (error) { throw artifactsDown(error); }
  }
  return {
    id: row.id, task_id: row.task_id, agent_id: row.agent_id, repo: row.repo, status,
    remote_url: remote, base_sha: row.base_sha, head_sha: head, diff_stat: { commits },
  };
}

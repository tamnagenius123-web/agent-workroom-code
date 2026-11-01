import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import { MIGRATION_REGISTRY } from '../src/phase-contracts/migrations.ts';
import {
  ARTIFACTS_OPS, assertArtifactsBinding,
  type ArtifactsBinding, type ArtifactsCommit, type ArtifactsLogOptions,
  type ArtifactsRepoInfo, type ArtifactsRepoRef, type ArtifactsToken,
} from '../src/server/wrgit/artifacts-binding.ts';
import {
  acquireMergeLock, createWorkspace, getWorkspace, listCommits, listWorkspacesByTask,
  markWorkspaceCanceled, markWorkspaceMerged, markWorkspaceSubmitted, readMergeLock, recordCommit,
  releaseMergeLock, setWorkspaceHead,
} from '../src/server/wrgit/store.ts';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const utf8 = new TextEncoder();

async function database(): Promise<{ db: Database; close: () => Promise<void> }> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: 'wrgit-' + crypto.randomUUID() },
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const raw = await mf.getD1Database('DB');
  await migrate(raw, 9999);
  return { db: raw as Database, close: () => mf.dispose() };
}

async function columns(db: Database, table: string): Promise<string[]> {
  const rows = await db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all<{ name: string }>();
  return rows.results.map(row => row.name);
}

async function faultCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof Fault, error instanceof Error ? error.message : String(error));
    return error.code;
  }
  assert.fail('expected Fault');
}

function workspace(id: string, repo: string, created_at: number, task_id = 'task-1') {
  return {
    id, task_id, agent_id: 'agent:wg2', repo, base_sha: BASE, created_at,
    canonical_repo: 'main/agent-workroom', unit: task_id,
  };
}

test('0061 migration creates wrgit tables, the singleton merge lock, and registry row', async () => {
  const registry = await readFile('migrations/REGISTRY.md', 'utf8');
  assert.match(registry, /^\| 0061 \| .*0061_wrgit\.sql.* \| used \|$/m);
  assert.match(registry, /^merge_order:.*\b0060 0061\b/m);
  const allocated = (MIGRATION_REGISTRY as Record<string, { status: string; unit: string }>)['0061'];
  assert.equal(allocated?.status, 'used');
  assert.match(allocated?.unit ?? '', /0061_wrgit\.sql/);

  const { db, close } = await database();
  try {
    assert.deepEqual(await columns(db, 'wrgit_workspaces'), [
      'id', 'task_id', 'agent_id', 'repo', 'base_sha', 'head_sha', 'status', 'created_at', 'merged_at',
      'remote_url', 'canonical_repo', 'unit', 'submitted_sha', 'merged_sha',
    ]);
    assert.deepEqual(await columns(db, 'wrgit_commits'), ['repo', 'sha', 'agent_id', 'task_id', 'pushed_at']);
    assert.deepEqual(await columns(db, 'wrgit_merge_lock'), ['id', 'holder', 'acquired_at', 'expires_at']);
    const pk = await db.prepare("SELECT name FROM pragma_table_info('wrgit_commits') WHERE pk > 0 ORDER BY pk").all<{ name: string }>();
    assert.deepEqual(pk.results.map(row => row.name), ['repo', 'sha']);
    const locks = await db.prepare('SELECT id, holder, acquired_at, expires_at FROM wrgit_merge_lock').all<{
      id: number; holder: string | null; acquired_at: number | null; expires_at: number | null;
    }>();
    assert.deepEqual(locks.results, [{ id: 1, holder: null, acquired_at: null, expires_at: null }]);
    await assert.rejects(
      () => db.prepare('INSERT INTO wrgit_merge_lock (id, holder, acquired_at, expires_at) VALUES (2, NULL, NULL, NULL)').all(),
      /CHECK constraint failed/,
    );
    await db.prepare('INSERT INTO wrgit_commits (repo, sha, agent_id, task_id, pushed_at) VALUES (?, ?, ?, ?, ?)').bind('r', BASE, 'agent:wg2', 'task-1', 1).all();
    await assert.rejects(
      () => db.prepare('INSERT INTO wrgit_commits (repo, sha, agent_id, task_id, pushed_at) VALUES (?, ?, ?, ?, ?)').bind('r', BASE, 'agent:other', 'task-2', 2).all(),
      /UNIQUE constraint failed/,
    );
    await assert.rejects(
      () => db.prepare(
        `INSERT INTO wrgit_workspaces (id, task_id, agent_id, repo, base_sha, head_sha, status, created_at, merged_at)
         VALUES ('ws-bad', 'task-1', 'agent:wg2', 'ws-bad', ?, NULL, 'nope', 1, NULL)`,
      ).bind(BASE).all(),
      /CHECK constraint failed/,
    );
  } finally { await close(); }
});

test('workspace helpers record head, submit, merge, and cancel', async () => {
  const { db, close } = await database();
  try {
    const created = await createWorkspace(db, workspace('ws-1', 'ws-wg2-agent', 1_700_000_000_000));
    assert.deepEqual(created, {
      id: 'ws-1', task_id: 'task-1', agent_id: 'agent:wg2', repo: 'ws-wg2-agent',
      base_sha: BASE, head_sha: null, status: 'open', created_at: 1_700_000_000_000, merged_at: null,
    });
    assert.deepEqual(await getWorkspace(db, 'ws-1'), created);
    assert.equal(await getWorkspace(db, 'missing'), null);
    await createWorkspace(db, workspace('ws-main', 'main/agent-workroom', 1_700_000_000_100, 'task-main'));
    assert.equal(await faultCode(() => createWorkspace(db, workspace('ws-2', 'ws-wg2-agent', 2))), 'CONFLICT');
    assert.equal(await faultCode(() => createWorkspace(db, workspace('ws-3', '../secret', 2))), 'INVALID_INPUT');
    assert.equal(await faultCode(() => createWorkspace(db, { ...workspace('ws-3', 'ws-bad', 2), base_sha: 'ABC' })), 'INVALID_INPUT');

    const headed = await setWorkspaceHead(db, { id: 'ws-1', head_sha: HEAD });
    assert.equal(headed.head_sha, HEAD);
    assert.equal(headed.status, 'open');
    assert.equal((await setWorkspaceHead(db, { id: 'ws-1', head_sha: HEAD })).head_sha, HEAD);
    assert.equal(await faultCode(() => markWorkspaceMerged(db, { id: 'ws-1', merged_at: 1_700_000_000_500 })), 'CONFLICT');
    assert.equal(await faultCode(() => markWorkspaceSubmitted(db, 'ws-main')), 'CONFLICT');

    const submitted = await markWorkspaceSubmitted(db, 'ws-1');
    assert.equal(submitted.status, 'submitted');
    assert.equal((await markWorkspaceSubmitted(db, 'ws-1')).status, 'submitted');
    assert.equal(await faultCode(() => setWorkspaceHead(db, { id: 'ws-1', head_sha: OTHER })), 'CONFLICT');
    assert.equal(await faultCode(() => markWorkspaceMerged(db, { id: 'ws-1', merged_at: 1_699_000_000_000 })), 'INVALID_INPUT');

    const merged = await markWorkspaceMerged(db, { id: 'ws-1', merged_at: 1_700_000_000_500 });
    assert.equal(merged.status, 'merged');
    assert.equal(merged.merged_at, 1_700_000_000_500);
    assert.equal(merged.head_sha, HEAD);
    assert.deepEqual(await markWorkspaceMerged(db, { id: 'ws-1', merged_at: 1_700_000_000_500 }), merged);
    assert.equal(await faultCode(() => markWorkspaceMerged(db, { id: 'ws-1', merged_at: 1_700_000_000_600 })), 'CONFLICT');
    assert.equal(await faultCode(() => markWorkspaceCanceled(db, 'ws-1')), 'CONFLICT');

    await createWorkspace(db, workspace('ws-cancel', 'ws-wg2-cancel', 1_700_000_000_200, 'task-1'));
    await createWorkspace(db, workspace('ws-later', 'ws-wg2-later', 1_700_000_000_300, 'task-1'));
    const canceled = await markWorkspaceCanceled(db, 'ws-cancel');
    assert.equal(canceled.status, 'canceled');
    assert.equal(canceled.merged_at, null);
    assert.equal((await markWorkspaceCanceled(db, 'ws-cancel')).status, 'canceled');
    assert.equal(await faultCode(() => markWorkspaceSubmitted(db, 'ws-cancel')), 'CONFLICT');
    const listed = await listWorkspacesByTask(db, 'task-1');
    assert.deepEqual(listed.map(row => row.id), ['ws-1', 'ws-cancel', 'ws-later']);
    assert.deepEqual((await listWorkspacesByTask(db, 'task-main')).map(row => row.id), ['ws-main']);
    assert.deepEqual(await listWorkspacesByTask(db, 'task-none'), []);
  } finally { await close(); }
});

test('commit helpers are idempotent for the same repo and sha', async () => {
  const { db, close } = await database();
  try {
    const first = await recordCommit(db, { repo: 'ws-wg2-agent', sha: HEAD, agent_id: 'agent:wg2', task_id: 'task-1', pushed_at: 100 });
    const replay = await recordCommit(db, { repo: 'ws-wg2-agent', sha: HEAD, agent_id: 'agent:wg2', task_id: 'task-1', pushed_at: 999 });
    assert.deepEqual(replay, first);
    assert.equal(replay.pushed_at, 100);
    assert.equal(await faultCode(() => recordCommit(db, { repo: 'ws-wg2-agent', sha: HEAD, agent_id: 'agent:other', task_id: 'task-1', pushed_at: 100 })), 'CONFLICT');
    assert.equal(await faultCode(() => recordCommit(db, { repo: 'ws-wg2-agent', sha: HEAD, agent_id: 'agent:wg2', task_id: 'task-2', pushed_at: 100 })), 'CONFLICT');
    const kept = await db.prepare('SELECT agent_id, task_id, pushed_at FROM wrgit_commits WHERE repo=? AND sha=?').bind('ws-wg2-agent', HEAD).first<{
      agent_id: string; task_id: string; pushed_at: number;
    }>();
    assert.deepEqual(kept, { agent_id: 'agent:wg2', task_id: 'task-1', pushed_at: 100 });
    await recordCommit(db, { repo: 'ws-wg2-agent', sha: OTHER, agent_id: 'agent:wg2', task_id: 'task-1', pushed_at: 50 });
    await recordCommit(db, { repo: 'main/agent-workroom', sha: BASE, agent_id: 'agent:workroom', task_id: 'task-main', pushed_at: 40 });
    assert.deepEqual((await listCommits(db, 'ws-wg2-agent')).map(row => row.sha), [OTHER, HEAD]);
    assert.deepEqual(await listCommits(db, 'missing'), []);
    assert.equal(await faultCode(() => recordCommit(db, { repo: 'ws-wg2-agent', sha: 'gg'.repeat(20), agent_id: 'agent:wg2', task_id: 'task-1', pushed_at: 1 })), 'INVALID_INPUT');
  } finally { await close(); }
});

test('merge lock acquire respects TTL and release is holder-scoped', async () => {
  const { db, close } = await database();
  try {
    assert.equal(await faultCode(() => acquireMergeLock(db, { holder: '', ttlMs: 1000, nowMs: 1000 })), 'INVALID_INPUT');
    assert.equal(await faultCode(() => acquireMergeLock(db, { holder: 'agent:a', ttlMs: 0, nowMs: 1000 })), 'INVALID_INPUT');
    assert.deepEqual(await readMergeLock(db), { id: 1, holder: null, acquired_at: null, expires_at: null });

    const first = await acquireMergeLock(db, { holder: 'agent:a', ttlMs: 1000, nowMs: 1000 });
    assert.deepEqual(first, { acquired: true, lock: { id: 1, holder: 'agent:a', acquired_at: 1000, expires_at: 2000 } });
    const blocked = await acquireMergeLock(db, { holder: 'agent:b', ttlMs: 1000, nowMs: 1500 });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.lock.holder, 'agent:a');
    assert.equal(blocked.lock.expires_at, 2000);

    const renewed = await acquireMergeLock(db, { holder: 'agent:a', ttlMs: 1000, nowMs: 1500 });
    assert.deepEqual(renewed, { acquired: true, lock: { id: 1, holder: 'agent:a', acquired_at: 1500, expires_at: 2500 } });
    const stolen = await acquireMergeLock(db, { holder: 'agent:b', ttlMs: 500, nowMs: 2500 });
    assert.deepEqual(stolen, { acquired: true, lock: { id: 1, holder: 'agent:b', acquired_at: 2500, expires_at: 3000 } });

    const stranger = await releaseMergeLock(db, { holder: 'agent:a' });
    assert.equal(stranger.released, false);
    assert.equal(stranger.lock.holder, 'agent:b');
    const released = await releaseMergeLock(db, { holder: 'agent:b' });
    assert.deepEqual(released, { released: true, lock: { id: 1, holder: null, acquired_at: null, expires_at: null } });
    assert.equal((await releaseMergeLock(db, { holder: 'agent:b' })).released, false);

    await acquireMergeLock(db, { holder: 'agent:a', ttlMs: 500, nowMs: 3000 });
    const cleared = await releaseMergeLock(db, { holder: 'agent:a' });
    assert.equal(cleared.released, true);
    assert.equal((await readMergeLock(db)).holder, null);
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM wrgit_merge_lock').first<{ n: number }>();
    assert.equal(rows?.n, 1);
  } finally { await close(); }
});

class MemoryArtifacts implements ArtifactsBinding {
  private repos = new Map<string, MemRepo>();
  private seq = 0;

  constructor(private nowMs: () => number = Date.now) {}

  async create(name: string, opts?: { description?: string; readOnly?: boolean; defaultBranch?: string }): Promise<ArtifactsRepoRef> {
    return this.insert(name, opts?.defaultBranch ?? 'main', null);
  }

  async import(params: { url: string; name: string; branch?: string; depth?: number }): Promise<ArtifactsRepoRef> {
    if (!/^https:\/\/[^\s]+$/.test(params.url)) throw new Error('INVALID_INPUT');
    return this.insert(params.name, params.branch ?? 'main', params.url);
  }

  async fork(source: string, name: string): Promise<ArtifactsRepoRef> {
    const from = this.require(source);
    if (this.repos.has(name)) throw new Error('CONFLICT');
    const copy: MemRepo = {
      name,
      defaultBranch: from.defaultBranch,
      sourceUrl: null,
      files: new Map(from.files),
      commits: from.commits.map(commit => ({ ...commit, files: new Map(commit.files) })),
    };
    this.repos.set(name, copy);
    return this.ref(copy);
  }

  async get(name: string): Promise<ArtifactsRepoInfo> {
    const repo = this.require(name);
    return {
      name: repo.name,
      remote: remoteOf(repo.name),
      defaultBranch: repo.defaultBranch,
      headSha: repo.commits.at(-1)?.hash ?? null,
      sourceUrl: repo.sourceUrl,
    };
  }

  async delete(name: string): Promise<boolean> {
    return this.repos.delete(name);
  }

  async issueToken(repo: string, scope: 'read' | 'write' = 'write', ttlSeconds = 3600): Promise<ArtifactsToken> {
    this.require(repo);
    if (scope !== 'read' && scope !== 'write') throw new Error('INVALID_INPUT');
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) throw new Error('INVALID_INPUT');
    const expiresAt = this.nowMs() + ttlSeconds * 1000;
    return { token: `memory:${scope}:${repo}:${expiresAt}`, scope, expiresAt };
  }

  async readFile(repo: string, ref: string, path: string): Promise<Uint8Array | null> {
    if (ref === '' || path === '') throw new Error('INVALID_INPUT');
    const found = this.require(repo);
    const commit = this.commitAt(found, ref);
    if (!commit) return null;
    const bytes = commit.files.get(path);
    return bytes ? Uint8Array.from(bytes) : null;
  }

  async log(repo: string, opts?: ArtifactsLogOptions): Promise<ArtifactsCommit[]> {
    const found = this.require(repo);
    const ref = opts?.ref ?? 'HEAD';
    const end = this.commitIndex(found, ref);
    if (end < 0) return [];
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? found.commits.length;
    return found.commits.slice(0, end + 1).reverse().slice(offset, offset + limit).map(publicCommit);
  }

  writeFile(repo: string, path: string, bytes: Uint8Array): void {
    const found = this.require(repo);
    if (path === '') throw new Error('INVALID_INPUT');
    found.files.set(path, Uint8Array.from(bytes));
  }

  addCommit(repo: string, input: { message: string; authorName: string; authoredAt: number }): ArtifactsCommit {
    const found = this.require(repo);
    this.seq += 1;
    const commit: MemCommit = {
      hash: this.seq.toString(16).padStart(40, '0'),
      message: input.message,
      authorName: input.authorName,
      authoredAt: input.authoredAt,
      files: new Map(found.files),
    };
    found.commits.push(commit);
    return publicCommit(commit);
  }

  private insert(name: string, defaultBranch: string, sourceUrl: string | null): ArtifactsRepoRef {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error('INVALID_INPUT');
    if (this.repos.has(name)) throw new Error('CONFLICT');
    const repo: MemRepo = { name, defaultBranch, sourceUrl, files: new Map(), commits: [] };
    this.repos.set(name, repo);
    return this.ref(repo);
  }

  private ref(repo: MemRepo): ArtifactsRepoRef {
    const expiresAt = this.nowMs() + 3600 * 1000;
    return {
      name: repo.name,
      remote: remoteOf(repo.name),
      defaultBranch: repo.defaultBranch,
      token: `memory:write:${repo.name}:${expiresAt}`,
    };
  }

  private require(name: string): MemRepo {
    const repo = this.repos.get(name);
    if (!repo) throw new Error('NOT_FOUND');
    return repo;
  }

  private commitIndex(repo: MemRepo, ref: string): number {
    if (ref === 'HEAD' || ref === repo.defaultBranch) return repo.commits.length - 1;
    return repo.commits.findIndex(commit => commit.hash === ref);
  }

  private commitAt(repo: MemRepo, ref: string): MemCommit | null {
    const index = this.commitIndex(repo, ref);
    return index < 0 ? null : repo.commits[index] ?? null;
  }
}

interface MemCommit extends ArtifactsCommit { files: Map<string, Uint8Array> }
interface MemRepo {
  name: string;
  defaultBranch: string;
  sourceUrl: string | null;
  files: Map<string, Uint8Array>;
  commits: MemCommit[];
}

function remoteOf(name: string): string {
  return `memory://workroom/${name}.git`;
}

function publicCommit(commit: MemCommit): ArtifactsCommit {
  return { hash: commit.hash, message: commit.message, authorName: commit.authorName, authoredAt: commit.authoredAt };
}

test('in-memory ArtifactsBinding covers create, import, fork, token, file, and log', async () => {
  assert.deepEqual(ARTIFACTS_OPS, ['create', 'import', 'fork', 'get', 'delete', 'issueToken', 'readFile', 'log']);
  assert.throws(() => assertArtifactsBinding({}), /ArtifactsBinding\.create is missing/);
  let now = 1_700_000_000_000;
  const artifacts = new MemoryArtifacts(() => now);
  assert.equal(assertArtifactsBinding(artifacts), artifacts);

  const created = await artifacts.create('agent-workroom', { description: 'canonical' });
  assert.equal(created.name, 'agent-workroom');
  assert.equal(created.defaultBranch, 'main');
  assert.equal(created.remote, 'memory://workroom/agent-workroom.git');
  assert.match(created.token, /^memory:write:agent-workroom:1700003600000$/);
  assert.equal((await artifacts.get('agent-workroom')).headSha, null);
  await assert.rejects(() => artifacts.create('agent-workroom'), /CONFLICT/);

  const imported = await artifacts.import({ url: 'https://github.com/example/agent-workroom.git', name: 'imported-main', branch: 'main' });
  assert.equal(imported.name, 'imported-main');
  assert.equal((await artifacts.get('imported-main')).sourceUrl, 'https://github.com/example/agent-workroom.git');
  await assert.rejects(() => artifacts.import({ url: 'http://example.invalid/repo.git', name: 'insecure' }), /INVALID_INPUT/);

  artifacts.writeFile('imported-main', 'README.md', utf8.encode('hello'));
  const first = artifacts.addCommit('imported-main', { message: 'init', authorName: 'agent:wg2', authoredAt: 10 });
  artifacts.writeFile('imported-main', 'README.md', utf8.encode('hello world'));
  const second = artifacts.addCommit('imported-main', { message: 'edit', authorName: 'agent:wg2', authoredAt: 20 });

  const forked = await artifacts.fork('imported-main', 'ws-wg2-agent');
  assert.equal(forked.remote, 'memory://workroom/ws-wg2-agent.git');
  assert.equal(Buffer.from((await artifacts.readFile('ws-wg2-agent', 'main', 'README.md'))!).toString(), 'hello world');
  assert.equal(Buffer.from((await artifacts.readFile('ws-wg2-agent', first.hash, 'README.md'))!).toString(), 'hello');
  assert.equal(await artifacts.readFile('ws-wg2-agent', 'main', 'missing.txt'), null);
  await assert.rejects(() => artifacts.readFile('ws-wg2-agent', '', 'README.md'), /INVALID_INPUT/);

  artifacts.writeFile('ws-wg2-agent', 'README.md', utf8.encode('fork only'));
  assert.equal(Buffer.from((await artifacts.readFile('imported-main', second.hash, 'README.md'))!).toString(), 'hello world');
  assert.deepEqual((await artifacts.log('ws-wg2-agent', { limit: 1 })).map(row => row.hash), [second.hash]);
  assert.deepEqual((await artifacts.log('ws-wg2-agent')).map(row => [row.hash, row.message]), [
    [second.hash, 'edit'],
    [first.hash, 'init'],
  ]);

  now = 1_700_000_100_000;
  const token = await artifacts.issueToken('ws-wg2-agent', 'read', 60);
  assert.deepEqual(token, { token: 'memory:read:ws-wg2-agent:1700000160000', scope: 'read', expiresAt: 1_700_000_160_000 });
  assert.equal(await artifacts.delete('ws-wg2-agent'), true);
  assert.equal(await artifacts.delete('ws-wg2-agent'), false);
  await assert.rejects(() => artifacts.get('ws-wg2-agent'), /NOT_FOUND/);
  await assert.rejects(() => artifacts.issueToken('ws-wg2-agent'), /NOT_FOUND/);
  await assert.rejects(() => artifacts.fork('missing', 'other'), /NOT_FOUND/);
});

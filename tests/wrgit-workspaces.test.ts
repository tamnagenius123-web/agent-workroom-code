import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { taskFixtures } from '../scripts/task-fixtures.ts';
import { RED_CASE_IDS } from '../src/phase-contracts/verifier-receipt.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database, Env, Statement } from '../src/server/db.ts';
import { createApp, type Authenticate } from '../src/server/app.ts';
import { Workroom } from '../src/server/domain.ts';
import {
  GATE_VERSION, evaluateVerifierReceipt,
  type CaseRun, type ReceiptObservation,
} from '../src/server/verifier-receipt.ts';
import type { ArtifactsBinding, ArtifactsCommit, ArtifactsRepoInfo, ArtifactsRepoRef, ArtifactsToken } from '../src/server/wrgit/artifacts-binding.ts';
import { wrgitClaim } from '../src/server/wrgit/routes.ts';
import { WRGIT_CANONICAL_REPO, WRGIT_TOKEN_TTL_S, deriveWorkspaceCanonicalRepo, ensureWorkspace, workspaceRepoName } from '../src/server/wrgit/workspaces.ts';

const CANONICAL = WRGIT_CANONICAL_REPO;
const BASE_SHA = 'c0ffee00' + '0'.repeat(32);
const HEAD_SHA = 'facefeed' + '01'.repeat(16);
const NAMESPACE = 'workroom';

interface ForkCall { source: string; name: string }
interface Issued { repo: string; scope: 'read' | 'write'; token: string; ttl?: number }
interface StoredRepo { name: string; remote: string; defaultBranch: string; commits: ArtifactsCommit[] }

class MemoryArtifacts implements ArtifactsBinding {
  readonly repos = new Map<string, StoredRepo>();
  readonly forks: ForkCall[] = [];
  readonly tokens: Issued[] = [];
  failIssue: Error | null = null;
  failFork: Error | null = null;
  // Race hooks: run inside the external side effect, after the pre-checks passed.
  onFork: (() => Promise<void>) | null = null;
  onIssue: (() => Promise<void>) | null = null;
  constructor() { this.addRepo(CANONICAL, BASE_SHA); }
  addRepo(name: string, hash: string | null): void {
    const commits = hash ? [{ hash, message: 'base', authorName: 'canonical', authoredAt: 0 }] : [];
    this.repos.set(name, { name, remote: remoteFor(name), defaultBranch: 'main', commits });
  }
  addCommit(name: string, hash: string): void {
    const repo = this.repos.get(name);
    if (!repo) throw new Error('missing repo');
    repo.commits.unshift({ hash, message: 'edit', authorName: 'agent', authoredAt: 1 });
  }
  async create(name: string): Promise<ArtifactsRepoRef> {
    if (this.repos.has(name)) throw new Error('ALREADY_EXISTS');
    this.addRepo(name, null);
    return this.ref(name);
  }
  async import(params: { url: string; name: string }): Promise<ArtifactsRepoRef> {
    if (!params.url) throw new Error('INVALID_URL');
    this.addRepo(params.name, BASE_SHA);
    return this.ref(params.name);
  }
  async fork(source: string, name: string): Promise<ArtifactsRepoRef> {
    if (this.failFork) throw this.failFork;
    if (this.onFork) await this.onFork();
    const from = this.repos.get(source);
    if (!from) throw new Error('NOT_FOUND');
    if (this.repos.has(name)) throw new Error('ALREADY_EXISTS');
    this.forks.push({ source, name });
    this.repos.set(name, { name, remote: remoteFor(name), defaultBranch: from.defaultBranch, commits: from.commits.map(commit => ({ ...commit })) });
    return this.ref(name);
  }
  async get(name: string): Promise<ArtifactsRepoInfo> {
    const repo = this.repos.get(name);
    if (!repo) throw new Error('NOT_FOUND');
    return { name: repo.name, remote: repo.remote, defaultBranch: repo.defaultBranch, headSha: repo.commits[0]?.hash ?? null, sourceUrl: null };
  }
  async delete(name: string): Promise<boolean> { return this.repos.delete(name); }
  async issueToken(repo: string, scope: 'read' | 'write' = 'write', ttl?: number): Promise<ArtifactsToken> {
    if (this.failIssue) throw this.failIssue;
    if (!this.repos.has(repo)) throw new Error('NOT_FOUND');
    const token = `art_test_${scope}_${this.tokens.length}_${crypto.randomUUID()}`;
    this.tokens.push({ repo, scope, token, ttl });
    if (this.onIssue) await this.onIssue();
    return { token, scope, expiresAt: Date.now() + 3_600_000 };
  }
  async readFile(): Promise<Uint8Array | null> { return null; }
  async log(repo: string): Promise<ArtifactsCommit[]> {
    const repoRow = this.repos.get(repo);
    if (!repoRow) throw new Error('NOT_FOUND');
    return repoRow.commits.map(commit => ({ ...commit }));
  }
  private ref(name: string): ArtifactsRepoRef {
    const repo = this.repos.get(name);
    if (!repo) throw new Error('NOT_FOUND');
    return { name: repo.name, remote: repo.remote, defaultBranch: repo.defaultBranch, token: 'fork-ref' };
  }
}

function remoteFor(name: string): string {
  return `https://artifacts.cloudflare.net/${NAMESPACE}/${name}.git`;
}

function repoName(taskId: string, agentId: string): string {
  return workspaceRepoName(taskId, agentId);
}

const principals: Record<string, { principal: string; write: boolean }> = {
  'local-alpha-fixture': { principal: 'synthetic:alpha', write: true },
  'local-reader-fixture': { principal: 'synthetic:reader', write: false },
  'local-outsider-fixture': { principal: 'synthetic:outsider', write: true },
  'local-beta-fixture': { principal: 'synthetic:beta', write: true },
  // can_post=1 member whose token lacks workroom.write: isolates the scope check from the membership check.
  'local-alpha-readonly-fixture': { principal: 'synthetic:alpha', write: false },
};

const authenticate: Authenticate = async request => {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
  const identity = token ? principals[token] : undefined;
  if (!identity) throw new Fault('UNAUTHENTICATED', 'A synthetic local fixture token is required.', 401);
  return identity;
};

interface Boot { db: Database; close: () => Promise<void> }
let boot: Boot;
const logs: string[] = [];
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
const originalConsole = Object.fromEntries(consoleMethods.map(name => [name, console[name]])) as Record<(typeof consoleMethods)[number], (...args: unknown[]) => void>;

before(async () => {
  for (const name of consoleMethods) {
    console[name] = (...args: unknown[]) => {
      logs.push(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '));
    };
  }
  const dir = mkdtempSync(join(tmpdir(), 'wrgit-'));
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(null) } }',
    d1Databases: { DB: 'workroom-wrgit' },
    d1Persist: dir,
    cf: false,
  });
  const db = await mf.getD1Database('DB') as unknown as Database;
  await migrate(db as unknown as Awaited<ReturnType<Miniflare['getD1Database']>>, 9999);
  await db.batch([
    db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
    ...['alpha', 'beta', 'reader', 'outsider'].map(name => db.prepare('INSERT INTO principals(id) VALUES (?)').bind('synthetic:' + name)),
    ...['alpha', 'beta', 'reader'].map(name => db.prepare('INSERT INTO memberships(principal_id,room_id,can_post) VALUES (?, ?, ?)').bind('synthetic:' + name, 'room_main', name === 'reader' ? 0 : 1)),
  ]);
  await taskFixtures(db as unknown as Awaited<ReturnType<Miniflare['getD1Database']>>);
  boot = { db, close: async () => { await mf.dispose(); rmSync(dir, { recursive: true, force: true }); } };
});

after(async () => {
  await boot?.close();
  for (const name of consoleMethods) console[name] = originalConsole[name] as typeof console.log;
  const secret = logs.find(line => line.includes('art_test_'));
  assert.equal(secret, undefined);
});

function envFor(artifacts: ArtifactsBinding | undefined, enabled: boolean): Env {
  return { DB: boot.db, WRGIT_ENABLED: enabled ? '1' : '0', ARTIFACTS: artifacts } as unknown as Env;
}

// This suite drives workspace logic with an already-adapted fake. The native binding shape is
// covered by wrgit-native-artifacts.test.ts.
function app() { return createApp(authenticate, { artifacts: env => (env as unknown as { ARTIFACTS?: ArtifactsBinding }).ARTIFACTS }); }

interface HttpResult { status: number; text: string; json: { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string } } }

async function call(env: Env, path: string, init: { method?: string; body?: unknown; token?: string; key?: string } = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { authorization: 'Bearer ' + (init.token ?? 'local-alpha-fixture') };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.key) headers['idempotency-key'] = init.key;
  const response = await app().fetch(new Request('http://127.0.0.1' + path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }), env);
  const text = await response.text();
  let json: HttpResult['json'] = {};
  try { json = JSON.parse(text) as HttpResult['json']; } catch { json = {}; }
  return { status: response.status, text, json };
}

async function createTask(env: Env): Promise<{ id: string; version: number; lease_epoch: number }> {
  const made = await call(env, '/api/v1/rooms/room_main/tasks', {
    body: { schema_version: '1', goal: 'wg3 workspace', done_conditions: ['verified'] },
    key: crypto.randomUUID(),
  });
  assert.equal(made.status, 200, made.text);
  const data = made.json.data as { task: { id: string; version: number }; lease: { lease_epoch: number } };
  return { id: data.task.id, version: data.task.version, lease_epoch: data.lease.lease_epoch };
}

async function taskState(taskId: string): Promise<{ state: string; version: number; holder_id: string | null; lease_epoch: number }> {
  const row = await boot.db.prepare(`SELECT t.state AS state, t.version AS version, l.holder_id AS holder_id, l.lease_epoch AS lease_epoch
    FROM tasks t JOIN task_leases l ON l.task_id=t.id WHERE t.id=?`).bind(taskId).first<{ state: string; version: number; holder_id: string | null; lease_epoch: number }>();
  assert.ok(row, taskId);
  return row;
}

function failWorkspaceInsert(db: Database): Database {
  let remaining = 1;
  const fail = async (): Promise<never> => { throw new Error('workspace record write failed'); };
  return {
    prepare(sql: string): Statement {
      const statement = db.prepare(sql);
      if (remaining === 0 || !/^INSERT INTO wrgit_workspaces\b/.test(sql)) return statement;
      remaining -= 1;
      const failing: Statement = {
        bind() { return failing; },
        first: fail,
        all: fail,
      };
      return failing;
    },
    batch: statements => db.batch(statements),
  };
}

// The claimant rule (#83 follow-up): only the lease holder of an in_progress task may open its
// workspace. This fixture takes the lease directly so a test does not also exercise the claim fork.
async function holdTask(db: Database, taskId: string, agentId = 'synthetic:alpha'): Promise<void> {
  await db.batch([
    db.prepare("UPDATE tasks SET state='in_progress', version=version+1 WHERE id=?").bind(taskId),
    db.prepare('UPDATE task_leases SET holder_id=?, lease_epoch=lease_epoch+1, expires_at_ms=? WHERE task_id=?').bind(agentId, Date.now() + 3_600_000, taskId),
  ]);
}

function claim(env: Env, task: { id: string; version: number; lease_epoch: number }) {
  return call(env, `/api/v1/rooms/room_main/tasks/${task.id}/claim`, {
    body: { schema_version: '1', expected_version: task.version, lease_epoch: task.lease_epoch },
    key: crypto.randomUUID(),
  });
}

async function rowsFor(taskId: string): Promise<Record<string, unknown>[]> {
  const loaded = await boot.db.prepare('SELECT id, task_id, agent_id, repo, remote_url, base_sha, status, created_at FROM wrgit_workspaces WHERE task_id=?').bind(taskId).all<Record<string, unknown>>();
  return loaded.results;
}

// 0063 is WG-5's file. These cases start from a database migrated through 0062 and apply
// that step by hand, then mark the file applied so migrate() runs 0068 next and does not
// add the same columns twice.
const WG5_0063 = `-- WG-5 submit and merge fields on the WG-2 wrgit index (0061_wrgit.sql).
-- Workspace repo name stays wrgit_workspaces.repo. 0062 is WG-3's remote and pending fork.
-- submitted_sha is the sha submit recorded. merged_sha is the sha canonical main accepted.
-- Lock expiry stays on wrgit_merge_lock.expires_at from 0061.
ALTER TABLE wrgit_workspaces ADD COLUMN canonical_repo TEXT
  CHECK (canonical_repo IS NULL OR (length(canonical_repo) BETWEEN 1 AND 200));

ALTER TABLE wrgit_workspaces ADD COLUMN unit TEXT
  CHECK (unit IS NULL OR (length(unit) BETWEEN 1 AND 128));

ALTER TABLE wrgit_workspaces ADD COLUMN submitted_sha TEXT
  CHECK (submitted_sha IS NULL OR (length(submitted_sha) = 40 AND submitted_sha NOT GLOB '*[^0-9a-f]*'));

ALTER TABLE wrgit_workspaces ADD COLUMN merged_sha TEXT
  CHECK (merged_sha IS NULL OR (length(merged_sha) = 40 AND merged_sha NOT GLOB '*[^0-9a-f]*'));

-- Recorded before canonical main moves. A later retry may treat canonical==sha as its own
-- fast-forward only when a row for this workspace, receipt, and sha is already here.
CREATE TABLE wrgit_merge_intents (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 128),
  receipt_id TEXT NOT NULL CHECK (length(receipt_id) BETWEEN 1 AND 128),
  sha TEXT NOT NULL CHECK (length(sha) = 40 AND sha NOT GLOB '*[^0-9a-f]*'),
  lock_token TEXT NOT NULL CHECK (length(lock_token) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (workspace_id, receipt_id, sha)
);

CREATE TABLE wrgit_merges (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL UNIQUE CHECK (length(workspace_id) BETWEEN 1 AND 128),
  receipt_id TEXT NOT NULL CHECK (length(receipt_id) BETWEEN 1 AND 128),
  sha TEXT NOT NULL CHECK (length(sha) = 40 AND sha NOT GLOB '*[^0-9a-f]*'),
  base_sha TEXT NOT NULL CHECK (length(base_sha) = 40 AND base_sha NOT GLOB '*[^0-9a-f]*'),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  merged_at INTEGER NOT NULL CHECK (merged_at >= 0)
);
`;

const MERGE_PATH_COLS = 'id, task_id, repo, canonical_repo, base_sha, head_sha, submitted_sha, agent_id, unit, merged_sha, status, created_at, merged_at';

async function applySql(db: Database, sql: string): Promise<void> {
  const statements = sql.trim().split(/;\s*\n/).map(part => part.trim()).filter(part => part.length > 0).map(part => db.prepare(part));
  await db.batch(statements);
}

async function migrationFileNames(): Promise<string[]> {
  return (await readdir('migrations')).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
}

// Applies the named files in the given order. This does not use migrate(), so a harness skip cannot hide a file.
async function applyMigrationFiles(db: Database, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const sql = await readFile('migrations/' + name, 'utf8');
    try {
      await applySql(db, sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${name}: ${message}`);
    }
  }
}

async function emptyDatabase(prefix: string): Promise<{ db: Database; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(null) } }',
    d1Databases: { DB: prefix + crypto.randomUUID() },
    d1Persist: dir,
    cf: false,
  });
  const db = await mf.getD1Database('DB') as unknown as Database;
  return { db, close: async () => { await mf.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function passingRuns(): CaseRun[] {
  return RED_CASE_IDS.map(case_id => {
    const evidence = `log ${case_id} retained`;
    return { case_id, evidence, evidence_sha256: sha256(evidence) };
  });
}

function passObservation(taskId: string, sha: string): ReceiptObservation {
  return {
    consumer: 'P2',
    producer_id: 'agent_author',
    acceptor_id: 'agent_acceptor',
    next_maker: 'agent_author',
    author_lineage: { method: 'author.impl', dependencies: ['pkg-a'] },
    verifier_lineage: { method: 'verifier.impl', dependencies: ['pkg-a'] },
    sha,
    observed_sha: sha,
    claimed_gate_version: GATE_VERSION,
    task_id: taskId,
    attempt_id: 'attempt_1',
    artifact_digest: 'e'.repeat(64),
    verifier_id: 'agent_acceptor',
    lease: { epoch: 'lease_1', stale: false },
    capability_label_as_authority: false,
    approval_events: ['accept'],
    observation_ok: true,
    runs: passingRuns(),
  };
}

async function storePass(db: Database, id: string, taskId: string, sha: string): Promise<void> {
  const seen = passObservation(taskId, sha);
  const evaluation = evaluateVerifierReceipt(seen);
  assert.equal(evaluation.disposition, 'PASS');
  assert.ok(evaluation.receipt);
  await db.prepare(`INSERT INTO verifier_receipts(
      id, room_id, principal_id, disposition, observation_json, result_json, idempotency_key, recorded_at)
    VALUES (?, 'room_main', 'synthetic:alpha', ?, ?, ?, ?, ?)`)
    .bind(id, evaluation.disposition, JSON.stringify(seen), JSON.stringify({ disposition: evaluation.disposition, receipt: evaluation.receipt, observation: seen }), `idem-${id}`, Date.now())
    .all();
}

async function columnNames(db: Database, table: string): Promise<string[]> {
  const info = await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>();
  return info.results.map(row => row.name);
}

interface MergePathRow {
  id: string;
  task_id: string;
  repo: string;
  canonical_repo: string | null;
  unit: string | null;
  agent_id: string;
}

async function mergePathRead(db: Database, taskId: string): Promise<MergePathRow> {
  const row = await db.prepare(`SELECT ${MERGE_PATH_COLS} FROM wrgit_workspaces WHERE task_id=? LIMIT 1`).bind(taskId).first<MergePathRow>();
  assert.ok(row, taskId);
  return row;
}

async function pre0063Database(): Promise<{ db: Database; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'wrgit-r4-'));
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(null) } }',
    d1Databases: { DB: 'workroom-wrgit-r4-' + crypto.randomUUID() },
    d1Persist: dir,
    cf: false,
  });
  const db = await mf.getD1Database('DB') as unknown as Database;
  await migrate(db as unknown as Awaited<ReturnType<Miniflare['getD1Database']>>, 62);
  await db.batch([
    db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
    ...['alpha', 'beta', 'reader', 'outsider'].map(name => db.prepare('INSERT INTO principals(id) VALUES (?)').bind('synthetic:' + name)),
    ...['alpha', 'beta', 'reader'].map(name => db.prepare('INSERT INTO memberships(principal_id,room_id,can_post) VALUES (?, ?, ?)').bind('synthetic:' + name, 'room_main', name === 'reader' ? 0 : 1)),
  ]);
  await taskFixtures(db as unknown as Awaited<ReturnType<Miniflare['getD1Database']>>);
  return { db, close: async () => { await mf.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

async function createTaskOn(db: Database): Promise<{ id: string }> {
  const made = await call({ DB: db, WRGIT_ENABLED: '1' } as Env, '/api/v1/rooms/room_main/tasks', {
    body: { schema_version: '1', goal: 'wg3 pre-0063 workspace', done_conditions: ['verified'] },
    key: crypto.randomUUID(),
  });
  assert.equal(made.status, 200, made.text);
  const id = (made.json.data as { task: { id: string } }).task.id;
  await holdTask(db, id);
  return { id };
}

async function openOn(db: Database, artifacts: MemoryArtifacts, taskId: string): Promise<HttpResult> {
  return call({ DB: db, WRGIT_ENABLED: '1', ARTIFACTS: artifacts } as unknown as Env, '/git/workspaces', { body: { task_id: taskId } });
}

describe('WR-GIT workspaces', { concurrency: false }, () => {
  test('schema stores workspace rows and has no credential column', async () => {
    const schema = await boot.db.prepare("SELECT sql FROM sqlite_master WHERE name='wrgit_workspaces'").first<{ sql: string }>();
    assert.ok(schema?.sql, 'wrgit_workspaces table missing');
    assert.doesNotMatch(schema.sql, /token/i);
  });

  test('POST /git/workspaces forks the canonical repo and returns a write token once', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    await holdTask(boot.db, task.id);
    const repo = repoName(task.id, 'synthetic:alpha');
    const created = await call(env, '/git/workspaces', { body: { task_id: task.id } });
    assert.equal(created.status, 200, created.text);
    assert.deepEqual(Object.keys(created.json.data ?? {}).sort(), ['base_sha', 'remote_url', 'token']);
    const token = String(created.json.data?.token);
    const remote = String(created.json.data?.remote_url);
    assert.equal(created.json.data?.base_sha, BASE_SHA);
    assert.equal(remote, remoteFor(repo));
    assert.equal(remote.includes(token), false);
    assert.equal(remote.includes('@'), false);
    assert.equal(artifacts.forks.length, 1);
    assert.deepEqual(artifacts.forks[0], { source: CANONICAL, name: repo });
    assert.equal(artifacts.tokens.length, 1);
    assert.equal(artifacts.tokens[0]?.scope, 'write');
    assert.equal(artifacts.tokens[0]?.repo, repo);
    assert.equal(artifacts.tokens[0]?.token, token);
    const stored = await rowsFor(task.id);
    assert.equal(stored.length, 1);
    assert.equal(JSON.stringify(stored).includes(token), false);
    assert.equal(stored[0]?.repo, repo);
    assert.equal(stored[0]?.base_sha, BASE_SHA);
    assert.equal(stored[0]?.remote_url, remote);
    assert.equal(logs.some(line => line.includes(token)), false);

    const again = await call(env, '/git/workspaces', { body: { task_id: task.id } });
    assert.equal(again.status, 200, again.text);
    assert.equal(artifacts.forks.length, 1);
    assert.equal(again.json.data?.base_sha, BASE_SHA);
    assert.notEqual(again.json.data?.token, token);
    assert.equal(artifacts.tokens.at(-1)?.scope, 'write');
    assert.equal((await rowsFor(task.id)).length, 1);
    assert.equal(logs.some(line => line.includes(String(again.json.data?.token))), false);
  });

  test('GET /git/workspaces/:id returns status, head, and diff stat without a token', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    await holdTask(boot.db, task.id);
    const repo = repoName(task.id, 'synthetic:alpha');
    const created = await call(env, '/git/workspaces', { body: { task_id: task.id } });
    assert.equal(created.status, 200, created.text);
    const token = String(created.json.data?.token);
    artifacts.addCommit(repo, HEAD_SHA);
    const got = await call(env, '/git/workspaces/' + repo);
    assert.equal(got.status, 200, got.text);
    assert.equal(got.text.includes(token), false);
    const data = got.json.data ?? {};
    assert.equal(data.id, repo);
    assert.equal(data.task_id, task.id);
    assert.equal(data.agent_id, 'synthetic:alpha');
    assert.equal(data.status, 'ready');
    assert.equal(data.base_sha, BASE_SHA);
    assert.equal(data.head_sha, HEAD_SHA);
    assert.deepEqual(data.diff_stat, { commits: 1 });
    assert.equal('token' in data, false);
    await artifacts.delete(repo);
    const missing = await call(env, '/git/workspaces/' + repo);
    assert.equal(missing.status, 200, missing.text);
    assert.equal(missing.json.data?.status, 'missing');
    assert.equal(missing.text.includes(token), false);
    const absent = await call(env, '/git/workspaces/ws-missing-synthetic-alpha');
    assert.equal(absent.status, 404);
    assert.equal(absent.json.error?.code, 'NOT_FOUND');
  });

  // #83 follow-up (grok 177b2749): a write-scope token is not enough. Open, submit and merge
  // each need can_post=1 in the task's room, checked before any binding call or row write.
  test('can_post=0 member with a write-scope token gets 403 on open, submit and merge', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    await holdTask(boot.db, task.id);
    const repo = repoName(task.id, 'synthetic:alpha');
    const opened = await call(env, '/git/workspaces', { body: { task_id: task.id } });
    assert.equal(opened.status, 200, opened.text);
    artifacts.addCommit(repo, HEAD_SHA);
    const revoke = (name: string, canPost: 0 | 1) => boot.db.prepare('UPDATE memberships SET can_post=? WHERE principal_id=? AND room_id=?').bind(canPost, 'synthetic:' + name, 'room_main').all();
    const before = { forks: artifacts.forks.length, tokens: artifacts.tokens.length };
    try {
      await revoke('alpha', 0);
      const reopen = await call(env, '/git/workspaces', { body: { task_id: task.id } });
      assert.equal(reopen.status, 403, reopen.text);
      assert.equal(reopen.json.error?.code, 'FORBIDDEN');
      const fresh = await call(env, '/git/workspaces', { body: { task_id: 'task-does-not-exist' } });
      assert.equal(fresh.status, 403, fresh.text);
      const submitted = await call(env, `/git/workspaces/${repo}/submit`, { body: { sha: HEAD_SHA } });
      assert.equal(submitted.status, 403, submitted.text);
      assert.equal(submitted.json.error?.code, 'FORBIDDEN');
      assert.deepEqual({ forks: artifacts.forks.length, tokens: artifacts.tokens.length }, before);
      assert.equal((await rowsFor(task.id))[0]?.status, 'open');
      await revoke('alpha', 1);

      const ok = await call(env, `/git/workspaces/${repo}/submit`, { body: { sha: HEAD_SHA } });
      assert.equal(ok.status, 200, ok.text);
      await revoke('beta', 0);
      const merged = await call(env, '/git/merge', { body: { task_id: task.id, receipt_id: 'rcpt-canpost' }, token: 'local-beta-fixture' });
      assert.equal(merged.status, 403, merged.text);
      assert.equal(merged.json.error?.code, 'FORBIDDEN');
      assert.equal((await rowsFor(task.id))[0]?.status, 'submitted');
      assert.equal(await boot.db.prepare('SELECT 1 FROM wrgit_merges WHERE task_id=?').bind(task.id).first(), null);
    } finally {
      await revoke('alpha', 1);
      await revoke('beta', 1);
    }
  });

  // #83 follow-up (grok 7eb2f5c3 item 2): only the task's lease holder may open a workspace.
  // A non-claimant gets 403 before any fork or token mint.
  test('a non-claimant cannot open a workspace on a task another agent holds', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    const claimed = await claim(env, task);
    assert.equal(claimed.status, 200, claimed.text);
    const before = { forks: artifacts.forks.length, tokens: artifacts.tokens.length };
    const foreign = await call(env, '/git/workspaces', { body: { task_id: task.id }, token: 'local-beta-fixture' });
    assert.equal(foreign.status, 403, foreign.text);
    assert.equal(foreign.json.error?.code, 'FORBIDDEN');
    assert.equal(foreign.text.includes('art_test_'), false);
    assert.deepEqual({ forks: artifacts.forks.length, tokens: artifacts.tokens.length }, before);
    assert.deepEqual((await rowsFor(task.id)).map(row => row.agent_id), ['synthetic:alpha']);
    const unclaimed = await createTask(env);
    const early = await call(env, '/git/workspaces', { body: { task_id: unclaimed.id } });
    assert.equal(early.status, 403, early.text);
    assert.deepEqual({ forks: artifacts.forks.length, tokens: artifacts.tokens.length }, before);
    const holder = await call(env, '/git/workspaces', { body: { task_id: task.id } });
    assert.equal(holder.status, 200, holder.text);
    assert.equal(artifacts.tokens.length, before.tokens + 1);
  });

  // dots 2740e7ad: the pre-checks alone do not cover a lease or can_post change during the
  // external fork or token mint. open rechecks after each side effect and withholds the token.
  test('an expired lease cannot open: 403, no fork, no token', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    await holdTask(boot.db, task.id);
    await boot.db.prepare('UPDATE task_leases SET expires_at_ms=? WHERE task_id=?').bind(Date.now() - 1, task.id).first();
    const opened = await call(env, '/git/workspaces', { body: { task_id: task.id } });
    assert.equal(opened.status, 403, opened.text);
    assert.deepEqual({ forks: artifacts.forks.length, tokens: artifacts.tokens.length }, { forks: 0, tokens: 0 });
  });

  test('a lease that moves during the fork mints no token; the fork stays for the owner to reuse', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    await holdTask(boot.db, task.id);
    artifacts.onFork = async () => { await holdTask(boot.db, task.id, 'synthetic:beta'); };
    const opened = await call(env, '/git/workspaces', { body: { task_id: task.id } });
    artifacts.onFork = null;
    assert.equal(opened.status, 403, opened.text);
    assert.equal(opened.text.includes('art_test_'), false);
    assert.equal(artifacts.tokens.length, 0);
    assert.equal(artifacts.forks.length, 1);
    assert.deepEqual((await rowsFor(task.id)).map(row => row.agent_id), ['synthetic:alpha']);
    await holdTask(boot.db, task.id);
    const reopened = await call(env, '/git/workspaces', { body: { task_id: task.id } });
    assert.equal(reopened.status, 200, reopened.text);
    assert.equal(artifacts.forks.length, 1);
  });

  test('can_post revoked while the token is minted: 403 and the minted token is withheld', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    await holdTask(boot.db, task.id);
    const setCanPost = (value: number) => boot.db.prepare("UPDATE memberships SET can_post=? WHERE principal_id='synthetic:alpha' AND room_id='room_main'").bind(value).first();
    artifacts.onIssue = async () => { await setCanPost(0); };
    try {
      const opened = await call(env, '/git/workspaces', { body: { task_id: task.id } });
      assert.equal(opened.status, 403, opened.text);
      assert.equal(artifacts.tokens.length, 1);
      assert.equal(opened.text.includes(String(artifacts.tokens[0]?.token)), false);
      assert.equal(opened.text.includes('art_test_'), false);
    } finally {
      artifacts.onIssue = null;
      await setCanPost(1);
    }
  });

  test('a lease that expires while the token is minted: 403 and the minted token is withheld', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    await holdTask(boot.db, task.id);
    artifacts.onIssue = async () => {
      await boot.db.prepare('UPDATE task_leases SET expires_at_ms=? WHERE task_id=?').bind(Date.now() - 1, task.id).first();
    };
    const opened = await call(env, '/git/workspaces', { body: { task_id: task.id } });
    artifacts.onIssue = null;
    assert.equal(opened.status, 403, opened.text);
    assert.equal(artifacts.tokens.length, 1);
    assert.equal(opened.text.includes('art_test_'), false);
  });

  // grok 6015457d item 2: the remaining cells of the before/after fork and mint matrix.
  test('can_post revoked during the fork: 403, no token; the fork row stays', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    await holdTask(boot.db, task.id);
    const setCanPost = (value: number) => boot.db.prepare("UPDATE memberships SET can_post=? WHERE principal_id='synthetic:alpha' AND room_id='room_main'").bind(value).first();
    artifacts.onFork = async () => { await setCanPost(0); };
    try {
      const opened = await call(env, '/git/workspaces', { body: { task_id: task.id } });
      assert.equal(opened.status, 403, opened.text);
      assert.equal(artifacts.tokens.length, 0);
      assert.equal(artifacts.forks.length, 1);
      assert.deepEqual((await rowsFor(task.id)).map(row => row.agent_id), ['synthetic:alpha']);
    } finally {
      artifacts.onFork = null;
      await setCanPost(1);
    }
  });

  test('a lease that expires during the fork: 403, no token', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    await holdTask(boot.db, task.id);
    artifacts.onFork = async () => {
      await boot.db.prepare('UPDATE task_leases SET expires_at_ms=? WHERE task_id=?').bind(Date.now() - 1, task.id).first();
    };
    const opened = await call(env, '/git/workspaces', { body: { task_id: task.id } });
    artifacts.onFork = null;
    assert.equal(opened.status, 403, opened.text);
    assert.equal(artifacts.tokens.length, 0);
    assert.equal(artifacts.forks.length, 1);
  });

  test('a lease that moves to another agent during the mint: 403 and the minted token is withheld', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    await holdTask(boot.db, task.id);
    artifacts.onIssue = async () => { await holdTask(boot.db, task.id, 'synthetic:beta'); };
    const opened = await call(env, '/git/workspaces', { body: { task_id: task.id } });
    artifacts.onIssue = null;
    assert.equal(opened.status, 403, opened.text);
    assert.equal(artifacts.tokens.length, 1);
    assert.equal(opened.text.includes(String(artifacts.tokens[0]?.token)), false);
    assert.equal(opened.text.includes('art_test_'), false);
  });

  // Documented gap (docs/specs/wrgit-open-contract.md): once open has returned a token, the
  // lease is not rechecked by submit. This test pins what the code does today.
  test('after open returns, an expired lease does not block submit (documented gap)', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    await holdTask(boot.db, task.id);
    const repo = repoName(task.id, 'synthetic:alpha');
    const opened = await call(env, '/git/workspaces', { body: { task_id: task.id } });
    assert.equal(opened.status, 200, opened.text);
    artifacts.addCommit(repo, HEAD_SHA);
    await boot.db.prepare('UPDATE task_leases SET expires_at_ms=? WHERE task_id=?').bind(Date.now() - 1, task.id).first();
    const reopen = await call(env, '/git/workspaces', { body: { task_id: task.id } });
    assert.equal(reopen.status, 403, reopen.text);
    const submitted = await call(env, `/git/workspaces/${repo}/submit`, { body: { sha: HEAD_SHA } });
    assert.equal(submitted.status, 200, submitted.text);
  });

  test('open mints the write token with an explicit bounded ttl', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    await holdTask(boot.db, task.id);
    const opened = await call(env, '/git/workspaces', { body: { task_id: task.id } });
    assert.equal(opened.status, 200, opened.text);
    assert.equal(artifacts.tokens[0]?.ttl, WRGIT_TOKEN_TTL_S);
    assert.ok(WRGIT_TOKEN_TTL_S > 0 && WRGIT_TOKEN_TTL_S <= 900, String(WRGIT_TOKEN_TTL_S));
  });

  // #83 follow-up (grok 7eb2f5c3 item 4): a can_post=1 member whose token lacks write scope
  // gets 403 on open, submit and merge. Membership alone is not enough.
  test('a can_post=1 member without write scope gets 403 on open, submit and merge', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    assert.equal((await claim(env, task)).status, 200);
    const repo = repoName(task.id, 'synthetic:alpha');
    artifacts.addCommit(repo, HEAD_SHA);
    const before = { forks: artifacts.forks.length, tokens: artifacts.tokens.length };
    const token = 'local-alpha-readonly-fixture';
    const opened = await call(env, '/git/workspaces', { body: { task_id: task.id }, token });
    assert.equal(opened.status, 403, opened.text);
    const submitted = await call(env, `/git/workspaces/${repo}/submit`, { body: { sha: HEAD_SHA }, token });
    assert.equal(submitted.status, 403, submitted.text);
    const merged = await call(env, '/git/merge', { body: { task_id: task.id, receipt_id: 'rcpt-scope' }, token });
    assert.equal(merged.status, 403, merged.text);
    assert.deepEqual({ forks: artifacts.forks.length, tokens: artifacts.tokens.length }, before);
    assert.equal((await rowsFor(task.id))[0]?.status, 'open');
    assert.equal(await boot.db.prepare('SELECT 1 FROM wrgit_merges WHERE task_id=?').bind(task.id).first(), null);
  });

  // WG-11 (grok 078c2b85): flag off means the adapter is never built, so no wrgit path can reach
  // the binding. Every binding property read is recorded; flag-off requests must record none.
  test('WRGIT_ENABLED off never builds the adapter: workspace, submit, merge and claim touch no binding and no wrgit row', async () => {
    const inner = new MemoryArtifacts();
    const touched: string[] = [];
    const spy = new Proxy(inner, { get(target, prop, receiver) { touched.push(String(prop)); return Reflect.get(target, prop, receiver); } });
    let built = 0;
    const counted = createApp(authenticate, { artifacts: () => { built += 1; return spy; } });
    const send = async (env: Env, path: string, body?: unknown) => {
      const headers: Record<string, string> = { authorization: 'Bearer local-alpha-fixture', 'idempotency-key': crypto.randomUUID() };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await counted.fetch(new Request('http://127.0.0.1' + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
      return { status: response.status, text: await response.text() };
    };
    const off = envFor(spy, false);
    const task = await createTask(envFor(undefined, false));
    built = 0; touched.length = 0;
    const repo = repoName(task.id, 'synthetic:alpha');
    assert.equal((await send(off, '/git/workspaces', { task_id: task.id })).status, 404);
    assert.equal((await send(off, '/git/workspaces/' + repo)).status, 404);
    assert.equal((await send(off, '/git/workspaces/' + repo + '/submit', { sha: HEAD_SHA })).status, 404);
    assert.equal((await send(off, '/git/merge', { task_id: task.id, receipt_id: 'rcpt-off' })).status, 404);
    const claimed = await send(off, `/api/v1/rooms/room_main/tasks/${task.id}/claim`, { schema_version: '1', expected_version: task.version, lease_epoch: task.lease_epoch });
    assert.equal(claimed.status, 200, claimed.text);
    // Unrelated route: unchanged by the flag.
    const read = await send(off, `/api/v1/rooms/room_main/tasks/${task.id}`);
    assert.equal(read.status, 200, read.text);
    assert.equal(built, 0);
    assert.deepEqual(touched, []);
    assert.deepEqual(await rowsFor(task.id), []);
    const on = envFor(spy, true);
    assert.equal((await send(on, `/api/v1/rooms/room_main/tasks/${task.id}`)).status, 200);
    assert.ok(built > 0, 'flag on builds the adapter');
  });

  test('flag off does not fork, and a reader cannot mint a token', async () => {
    const artifacts = new MemoryArtifacts();
    const off = envFor(artifacts, false);
    const task = await createTask(off);
    const denied = await call(off, '/git/workspaces', { body: { task_id: task.id } });
    assert.equal(denied.status, 404);
    assert.equal(artifacts.forks.length, 0);
    const claimed = await claim(off, task);
    assert.equal(claimed.status, 200, claimed.text);
    assert.equal(artifacts.forks.length, 0);
    assert.equal(claimed.text.includes('art_test_'), false);
    const on = envFor(artifacts, true);
    const reader = await call(on, '/git/workspaces', { body: { task_id: task.id }, token: 'local-reader-fixture' });
    assert.equal(reader.status, 403);
    assert.equal(artifacts.forks.length, 0);
    const outsider = await call(on, '/git/workspaces/' + repoName(task.id, 'synthetic:alpha'), { token: 'local-outsider-fixture' });
    assert.equal(outsider.status, 403);
  });

  test('claim creates the workspace when WRGIT_ENABLED=1 and does not mint or return a token', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    const repo = repoName(task.id, 'synthetic:alpha');
    const claimed = await claim(env, task);
    assert.equal(claimed.status, 200, claimed.text);
    assert.equal(claimed.text.includes('art_test_'), false);
    assert.equal(claimed.text.includes('remote_url'), false);
    assert.equal(artifacts.forks.length, 1);
    assert.deepEqual(artifacts.forks[0], { source: CANONICAL, name: repo });
    assert.equal(artifacts.tokens.length, 0);
    const stored = await rowsFor(task.id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.repo, repo);
    assert.equal(stored[0]?.base_sha, BASE_SHA);
    assert.equal(JSON.stringify(stored).includes('token'), false);
    const replay = await claim(env, { ...task, version: task.version + 1, lease_epoch: task.lease_epoch + 1 });
    assert.equal(replay.status, 409, replay.text);
    assert.equal(artifacts.forks.length, 1);
  });

  test('claim leaves the task open when Artifacts is not ready', async () => {
    const bare = new MemoryArtifacts();
    bare.repos.delete(CANONICAL);
    const env = envFor(bare, true);
    const task = await createTask(env);
    const claimed = await claim(env, task);
    assert.equal(claimed.status, 503, claimed.text);
    assert.equal(claimed.json.error?.code, 'UNAVAILABLE');
    assert.equal(claimed.text.includes('art_test_'), false);
    assert.equal(bare.forks.length, 0);
    const current = await call(env, `/api/v1/rooms/room_main/tasks/${task.id}`);
    assert.equal(current.status, 200, current.text);
    assert.equal((current.json.data as { task: { state: string } }).task.state, 'open');

    const unconfigured = await call(envFor(undefined, true), '/git/workspaces', { body: { task_id: task.id } });
    assert.equal(unconfigured.status, 503, unconfigured.text);
    assert.equal(unconfigured.json.error?.code, 'UNAVAILABLE');
  });

  test('a credential in the fork remote is not stored, returned, or logged', async () => {
    const artifacts = new MemoryArtifacts();
    const secret = 'art_test_embedded_secret';
    const fork = artifacts.fork.bind(artifacts);
    artifacts.fork = async (source, name) => {
      const repo = await fork(source, name);
      return { ...repo, remote: `https://x:${secret}@artifacts.cloudflare.net/${NAMESPACE}/${name}.git` };
    };
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    await holdTask(boot.db, task.id);
    const created = await call(env, '/git/workspaces', { body: { task_id: task.id } });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.text.includes(secret), false);
    assert.equal(String(created.json.data?.remote_url).includes('@'), false);
    const stored = JSON.stringify(await rowsFor(task.id));
    assert.equal(stored.includes(secret), false);
    assert.equal(logs.some(line => line.includes(secret)), false);
  });

  test('claimNext forks a workspace for the task it claims', async () => {
    await boot.db.prepare("UPDATE tasks SET state='canceled', version=version+1 WHERE state='open'").all();
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    const room = new Workroom(boot.db, 'synthetic:alpha', undefined, undefined, wrgitClaim(env, artifacts));
    const claimed = await room.tasks.claimNext({ schema_version: '1', room: 'room_main', idempotency_key: crypto.randomUUID() });
    const claimedId = (claimed.data as { task?: { id?: string } }).task?.id;
    assert.equal(claimedId, task.id);
    assert.deepEqual(artifacts.forks, [{ source: CANONICAL, name: repoName(task.id, 'synthetic:alpha') }]);
    assert.equal(artifacts.tokens.length, 0);
    assert.equal((await rowsFor(task.id)).length, 1);
    assert.equal(JSON.stringify(claimed).includes('art_test_'), false);
  });

  test('a failing token mint does not echo credential material', async () => {
    const artifacts = new MemoryArtifacts();
    artifacts.failIssue = new Error('art_test_secret leaked in upstream');
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    await holdTask(boot.db, task.id);
    const created = await call(env, '/git/workspaces', { body: { task_id: task.id } });
    assert.equal(created.status, 503, created.text);
    assert.equal(created.text.includes('art_test_secret'), false);
    assert.equal(created.text.includes('leaked'), false);
    assert.equal(logs.some(line => line.includes('art_test_secret')), false);
    const extra = await call(env, '/git/workspaces', { body: { task_id: task.id, token: 'art_test_secret' } });
    assert.equal(extra.status, 400, extra.text);
    assert.equal(extra.text.includes('art_test_secret'), false);
  });

  test('a failed fork keeps the claim pending and a retry completes the workspace', async () => {
    const artifacts = new MemoryArtifacts();
    artifacts.failFork = new Error('fork failed');
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    const failed = await claim(env, task);
    assert.equal(failed.status, 503, failed.text);
    assert.equal(failed.json.error?.code, 'UNAVAILABLE');
    assert.equal(failed.text.includes('fork failed'), false);
    assert.equal(logs.some(line => line.includes('fork failed')), false);
    const mid = await taskState(task.id);
    assert.equal(mid.state, 'in_progress');
    assert.equal(mid.holder_id, 'synthetic:alpha');
    const pending = await boot.db.prepare('SELECT task_id, agent_id, repo FROM wrgit_workspace_pending WHERE task_id=?').bind(task.id).all<{ task_id: string; agent_id: string; repo: string }>();
    assert.equal(pending.results.length, 1);
    assert.equal(pending.results[0]?.agent_id, 'synthetic:alpha');
    assert.equal((await rowsFor(task.id)).length, 0);
    assert.equal(artifacts.forks.length, 0);
    assert.equal(artifacts.tokens.length, 0);

    artifacts.failFork = null;
    const retry = await claim(env, { id: task.id, version: mid.version, lease_epoch: mid.lease_epoch });
    assert.equal(retry.status, 200, retry.text);
    assert.equal(retry.text.includes('art_test_'), false);
    assert.equal((await taskState(task.id)).state, 'in_progress');
    const stored = await rowsFor(task.id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.repo, pending.results[0]?.repo);
    assert.equal(stored[0]?.agent_id, 'synthetic:alpha');
    assert.equal(stored[0]?.base_sha, BASE_SHA);
    const left = await boot.db.prepare('SELECT COUNT(*) AS n FROM wrgit_workspace_pending WHERE task_id=?').bind(task.id).first<{ n: number }>();
    assert.equal(left?.n, 0);
    assert.equal(artifacts.tokens.length, 0);
    assert.equal(artifacts.forks.length, 1);
  });

  test('claimNext retry completes the pending workspace instead of claiming another task', async () => {
    await boot.db.prepare("UPDATE tasks SET state='canceled', version=version+1 WHERE state='open'").all();
    const artifacts = new MemoryArtifacts();
    artifacts.failFork = new Error('fork failed');
    const env = envFor(artifacts, true);
    const held = await createTask(env);
    const failed = await claim(env, held);
    assert.equal(failed.status, 503, failed.text);
    artifacts.failFork = null;
    const other = await createTask(env);
    const room = new Workroom(boot.db, 'synthetic:alpha', undefined, undefined, wrgitClaim(env, artifacts));
    const claimed = await room.tasks.claimNext({ schema_version: '1', room: 'room_main', idempotency_key: crypto.randomUUID() });
    const claimedId = (claimed.data as { task?: { id?: string } }).task?.id;
    assert.equal(claimedId, held.id);
    assert.notEqual(claimedId, other.id);
    assert.equal((await rowsFor(held.id)).length, 1);
    assert.equal((await rowsFor(other.id)).length, 0);
    assert.equal((await taskState(other.id)).state, 'open');
    assert.equal(JSON.stringify(claimed).includes('art_test_'), false);
  });

  test('distinct principals never share a workspace', async () => {
    const ids = ['agent:a', 'agent-a', 'agent/a', 'agent a'];
    const names = ids.map(id => workspaceRepoName('task-1', id));
    assert.equal(new Set(names).size, ids.length, names.join(' '));
    assert.notEqual(workspaceRepoName('task-1', 'agent:a'), workspaceRepoName('task-1', 'agent-a'));
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    const first = await ensureWorkspace(env, artifacts, task.id, 'agent:a');
    const second = await ensureWorkspace(env, artifacts, task.id, 'agent-a');
    assert.notEqual(first.repo, second.repo);
    assert.equal(first.agent_id, 'agent:a');
    assert.equal(second.agent_id, 'agent-a');
    const rows = await boot.db.prepare('SELECT agent_id, repo FROM wrgit_workspaces WHERE task_id=? ORDER BY agent_id').bind(task.id).all<{ agent_id: string; repo: string }>();
    assert.equal(rows.results.length, 2);
    assert.equal(new Set(rows.results.map(row => row.repo)).size, 2);
  });

  test('a binding lookup failure after claim keeps a pending marker and a retry finishes that task', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    let failedLookup = false;
    const get = artifacts.get.bind(artifacts);
    artifacts.get = async (name: string) => {
      if (!failedLookup && name === CANONICAL && (await taskState(task.id)).state === 'in_progress') {
        failedLookup = true;
        throw new Error('binding lookup failed');
      }
      return get(name);
    };
    const failed = await claim(env, task);
    assert.equal(failed.status, 503, failed.text);
    assert.equal(failed.json.error?.code, 'UNAVAILABLE');
    assert.equal(failed.text.includes('binding lookup failed'), false);
    assert.equal(logs.some(line => line.includes('binding lookup failed')), false);
    const mid = await taskState(task.id);
    assert.equal(mid.state, 'in_progress');
    assert.equal(mid.holder_id, 'synthetic:alpha');
    const pending = await boot.db.prepare('SELECT task_id, agent_id, repo FROM wrgit_workspace_pending WHERE task_id=?').bind(task.id).all<{ task_id: string; agent_id: string; repo: string }>();
    assert.equal(pending.results.length, 1);
    assert.equal(pending.results[0]?.agent_id, 'synthetic:alpha');
    assert.equal(pending.results[0]?.repo, repoName(task.id, 'synthetic:alpha'));
    assert.equal((await rowsFor(task.id)).length, 0);
    assert.equal(artifacts.forks.length, 0);
    assert.equal(artifacts.tokens.length, 0);

    const other = await createTask(env);
    const room = new Workroom(boot.db, 'synthetic:alpha', undefined, undefined, wrgitClaim(env, artifacts));
    const claimed = await room.tasks.claimNext({ schema_version: '1', room: 'room_main', idempotency_key: crypto.randomUUID() });
    const claimedId = (claimed.data as { task?: { id?: string } }).task?.id;
    assert.equal(claimedId, task.id);
    assert.notEqual(claimedId, other.id);
    assert.equal((await taskState(other.id)).state, 'open');
    const stored = await rowsFor(task.id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.repo, pending.results[0]?.repo);
    assert.equal(stored[0]?.base_sha, BASE_SHA);
    assert.equal((await rowsFor(other.id)).length, 0);
    const left = await boot.db.prepare('SELECT COUNT(*) AS n FROM wrgit_workspace_pending WHERE task_id=?').bind(task.id).first<{ n: number }>();
    assert.equal(left?.n, 0);
    assert.equal(artifacts.forks.length, 1);
    assert.equal(artifacts.tokens.length, 0);
    assert.equal(JSON.stringify(claimed).includes('art_test_'), false);
  });

  test('a workspace record write failure after claim keeps a pending marker and a retry finishes that task', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    const failed = await claim({ ...env, DB: failWorkspaceInsert(boot.db) }, task);
    assert.equal(failed.status, 503, failed.text);
    assert.equal(failed.json.error?.code, 'UNAVAILABLE');
    assert.equal(failed.text.includes('workspace record write failed'), false);
    assert.equal(logs.some(line => line.includes('workspace record write failed')), false);
    const mid = await taskState(task.id);
    assert.equal(mid.state, 'in_progress');
    assert.equal(mid.holder_id, 'synthetic:alpha');
    const pending = await boot.db.prepare('SELECT task_id, agent_id, repo FROM wrgit_workspace_pending WHERE task_id=?').bind(task.id).all<{ task_id: string; agent_id: string; repo: string }>();
    assert.equal(pending.results.length, 1);
    assert.equal(pending.results[0]?.repo, repoName(task.id, 'synthetic:alpha'));
    assert.equal((await rowsFor(task.id)).length, 0);
    assert.equal(artifacts.tokens.length, 0);

    const other = await createTask(env);
    const room = new Workroom(boot.db, 'synthetic:alpha', undefined, undefined, wrgitClaim(env, artifacts));
    const claimed = await room.tasks.claimNext({ schema_version: '1', room: 'room_main', idempotency_key: crypto.randomUUID() });
    const claimedId = (claimed.data as { task?: { id?: string } }).task?.id;
    assert.equal(claimedId, task.id);
    assert.notEqual(claimedId, other.id);
    assert.equal((await taskState(other.id)).state, 'open');
    const stored = await rowsFor(task.id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.repo, pending.results[0]?.repo);
    assert.equal(stored[0]?.agent_id, 'synthetic:alpha');
    assert.equal(stored[0]?.base_sha, BASE_SHA);
    assert.equal((await rowsFor(other.id)).length, 0);
    const left = await boot.db.prepare('SELECT COUNT(*) AS n FROM wrgit_workspace_pending WHERE task_id=?').bind(task.id).first<{ n: number }>();
    assert.equal(left?.n, 0);
    assert.equal(artifacts.tokens.length, 0);
    assert.equal(JSON.stringify(claimed).includes('art_test_'), false);
  });

  test('POST /git/workspaces stores canonical_repo and unit for the WG-5 merge path', async () => {
    // 0063 belongs to WG-5. When this worktree has not applied it, add the columns merge reads.
    const present = new Set((await boot.db.prepare("SELECT name FROM pragma_table_info('wrgit_workspaces')").all<{ name: string }>()).results.map(row => row.name));
    if (!present.has('canonical_repo')) {
      await boot.db.prepare(`ALTER TABLE wrgit_workspaces ADD COLUMN canonical_repo TEXT
        CHECK (canonical_repo IS NULL OR (length(canonical_repo) BETWEEN 1 AND 200))`).all();
    }
    if (!present.has('unit')) {
      await boot.db.prepare(`ALTER TABLE wrgit_workspaces ADD COLUMN unit TEXT
        CHECK (unit IS NULL OR (length(unit) BETWEEN 1 AND 128))`).all();
    }
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const task = await createTask(env);
    await holdTask(boot.db, task.id);
    const created = await call(env, '/git/workspaces', { body: { task_id: task.id } });
    assert.equal(created.status, 200, created.text);
    const row = await boot.db.prepare('SELECT canonical_repo, unit, repo FROM wrgit_workspaces WHERE task_id=?')
      .bind(task.id).first<{ canonical_repo: string | null; unit: string | null; repo: string }>();
    assert.ok(row);
    assert.equal(row.canonical_repo, CANONICAL);
    assert.equal(row.unit, task.id);
    assert.equal(row.repo, repoName(task.id, 'synthetic:alpha'));
    assert.equal(created.text.includes(String(created.json.data?.token)), true);
    assert.equal(logs.some(line => line.includes(String(created.json.data?.token))), false);
  });

  test('POST /git/workspaces for a missing task returns 404 and creates nothing', async () => {
    const artifacts = new MemoryArtifacts();
    const env = envFor(artifacts, true);
    const beforeWs = await boot.db.prepare('SELECT COUNT(*) AS n FROM wrgit_workspaces').first<{ n: number }>();
    const beforePending = await boot.db.prepare('SELECT COUNT(*) AS n FROM wrgit_workspace_pending').first<{ n: number }>();
    const missing = await call(env, '/git/workspaces', { body: { task_id: 'task-does-not-exist' } });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.ok, false);
    assert.equal(missing.json.error?.code, 'NOT_FOUND');
    assert.equal(artifacts.forks.length, 0);
    assert.equal(artifacts.tokens.length, 0);
    const afterWs = await boot.db.prepare('SELECT COUNT(*) AS n FROM wrgit_workspaces').first<{ n: number }>();
    const afterPending = await boot.db.prepare('SELECT COUNT(*) AS n FROM wrgit_workspace_pending').first<{ n: number }>();
    assert.equal(afterWs?.n, beforeWs?.n);
    assert.equal(afterPending?.n, beforePending?.n);
    assert.equal(missing.text.includes('art_test_'), false);
  });

  test('a pre-0063 workspace stays null after 0063 until reopen fills canonical_repo and unit for the merge read', async () => {
    const { db, close } = await pre0063Database();
    try {
      assert.equal((await columnNames(db, 'wrgit_workspaces')).includes('canonical_repo'), false);
      const artifacts = new MemoryArtifacts();
      const task = await createTaskOn(db);
      const created = await openOn(db, artifacts, task.id);
      assert.equal(created.status, 200, created.text);
      const token = String(created.json.data?.token);
      assert.equal(artifacts.forks.length, 1);
      assert.equal(artifacts.forks[0]?.source, CANONICAL);
      await applySql(db, WG5_0063);
      const before = await mergePathRead(db, task.id);
      assert.equal(before.canonical_repo, null);
      assert.equal(before.unit, null);
      assert.equal(before.repo, repoName(task.id, 'synthetic:alpha'));

      const reopened = await openOn(db, artifacts, task.id);
      assert.equal(reopened.status, 200, reopened.text);
      assert.equal(artifacts.forks.length, 1);
      const merged = await mergePathRead(db, task.id);
      assert.equal(merged.canonical_repo, CANONICAL);
      assert.equal(merged.unit, task.id);
      assert.equal(merged.id, before.id);
      assert.equal(merged.repo, before.repo);

      const again = await openOn(db, artifacts, task.id);
      assert.equal(again.status, 200, again.text);
      const kept = await mergePathRead(db, task.id);
      assert.equal(kept.canonical_repo, CANONICAL);
      assert.equal(kept.unit, task.id);
      assert.equal(artifacts.forks.length, 1);
      assert.equal(reopened.text.includes(token), false);
      assert.equal(logs.some(line => line.includes(token)), false);
    } finally { await close(); }
  });

  test('reopen fills only a missing merge field and does not replace one already stored', async () => {
    const { db, close } = await pre0063Database();
    try {
      const artifacts = new MemoryArtifacts();
      const partial = await createTaskOn(db);
      const stored = await createTaskOn(db);
      assert.equal((await openOn(db, artifacts, partial.id)).status, 200);
      assert.equal((await openOn(db, artifacts, stored.id)).status, 200);
      await applySql(db, WG5_0063);
      await db.prepare('UPDATE wrgit_workspaces SET unit=? WHERE task_id=?').bind('kept-unit', partial.id).all();
      await db.prepare('UPDATE wrgit_workspaces SET canonical_repo=?, unit=? WHERE task_id=?').bind('other/repo', 'kept-unit', stored.id).all();

      const keptOpen = await openOn(db, artifacts, stored.id);
      assert.equal(keptOpen.status, 200, keptOpen.text);
      const kept = await mergePathRead(db, stored.id);
      assert.equal(kept.canonical_repo, 'other/repo');
      assert.equal(kept.unit, 'kept-unit');

      const filled = await openOn(db, artifacts, partial.id);
      assert.equal(filled.status, 200, filled.text);
      const row = await mergePathRead(db, partial.id);
      assert.equal(row.canonical_repo, CANONICAL);
      assert.equal(row.unit, 'kept-unit');
      assert.equal(logs.some(line => line.includes('art_test_')), false);
    } finally { await close(); }
  });

  test('mismatched repo fails closed on reopen', async () => {
    const { db, close } = await pre0063Database();
    try {
      const artifacts = new MemoryArtifacts();
      const task = await createTaskOn(db);
      assert.equal((await openOn(db, artifacts, task.id)).status, 200);
      await applySql(db, WG5_0063);
      await db.prepare('UPDATE wrgit_workspaces SET repo=? WHERE task_id=?').bind('hand-made', task.id).all();
      artifacts.addRepo('hand-made', BASE_SHA);
      const later = (await migrationFileNames()).filter(name => Number(name.slice(0, 4)) > 63);
      await applyMigrationFiles(db, later);
      const before = await mergePathRead(db, task.id);
      assert.equal(before.canonical_repo, null, '0068 leaves a mismatched repo NULL');
      assert.equal(before.unit, null);
      const failed = await openOn(db, artifacts, task.id);
      assert.equal(failed.status, 503);
      assert.equal(failed.json.error?.code, 'NOT_READY');
      assert.match(failed.json.error?.message ?? '', /cannot be derived/);
      assert.equal(failed.text.includes('art_test_'), false);
      const row = await mergePathRead(db, task.id);
      assert.equal(row.canonical_repo, null);
      assert.equal(row.unit, null);
      assert.equal(logs.some(line => line.includes('art_test_')), false);
    } finally { await close(); }
  });

  test('deriveWorkspaceCanonicalRepo refuses an id or repo that is not the digest', () => {
    const taskId = 'task-digest';
    const agentId = 'agent:a';
    const digest = workspaceRepoName(taskId, agentId);
    const row = { id: digest, task_id: taskId, agent_id: agentId, repo: digest };
    assert.equal(deriveWorkspaceCanonicalRepo(row), CANONICAL);
    for (const bad of [{ ...row, id: 'not-the-digest' }, { ...row, repo: 'hand-made' }]) {
      assert.throws(() => deriveWorkspaceCanonicalRepo(bad), (error: unknown) => {
        assert.ok(error instanceof Fault);
        assert.equal(error.code, 'NOT_READY');
        assert.equal(error.status, 503);
        return true;
      });
    }
  });

  test('a migration after 0063 backfills canonical_repo and unit without reopen', async () => {
    const { db, close } = await pre0063Database();
    try {
      const artifacts = new MemoryArtifacts();
      const task = await createTaskOn(db);
      assert.equal((await openOn(db, artifacts, task.id)).status, 200);
      assert.equal(artifacts.forks.length, 1);
      await applySql(db, WG5_0063);
      await db.prepare("INSERT INTO local_migrations(name) VALUES ('0063_wrgit_merge.sql')").all();
      const before = await mergePathRead(db, task.id);
      assert.equal(before.canonical_repo, null);
      assert.equal(before.unit, null);
      await migrate(db as unknown as Awaited<ReturnType<Miniflare['getD1Database']>>, 75);
      const row = await mergePathRead(db, task.id);
      assert.equal(row.canonical_repo, CANONICAL);
      assert.equal(row.unit, task.id);
      assert.equal(row.repo, before.repo);
      assert.equal(artifacts.forks.length, 1);
      const guard = await db.prepare("SELECT name FROM sqlite_master WHERE name='wrgit_0068_backfill_guard'").first();
      assert.equal(guard, null);
      await migrate(db as unknown as Awaited<ReturnType<Miniflare['getD1Database']>>, 75);
      const again = await mergePathRead(db, task.id);
      assert.equal(again.canonical_repo, CANONICAL);
      assert.equal(again.unit, task.id);
    } finally { await close(); }
  });

  test('0068 fills a matching digest row and leaves a mismatched row null', async () => {
    const { db, close } = await pre0063Database();
    try {
      const artifacts = Object.assign(new MemoryArtifacts(), {
        fastForward: async () => { throw new Error('mismatched workspace must not fast-forward'); },
        fastForwardLog: async () => [],
      });
      const match = await createTaskOn(db);
      const miss = await createTaskOn(db);
      assert.equal((await openOn(db, artifacts, match.id)).status, 200);
      assert.equal((await openOn(db, artifacts, miss.id)).status, 200);
      await applySql(db, WG5_0063);
      await db.prepare('UPDATE wrgit_workspaces SET repo=? WHERE task_id=?').bind('hand-made', miss.id).all();
      artifacts.addRepo('hand-made', BASE_SHA);
      const later = (await migrationFileNames()).filter(name => Number(name.slice(0, 4)) > 63);
      await applyMigrationFiles(db, later);

      const filled = await mergePathRead(db, match.id);
      const digest = repoName(match.id, 'synthetic:alpha');
      assert.equal(filled.id, digest);
      assert.equal(filled.repo, digest);
      assert.equal(filled.canonical_repo, CANONICAL);
      assert.equal(filled.unit, match.id);

      const left = await mergePathRead(db, miss.id);
      assert.equal(left.id, repoName(miss.id, 'synthetic:alpha'));
      assert.equal(left.repo, 'hand-made');
      assert.equal(left.canonical_repo, null);
      assert.equal(left.unit, null);

      const reopened = await openOn(db, artifacts, miss.id);
      assert.equal(reopened.status, 503, reopened.text);
      assert.equal(reopened.json.error?.code, 'NOT_READY');
      const still = await mergePathRead(db, miss.id);
      assert.equal(still.canonical_repo, null);
      assert.equal(still.unit, null);

      const env = { DB: db, WRGIT_ENABLED: '1', ARTIFACTS: artifacts } as unknown as Env;
      const submitted = await call(env, `/git/workspaces/${left.id}/submit`, { body: { sha: BASE_SHA } });
      assert.equal(submitted.status, 200, submitted.text);
      await storePass(db, 'rcpt-miss', miss.id, BASE_SHA);
      const merged = await call(env, '/git/merge', { body: { task_id: miss.id, receipt_id: 'rcpt-miss' }, token: 'local-beta-fixture' });
      assert.equal(merged.status, 503, merged.text);
      assert.equal(merged.json.error?.code, 'NOT_READY');
      assert.match(merged.json.error?.message ?? '', /merge fields are missing/);
      const recorded = await db.prepare('SELECT sha FROM wrgit_merges WHERE task_id=?').bind(miss.id).first();
      assert.equal(recorded, null);
      assert.equal(logs.some(line => line.includes('art_test_')), false);
    } finally { await close(); }
  });

  test('0068 does not fill a 64-hex id that is not the task and agent digest', async () => {
    const { db, close } = await pre0063Database();
    try {
      const artifacts = Object.assign(new MemoryArtifacts(), {
        fastForward: async () => { throw new Error('forged workspace must not fast-forward'); },
        fastForwardLog: async () => [],
      });
      const task = await createTaskOn(db);
      const forged = 'ab'.repeat(32);
      const realTask = 'task-real-digest';
      const realAgent = 'agent:real';
      const real = repoName(realTask, realAgent);
      assert.equal(forged.length, 64);
      assert.notEqual(forged, repoName(task.id, 'synthetic:alpha'));
      assert.notEqual(real, forged);
      const insert = `INSERT INTO wrgit_workspaces (id, task_id, agent_id, repo, base_sha, head_sha, status, created_at, merged_at)
        VALUES (?, ?, ?, ?, ?, NULL, 'open', 1, NULL)`;
      await db.prepare(insert).bind(forged, task.id, 'synthetic:alpha', forged, BASE_SHA).all();
      await db.prepare(insert).bind(real, realTask, realAgent, real, BASE_SHA).all();
      await applySql(db, WG5_0063);
      const later = (await migrationFileNames()).filter(name => Number(name.slice(0, 4)) > 63);
      await applyMigrationFiles(db, later);

      const filled = await db.prepare('SELECT canonical_repo, unit, id, repo FROM wrgit_workspaces WHERE id=?')
        .bind(real).first<{ canonical_repo: string | null; unit: string | null; id: string; repo: string }>();
      assert.equal(filled?.id, real);
      assert.equal(filled?.repo, real);
      assert.equal(filled?.canonical_repo, CANONICAL);
      assert.equal(filled?.unit, realTask);

      const left = await db.prepare('SELECT canonical_repo, unit FROM wrgit_workspaces WHERE id=?')
        .bind(forged).first<{ canonical_repo: string | null; unit: string | null }>();
      assert.equal(left?.canonical_repo, null);
      assert.equal(left?.unit, null);

      artifacts.addRepo(forged, BASE_SHA);
      const env = { DB: db, WRGIT_ENABLED: '1', ARTIFACTS: artifacts } as unknown as Env;
      const submitted = await call(env, `/git/workspaces/${forged}/submit`, { body: { sha: BASE_SHA } });
      assert.equal(submitted.status, 200, submitted.text);
      await storePass(db, 'rcpt-forged', task.id, BASE_SHA);
      const merged = await call(env, '/git/merge', { body: { task_id: task.id, receipt_id: 'rcpt-forged' }, token: 'local-beta-fixture' });
      assert.equal(merged.status, 503, merged.text);
      assert.equal(merged.json.error?.code, 'NOT_READY');

      const reopened = await openOn(db, artifacts, task.id);
      assert.equal(reopened.status, 503, reopened.text);
      assert.equal(reopened.json.error?.code, 'NOT_READY');
      const still = await db.prepare('SELECT canonical_repo, unit FROM wrgit_workspaces WHERE id=?')
        .bind(forged).first<{ canonical_repo: string | null; unit: string | null }>();
      assert.equal(still?.canonical_repo, null);
      assert.equal(still?.unit, null);
      assert.equal(logs.some(line => line.includes('art_test_')), false);
    } finally { await close(); }
  });

  test('0075 renames the 0068 canonical name on applied rows and leaves every other value alone', { timeout: 60_000 }, async () => {
    const names = await migrationFileNames();
    const at = names.indexOf('0075_wrgit_canonical_rename.sql');
    assert.ok(at > 0);
    const { db, close } = await emptyDatabase('wrgit-0075-');
    try {
      await applyMigrationFiles(db, names.slice(0, at));
      const seed = (id: string, canonical: string | null) => db.prepare(
        'INSERT INTO wrgit_workspaces (id, task_id, repo, base_sha, agent_id, created_at, canonical_repo, unit, status) VALUES (?,?,?,?,?,?,?,?,\'open\')',
      ).bind(id, 'task-' + id, id, 'a'.repeat(40), 'agent:' + id, 1, canonical, canonical === null ? null : 'task-' + id);
      await db.batch([seed('ws-old', 'main/agent-workroom'), seed('ws-new', 'agent-workroom'), seed('ws-other', 'other/repo'), seed('ws-null', null)]);
      const read = async () => (await db.prepare('SELECT id, canonical_repo, unit FROM wrgit_workspaces ORDER BY id').all<{ id: string; canonical_repo: string | null; unit: string | null }>()).results;
      const before = await read();
      await applyMigrationFiles(db, [names[at]!]);
      const afterRows = await read();
      process.stderr.write('0075 apply output ' + JSON.stringify({ before, after: afterRows }) + '\n');
      assert.deepEqual(afterRows, [
        { id: 'ws-new', canonical_repo: 'agent-workroom', unit: 'task-ws-new' },
        { id: 'ws-null', canonical_repo: null, unit: null },
        { id: 'ws-old', canonical_repo: 'agent-workroom', unit: 'task-ws-old' },
        { id: 'ws-other', canonical_repo: 'other/repo', unit: 'task-ws-other' },
      ]);
      // Re-applying converges: nothing left to rename.
      await applyMigrationFiles(db, [names[at]!]);
      assert.deepEqual(await read(), afterRows);
    } finally { await close(); }
  });

  test('migrations apply in order 0063 then 0068 then 0071 then 0075 with no harness skip', { timeout: 60_000 }, async () => {
    const names = await migrationFileNames();
    const wrgit = names.filter(name => name.includes('wrgit'));
    assert.deepEqual(wrgit, [
      '0061_wrgit.sql',
      '0062_wrgit_ws.sql',
      '0063_wrgit_merge.sql',
      '0068_wrgit_ws_backfill.sql',
      '0071_wrgit_merge_settle.sql',
      '0072_wrgit_merge_fence.sql',
      '0073_wrgit_write_open_lease.sql',
      '0074_wrgit_write_open_owner.sql',
      '0075_wrgit_canonical_rename.sql',
    ]);
    const harness = await readFile('scripts/local-harness.ts', 'utf8');
    assert.equal(harness.includes('deferBackfill'), false);
    assert.equal(harness.includes('0064_'), false);
    const { db, close } = await emptyDatabase('wrgit-order-');
    try {
      let caught = '';
      try {
        await applyMigrationFiles(db, names);
      } catch (error) {
        caught = error instanceof Error ? error.message : String(error);
      }
      assert.equal(caught, '');
      const columns = await columnNames(db, 'wrgit_workspaces');
      assert.equal(columns.includes('canonical_repo'), true);
      assert.equal(columns.includes('unit'), true);
      const settle = await columnNames(db, 'wrgit_merge_intents');
      assert.equal(settle.includes('expected_sha'), true);
      assert.equal(settle.includes('outcome'), true);
      assert.equal(settle.includes('write_open_at'), true);
      assert.equal(settle.includes('fence_ok'), true);
      assert.equal(settle.includes('write_open_owner'), true);
      const applied = names.indexOf('0063_wrgit_merge.sql');
      const backfill = names.indexOf('0068_wrgit_ws_backfill.sql');
      const mergeSettle = names.indexOf('0071_wrgit_merge_settle.sql');
      const fence = names.indexOf('0072_wrgit_merge_fence.sql');
      const lease = names.indexOf('0073_wrgit_write_open_lease.sql');
      const owner = names.indexOf('0074_wrgit_write_open_owner.sql');
      assert.ok(applied >= 0 && backfill > applied && mergeSettle > backfill && fence > mergeSettle && lease > fence && owner > lease);
    } finally { await close(); }
  });
});

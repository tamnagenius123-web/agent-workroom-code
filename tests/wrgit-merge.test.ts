// WG-5: POST /git/workspaces/:id/submit {sha} and POST /git/merge {task_id, receipt_id}.
// Merge only when the phase-contract verifier receipt is PASS at exactly the submitted sha.
// Fast-forward canonical main when base_sha is the main head; otherwise 409 needs_rebase.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { migrate } from '../scripts/local-harness.ts';
import { taskFixtures } from '../scripts/task-fixtures.ts';
import { createApp } from '../src/server/app.ts';
import type { Database, Statement, Value } from '../src/server/db.ts';
import {
  GATE_VERSION, evaluateVerifierReceipt,
  type CaseRun, type ReceiptObservation,
} from '../src/server/verifier-receipt.ts';
import { RED_CASE_IDS } from '../src/phase-contracts/verifier-receipt.ts';
import type {
  ArtifactsBinding, ArtifactsCommit, ArtifactsCreateOptions, ArtifactsForkOptions,
  ArtifactsImportParams, ArtifactsLogOptions, ArtifactsRepoInfo, ArtifactsRepoRef, ArtifactsToken,
} from '../src/server/wrgit/artifacts-binding.ts';
import {
  ARTIFACTS_CALL_TIMEOUT_MS,
  MERGE_CLOCK_SKEW_MS,
  WRITE_OPEN_LEASE_MS,
  artifactsCallBudget,
  mergeClock,
  reclaimWriteOpen,
  takeoverExpiredLease,
} from '../src/server/wrgit/merge.ts';
import { acquireMergeLock, createWorkspace } from '../src/server/wrgit/store.ts';
import { WRGIT_CANONICAL_REPO } from '../src/server/wrgit/workspaces.ts';

const BASE = 'a'.repeat(40);
const SUBMITTED = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const WRONG = 'd'.repeat(40);
const CANONICAL = 'agent-workroom';
const UNIT = 'WG-5';
const AUTHOR = 'agent:author';
const VERIFIER = 'agent_acceptor';
// A non-author principal with write scope that drives /git/merge (WG-11: callers are bound to submit/merge).
const MERGER = 'agent:merger';

interface Commit {
  sha: string;
  message: string;
  parents: string[];
}

interface Forward {
  repo: string;
  ref: string;
  expectedHead: string;
  sha: string;
  message: string;
  signal?: AbortSignal;
}

interface StoredCommit {
  sha: string;
  message: string;
  parents: string[];
}

class MemoryRepo {
  commits = new Map<string, StoredCommit>();
  refs = new Map<string, string>();
  files = new Map<string, Uint8Array>();
  description = '';
  readOnly = false;
  defaultBranch = 'main';
  sourceUrl: string | null = null;
  name: string;
  binding: MemoryArtifacts;
  constructor(name: string, binding: MemoryArtifacts) {
    this.name = name;
    this.binding = binding;
  }
}

class MemoryArtifacts implements ArtifactsBinding {
  repos = new Map<string, MemoryRepo>();
  fastForwards: Forward[] = [];
  private forwardLog: { repo: string; operationId: string; ref: string; from: string; to: string; message: string }[] = [];
  onCanonicalGet: (() => Promise<void>) | null = null;
  // Resolves before the ref write. Case A parks here until the merge lock is expired.
  beforeFastForward: ((input: Forward) => Promise<void>) | null = null;
  // compareAndSet is present only when both are set. fastForward itself never reads D1.
  casOnLockGeneration = false;
  fenceDb: Database | null = null;
  calls: string[] = [];
  signalAbortedAtCall: boolean[] = [];

  ensure(name: string): MemoryRepo {
    let repo = this.repos.get(name);
    if (!repo) {
      repo = new MemoryRepo(name, this);
      this.repos.set(name, repo);
    }
    return repo;
  }

  private require(name: string): MemoryRepo {
    const repo = this.repos.get(name);
    if (!repo) throw new Error(`repo not found: ${name}`);
    return repo;
  }

  private refOf(name: string, branch = 'main'): ArtifactsRepoRef {
    return {
      name,
      remote: `https://artifacts.invalid/workroom/${name}.git`,
      defaultBranch: branch,
      token: 'art_test_not_a_secret',
    };
  }

  seed(name: string, main: string, commits: Commit[]): void {
    const repo = this.ensure(name);
    for (const commit of commits) repo.commits.set(commit.sha, { sha: commit.sha, message: commit.message, parents: [...commit.parents] });
    repo.refs.set('main', main);
  }

  advance(name: string, sha: string, message: string, parents: string[]): void {
    const repo = this.require(name);
    repo.commits.set(sha, { sha, message, parents: [...parents] });
    repo.refs.set('main', sha);
  }

  putCommit(name: string, sha: string, message: string, parents: string[]): void {
    const repo = this.require(name);
    repo.commits.set(sha, { sha, message, parents: [...parents] });
  }

  head(name: string, ref = 'main'): string | null {
    return this.repos.get(name)?.refs.get(ref) ?? null;
  }

  async create(name: string, opts?: ArtifactsCreateOptions): Promise<ArtifactsRepoRef> {
    const repo = this.ensure(name);
    repo.description = opts?.description ?? '';
    repo.readOnly = opts?.readOnly ?? false;
    repo.defaultBranch = opts?.defaultBranch ?? 'main';
    return this.refOf(name, repo.defaultBranch);
  }

  async import(params: ArtifactsImportParams): Promise<ArtifactsRepoRef> {
    const repo = this.ensure(params.name);
    repo.description = params.url;
    repo.sourceUrl = params.url;
    repo.defaultBranch = params.branch ?? 'main';
    if (params.depth !== undefined && params.depth < 0) throw new Error('depth');
    return this.refOf(params.name, repo.defaultBranch);
  }

  async fork(source: string, name: string, opts?: ArtifactsForkOptions): Promise<ArtifactsRepoRef> {
    const from = this.require(source);
    if (this.repos.has(name)) throw new Error('CONFLICT');
    const copy = this.ensure(name);
    copy.description = opts?.description ?? from.description;
    copy.readOnly = opts?.readOnly ?? false;
    copy.defaultBranch = from.defaultBranch;
    for (const [sha, commit] of from.commits) copy.commits.set(sha, { ...commit, parents: [...commit.parents] });
    if (opts?.defaultBranchOnly) {
      const head = from.refs.get(from.defaultBranch);
      if (head) copy.refs.set(copy.defaultBranch, head);
    } else {
      for (const [ref, sha] of from.refs) copy.refs.set(ref, sha);
    }
    return this.refOf(name, copy.defaultBranch);
  }

  async get(name: string): Promise<ArtifactsRepoInfo> {
    this.calls.push('get');
    const repo = this.require(name);
    if (name === CANONICAL && this.onCanonicalGet) await this.onCanonicalGet();
    return {
      name: repo.name,
      remote: `https://artifacts.invalid/workroom/${name}.git`,
      defaultBranch: repo.defaultBranch,
      headSha: repo.refs.get(repo.defaultBranch) ?? null,
      sourceUrl: repo.sourceUrl,
    };
  }

  async delete(name: string): Promise<boolean> {
    return this.repos.delete(name);
  }

  async issueToken(repoName: string, scope: 'read' | 'write' = 'write', ttlSeconds = 3600): Promise<ArtifactsToken> {
    this.require(repoName);
    const ttl = ttlSeconds > 0 ? ttlSeconds : 3600;
    return { token: 'art_test_not_a_secret', scope, expiresAt: Date.now() + ttl * 1000 };
  }

  async readFile(repoName: string, ref: string, path: string): Promise<Uint8Array | null> {
    if (!ref || !path) throw new Error('ref and path are required');
    return this.require(repoName).files.get(`${ref}:${path}`) ?? null;
  }

  async log(repoName: string, opts?: ArtifactsLogOptions): Promise<ArtifactsCommit[]> {
    this.calls.push('log');
    const repo = this.require(repoName);
    const ref = opts?.ref ?? repo.defaultBranch;
    let sha = repo.refs.get(ref) ?? (repo.commits.has(ref) ? ref : undefined);
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const out: ArtifactsCommit[] = [];
    let index = 0;
    const seen = new Set<string>();
    while (sha && out.length < limit) {
      if (seen.has(sha)) break;
      seen.add(sha);
      const commit = repo.commits.get(sha);
      if (!commit) break;
      if (index >= offset) {
        out.push({ hash: commit.sha, message: commit.message, authorName: AUTHOR, authoredAt: 1 });
      }
      index += 1;
      sha = commit.parents[0];
    }
    return out;
  }

  appendFastForward(repoName: string, row: { ref: string; from: string; to: string; message: string; operationId?: string }): void {
    this.require(repoName);
    this.forwardLog.push({
      repo: repoName,
      operationId: row.operationId ?? crypto.randomUUID(),
      ref: row.ref,
      from: row.from,
      to: row.to,
      message: row.message,
    });
  }

  private async writeForward(repoName: string, input: { ref: string; expectedHead: string; sha: string; message: string; lockGeneration?: number }): Promise<{ ref: string; from: string; to: string; message: string }> {
    const repo = this.require(repoName);
    const current = repo.refs.get(input.ref);
    if (current !== input.expectedHead) throw new Error(`not fast-forward: ${current} != ${input.expectedHead}`);
    if (!repo.commits.has(input.sha)) throw new Error(`missing sha ${input.sha}`);
    repo.refs.set(input.ref, input.sha);
    const operationId = crypto.randomUUID();
    this.forwardLog.push({
      repo: repoName,
      operationId,
      ref: input.ref,
      from: input.expectedHead,
      to: input.sha,
      message: input.message,
    });
    this.fastForwards.push({ repo: repoName, ...input });
    return { ref: input.ref, from: input.expectedHead, to: input.sha, message: input.message };
  }

  async fastForward(repoName: string, input: { ref: string; expectedHead: string; sha: string; message: string; lockGeneration?: number; signal?: AbortSignal }): Promise<{ ref: string; from: string; to: string; message: string }> {
    this.calls.push('fastForward');
    if (input.signal) this.signalAbortedAtCall.push(input.signal.aborted);
    if (this.beforeFastForward) await this.beforeFastForward({ repo: repoName, ...input });
    return this.writeForward(repoName, input);
  }

  get compareAndSet(): ((repoName: string, input: { ref: string; expectedHead: string; sha: string; message: string; lockGeneration?: number }) => Promise<{ ref: string; from: string; to: string; message: string }>) | undefined {
    if (!this.casOnLockGeneration || !this.fenceDb) return undefined;
    return (repoName, input) => this.casForward(repoName, input);
  }

  private async casForward(repoName: string, input: { ref: string; expectedHead: string; sha: string; message: string; lockGeneration?: number; signal?: AbortSignal }): Promise<{ ref: string; from: string; to: string; message: string }> {
    this.calls.push('compareAndSet');
    if (input.signal) this.signalAbortedAtCall.push(input.signal.aborted);
    if (this.beforeFastForward) await this.beforeFastForward({ repo: repoName, ...input });
    let current: number | null = null;
    try {
      const row = await this.fenceDb?.prepare('SELECT generation FROM wrgit_merge_fence WHERE id=1').first<{ generation: number }>();
      current = row?.generation ?? null;
    } catch {
      current = null;
    }
    if (current !== input.lockGeneration) {
      const error = new Error('stale_lock') as Error & { code?: string };
      error.code = 'stale_lock';
      throw error;
    }
    return this.writeForward(repoName, input);
  }

  async fastForwardLog(repoName: string): Promise<{ operationId: string; ref: string; from: string; to: string; message: string }[]> {
    this.calls.push('fastForwardLog');
    this.require(repoName);
    return this.forwardLog.filter(row => row.repo === repoName).map(row => ({
      operationId: row.operationId,
      ref: row.ref,
      from: row.from,
      to: row.to,
      message: row.message,
    }));
  }
}

interface ErrBody { ok: false; error: { code: string; message: string } }
interface OkBody { ok: true; data: Record<string, unknown> }
type Body = ErrBody | OkBody;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function passingRuns(): CaseRun[] {
  return RED_CASE_IDS.map(case_id => {
    const evidence = `log ${case_id} retained`;
    return { case_id, evidence, evidence_sha256: sha256(evidence) };
  });
}

function observation(over: Partial<ReceiptObservation> = {}): ReceiptObservation {
  const sha = over.sha ?? SUBMITTED;
  return {
    consumer: 'P2',
    producer_id: 'agent_author',
    acceptor_id: VERIFIER,
    next_maker: 'agent_author',
    author_lineage: { method: 'author.impl', dependencies: ['pkg-a'] },
    verifier_lineage: { method: 'verifier.impl', dependencies: ['pkg-a'] },
    sha,
    observed_sha: over.observed_sha ?? sha,
    claimed_gate_version: GATE_VERSION,
    task_id: 'task',
    attempt_id: 'attempt_1',
    artifact_digest: 'e'.repeat(64),
    verifier_id: VERIFIER,
    lease: { epoch: 'lease_1', stale: false },
    capability_label_as_authority: false,
    approval_events: ['accept'],
    observation_ok: true,
    runs: passingRuns(),
    ...over,
  };
}

async function database(): Promise<{ db: Database; close: () => Promise<void> }> {
  const d1 = await cloneD1(74);
  const mf = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: D1_TEMPLATE_NAME },
    d1Persist: d1.dir,
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const db = await mf.getD1Database('DB') as Database;
  await migrate(db, 74);
  await db.batch([
    db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
    db.prepare("INSERT INTO principals(id) VALUES ('synthetic:alpha')"),
    db.prepare("INSERT INTO memberships(principal_id, room_id, active, can_post) VALUES ('synthetic:alpha', 'room_main', 1, 1)"),
    ...[AUTHOR, VERIFIER, MERGER].flatMap(id => [
      db.prepare('INSERT INTO principals(id) VALUES (?)').bind(id),
      db.prepare("INSERT INTO memberships(principal_id, room_id, active, can_post) VALUES (?, 'room_main', 1, 1)").bind(id),
    ]),
  ]);
  return { db, close: () => mf.dispose().then(() => d1.cleanup()) };
}

function wrapDb(db: Database, hooks: {
  beforeFirst?: (sql: string) => Promise<void>;
  beforeAll?: (sql: string) => Promise<void>;
}): Database {
  function wrap(sql: string, stmt: Statement): Statement {
    return {
      bind(...args: Value[]) {
        return wrap(sql, stmt.bind(...args));
      },
      async first<T>() {
        if (hooks.beforeFirst) await hooks.beforeFirst(sql);
        return stmt.first<T>();
      },
      async all<T>() {
        if (hooks.beforeAll) await hooks.beforeAll(sql);
        return stmt.all<T>();
      },
    };
  }
  return {
    prepare(sql: string) {
      return wrap(sql, db.prepare(sql));
    },
    batch(statements) {
      return db.batch(statements);
    },
  };
}

function callerFor(path: string): string {
  if (path.endsWith('/submit')) return AUTHOR;
  if (path === '/git/merge') return MERGER;
  return 'synthetic:alpha';
}

function appFor(db: Database, artifacts: MemoryArtifacts, options: { wrgit?: boolean } = {}) {
  // The merge fake carries fastForward, which the native binding lacks, so it is injected already adapted.
  // x-test-as picks the caller. Submit defaults to the workspace author, merge to a non-author.
  const app = createApp(async request => request.headers.get('x-test-as') ?? 'synthetic:alpha', { ui: false, artifacts: () => artifacts });
  // /git/* is behind the flag (WG-11 dots 5468cfd3); these tests exercise the flag-on path unless told otherwise.
  const env = { DB: db, WRGIT_ENABLED: options.wrgit === false ? '0' : '1' };
  return {
    env,
    async post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Body }> {
      const response = await app.fetch(new Request(`http://127.0.0.1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-as': callerFor(path), ...headers },
        body: JSON.stringify(body),
      }), env);
      return { status: response.status, body: await response.json() as Body };
    },
  };
}

async function storeReceipt(db: Database, id: string, taskId: string, sha: string, hold: boolean): Promise<void> {
  const seen = observation({
    task_id: taskId,
    sha,
    observed_sha: sha,
    capability_label_as_authority: hold,
  });
  const evaluation = evaluateVerifierReceipt(seen);
  assert.equal(evaluation.disposition, hold ? 'HOLD' : 'PASS');
  assert.ok(evaluation.receipt);
  assert.equal(evaluation.receipt.verdict, hold ? 'HOLD' : 'PASS');
  assert.equal(evaluation.receipt.sha, sha);
  assert.equal(evaluation.receipt.observed_sha, sha);
  // The disposition column is not the gate. A HOLD receipt stored under PASS must still be rejected.
  await db.prepare(`INSERT INTO verifier_receipts(
      id, room_id, principal_id, disposition, observation_json, result_json, idempotency_key, recorded_at)
    VALUES (?, 'room_main', 'synthetic:alpha', ?, ?, ?, ?, ?)`)
    .bind(
      id,
      hold ? 'PASS' : evaluation.disposition,
      JSON.stringify(seen),
      JSON.stringify({ disposition: evaluation.disposition, receipt: evaluation.receipt, observation: seen }),
      `idem-${id}`,
      Date.now(),
    ).all();
}

async function seedWorkspace(db: Database, input: { id: string; taskId: string; repo: string; base: string; agentId?: string }): Promise<void> {
  await createWorkspace(db, {
    id: input.id,
    task_id: input.taskId,
    agent_id: input.agentId ?? AUTHOR,
    repo: input.repo,
    base_sha: input.base,
    created_at: Date.now(),
    canonical_repo: CANONICAL,
    unit: UNIT,
  });
  await db.prepare('UPDATE wrgit_workspaces SET canonical_repo=?, unit=? WHERE id=?')
    .bind(CANONICAL, UNIT, input.id).all();
}

function assertTrailers(message: unknown, receiptId: string, author = AUTHOR): void {
  assert.equal(typeof message, 'string');
  const lines = String(message).split('\n');
  assert.ok(lines.includes(`Unit: ${UNIT}`), String(message));
  assert.ok(lines.includes(`Author-Agent: ${author}`), String(message));
  assert.ok(lines.includes(`Verifier: ${VERIFIER}`), String(message));
  assert.ok(lines.includes(`Receipt: ${receiptId}`), String(message));
}

function codeOf(body: Body): string {
  assert.equal(body.ok, false);
  if (body.ok) return '';
  return body.error.code;
}

async function until(flag: () => boolean): Promise<void> {
  const start = Date.now();
  while (!flag()) {
    if (Date.now() - start > 5_000) assert.fail('timed out waiting for the in-flight receipt lookup');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('0063 extends the WG-2 wrgit index and 0061 stays the WG-2 store', async () => {
  const sql = await readFile('migrations/0063_wrgit_merge.sql', 'utf8');
  assert.match(sql, /submitted_sha/);
  assert.match(sql, /merged_sha/);
  assert.match(sql, /canonical_repo/);
  assert.match(sql, /CREATE TABLE wrgit_merges/);
  const wg2 = await readFile('migrations/0061_wrgit.sql', 'utf8');
  assert.match(wg2, /expires_at/);
  await assert.rejects(readFile('migrations/0061_wrgit_merge.sql', 'utf8'));
  await assert.rejects(readFile('src/server/wrgit/merge-lock.ts', 'utf8'));
  const markdown = await readFile('migrations/REGISTRY.md', 'utf8');
  assert.match(markdown, /\| 0061 \| .*0061_wrgit\.sql.* \| used \|/);
  assert.match(markdown, /\| 0062 \| .*0062_wrgit_ws\.sql.* \| used \|/);
  assert.match(markdown, /\| 0063 \| .*0063_wrgit_merge\.sql.* \| used \|/);
  assert.match(markdown, /^merge_order:.*0060 0061 0062 0063 0068 0071 0072 0073 0074 0075 0077\s*$/m);
  const registryModule = await import('../src/phase-contracts/migrations.ts');
  const registry = registryModule.MIGRATION_REGISTRY as Record<string, { status: string; unit: string }>;
  assert.equal(registry['0061']?.status, 'used');
  assert.match(registry['0061']?.unit ?? '', /0061_wrgit\.sql/);
  assert.equal(registry['0062']?.status, 'used');
  assert.match(registry['0062']?.unit ?? '', /0062_wrgit_ws\.sql/);
  assert.equal(registry['0063']?.status, 'used');
  assert.match(registry['0063']?.unit ?? '', /0063_wrgit_merge\.sql/);
});

test('PASS at the exact submitted sha fast-forwards canonical main with merge trailers', async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    artifacts.seed(CANONICAL, BASE, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
    ]);
    artifacts.seed('ws-pass', SUBMITTED, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
    ]);
    await seedWorkspace(db, { id: 'ws-pass', taskId: 'task-pass', repo: 'ws-pass', base: BASE });
    await storeReceipt(db, 'rcpt-pass', 'task-pass', SUBMITTED, false);
    const http = appFor(db, artifacts);

    const submitted = await http.post('/git/workspaces/ws-pass/submit', { sha: SUBMITTED });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.ok, true);
    if (!submitted.body.ok) return;
    assert.equal(submitted.body.data.sha, SUBMITTED);
    assert.equal(submitted.body.data.task_id, 'task-pass');
    assert.equal(submitted.body.data.workspace_id, 'ws-pass');

    const merged = await http.post('/git/merge', { task_id: 'task-pass', receipt_id: 'rcpt-pass' });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal(merged.body.ok, true);
    if (!merged.body.ok) return;
    assert.equal(merged.body.data.sha, SUBMITTED);
    assert.equal(merged.body.data.base_sha, BASE);
    assert.equal(merged.body.data.fast_forward, true);
    assert.equal(merged.body.data.canonical_repo, CANONICAL);
    assert.equal(merged.body.data.receipt_id, 'rcpt-pass');
    assertTrailers(merged.body.data.message, 'rcpt-pass');
    assert.equal(artifacts.head(CANONICAL), SUBMITTED);
    assert.equal(artifacts.fastForwards.length, 1);
    const forward = artifacts.fastForwards[0];
    assert.ok(forward);
    assert.equal(forward.repo, CANONICAL);
    assert.equal(forward.ref, 'main');
    assert.equal(forward.expectedHead, BASE);
    assert.equal(forward.sha, SUBMITTED);
    assert.equal(forward.message, merged.body.data.message);

    const stored = await db.prepare('SELECT sha, base_sha, message, receipt_id FROM wrgit_merges WHERE task_id=?')
      .bind('task-pass').first<{ sha: string; base_sha: string; message: string; receipt_id: string }>();
    assert.equal(stored?.sha, SUBMITTED);
    assert.equal(stored?.base_sha, BASE);
    assert.equal(stored?.receipt_id, 'rcpt-pass');
    assert.equal(stored?.message, merged.body.data.message);
  } finally {
    await close();
  }
});

test('a PASS receipt at a different sha is rejected', async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    artifacts.seed(CANONICAL, BASE, [{ sha: BASE, message: 'base', parents: [] }]);
    artifacts.seed('ws-wrong', WRONG, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: WRONG, message: 'other head', parents: [BASE] },
    ]);
    await seedWorkspace(db, { id: 'ws-wrong', taskId: 'task-wrong', repo: 'ws-wrong', base: BASE });
    await storeReceipt(db, 'rcpt-wrong', 'task-wrong', SUBMITTED, false);
    const http = appFor(db, artifacts);
    const submitted = await http.post('/git/workspaces/ws-wrong/submit', { sha: WRONG });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const merged = await http.post('/git/merge', { task_id: 'task-wrong', receipt_id: 'rcpt-wrong' });
    assert.equal(merged.status, 409, JSON.stringify(merged.body));
    assert.equal(codeOf(merged.body), 'sha_mismatch');
    assert.equal(artifacts.head(CANONICAL), BASE);
    assert.equal(artifacts.fastForwards.length, 0);
  } finally {
    await close();
  }
});

test('HOLD is rejected even when the receipt sha matches the submit and the column says PASS', async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    artifacts.seed(CANONICAL, BASE, [{ sha: BASE, message: 'base', parents: [] }]);
    artifacts.seed('ws-hold', SUBMITTED, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
    ]);
    await seedWorkspace(db, { id: 'ws-hold', taskId: 'task-hold', repo: 'ws-hold', base: BASE });
    await storeReceipt(db, 'rcpt-hold', 'task-hold', SUBMITTED, true);
    const http = appFor(db, artifacts);
    const submitted = await http.post('/git/workspaces/ws-hold/submit', { sha: SUBMITTED });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const merged = await http.post('/git/merge', { task_id: 'task-hold', receipt_id: 'rcpt-hold' });
    assert.equal(merged.status, 409, JSON.stringify(merged.body));
    assert.equal(codeOf(merged.body), 'verifier_hold');
    assert.equal(artifacts.head(CANONICAL), BASE);
    assert.equal(artifacts.fastForwards.length, 0);
  } finally {
    await close();
  }
});

test('non-FF returns 409 needs_rebase and leaves canonical main in place', async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    artifacts.seed(CANONICAL, OTHER, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: OTHER, message: 'main moved', parents: [BASE] },
    ]);
    artifacts.seed('ws-rebase', SUBMITTED, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
    ]);
    await seedWorkspace(db, { id: 'ws-rebase', taskId: 'task-rebase', repo: 'ws-rebase', base: BASE });
    await storeReceipt(db, 'rcpt-rebase', 'task-rebase', SUBMITTED, false);
    const http = appFor(db, artifacts);
    const submitted = await http.post('/git/workspaces/ws-rebase/submit', { sha: SUBMITTED });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const merged = await http.post('/git/merge', { task_id: 'task-rebase', receipt_id: 'rcpt-rebase' });
    assert.equal(merged.status, 409, JSON.stringify(merged.body));
    assert.equal(codeOf(merged.body), 'needs_rebase');
    assert.equal(artifacts.head(CANONICAL), OTHER);
    assert.equal(artifacts.fastForwards.length, 0);
    const source = await readFile('src/server/wrgit/merge.ts', 'utf8');
    assert.match(source, /TODO/);
    assert.match(source, /Sandbox rebase/);
  } finally {
    await close();
  }
});

test('merge lock contention lets one fast-forward win and rejects the other', { timeout: 60_000 }, async () => {
  const { db, close } = await database();
  let release = (): void => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  try {
    const artifacts = new MemoryArtifacts();
    artifacts.seed(CANONICAL, BASE, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
    ]);
    artifacts.seed('ws-lock', SUBMITTED, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
    ]);
    await seedWorkspace(db, { id: 'ws-lock', taskId: 'task-lock', repo: 'ws-lock', base: BASE });
    await storeReceipt(db, 'rcpt-lock', 'task-lock', SUBMITTED, false);
    const http = appFor(db, artifacts);
    const submitted = await http.post('/git/workspaces/ws-lock/submit', { sha: SUBMITTED });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    artifacts.onCanonicalGet = async () => {
      if (entered) return;
      entered = true;
      await gate;
    };
    const first = http.post('/git/merge', { task_id: 'task-lock', receipt_id: 'rcpt-lock' });
    const outcome = await Promise.race([
      (async () => {
        const start = Date.now();
        while (Date.now() - start < 5_000) {
          const row = await db.prepare('SELECT holder FROM wrgit_merge_lock WHERE id=1').first<{ holder: string | null }>();
          if (row?.holder) return 'locked' as const;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        return 'timeout' as const;
      })(),
      first.then(() => 'finished' as const),
    ]);
    if (outcome !== 'locked') {
      const done = await first;
      assert.fail(`expected the merge to hold wrgit_merge_lock, got ${outcome} status ${done.status} ${JSON.stringify(done.body)}`);
    }
    const second = await http.post('/git/merge', { task_id: 'task-lock', receipt_id: 'rcpt-lock' });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(codeOf(second.body), 'merge_locked');
    release();
    const winner = await first;
    assert.equal(winner.status, 200, JSON.stringify(winner.body));
    assert.equal(artifacts.head(CANONICAL), SUBMITTED);
    assert.equal(artifacts.fastForwards.length, 1);
    const row = await db.prepare('SELECT holder FROM wrgit_merge_lock WHERE id=1').first<{ holder: string | null }>();
    assert.equal(row?.holder ?? null, null);
  } finally {
    release();
    await close();
  }
});

test('resubmit during receipt lookup does not merge the old sha', { timeout: 20_000 }, async () => {
  const { db, close } = await database();
  let release = (): void => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let waiting = false;
  try {
    const artifacts = new MemoryArtifacts();
    artifacts.seed(CANONICAL, BASE, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'old head', parents: [BASE] },
    ]);
    artifacts.seed('ws-race', SUBMITTED, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'old head', parents: [BASE] },
    ]);
    await seedWorkspace(db, { id: 'ws-race', taskId: 'task-race', repo: 'ws-race', base: BASE });
    await storeReceipt(db, 'rcpt-race', 'task-race', SUBMITTED, false);
    const http = appFor(wrapDb(db, {
      async beforeFirst(sql) {
        if (!waiting && sql.includes('verifier_receipts')) {
          waiting = true;
          await gate;
        }
      },
    }), artifacts);
    const submitted = await http.post('/git/workspaces/ws-race/submit', { sha: SUBMITTED });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const pending = http.post('/git/merge', { task_id: 'task-race', receipt_id: 'rcpt-race' });
    await until(() => waiting);
    artifacts.advance('ws-race', OTHER, 'new head', [SUBMITTED]);
    const resubmitted = await http.post('/git/workspaces/ws-race/submit', { sha: OTHER });
    assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));
    release();
    const merged = await pending;
    assert.equal(merged.status, 409, JSON.stringify(merged.body));
    assert.equal(codeOf(merged.body), 'sha_mismatch');
    assert.equal(artifacts.head(CANONICAL), BASE);
    assert.equal(artifacts.fastForwards.length, 0);
    const row = await db.prepare('SELECT submitted_sha, merged_sha FROM wrgit_workspaces WHERE id=?')
      .bind('ws-race').first<{ submitted_sha: string | null; merged_sha: string | null }>();
    assert.equal(row?.submitted_sha, OTHER);
    assert.equal(row?.merged_sha, null);
  } finally {
    release();
    await close();
  }
});

test('a fast-forward that loses its db write retries as success when main is already at the sha', { timeout: 20_000 }, async () => {
  const { db, close } = await database();
  let failInsert = true;
  try {
    const artifacts = new MemoryArtifacts();
    artifacts.seed(CANONICAL, BASE, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
    ]);
    artifacts.seed('ws-retry', SUBMITTED, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
    ]);
    await seedWorkspace(db, { id: 'ws-retry', taskId: 'task-retry', repo: 'ws-retry', base: BASE });
    await storeReceipt(db, 'rcpt-retry', 'task-retry', SUBMITTED, false);
    const http = appFor(wrapDb(db, {
      async beforeAll(sql) {
        if (failInsert && sql.includes('INSERT INTO wrgit_merges')) {
          failInsert = false;
          throw new Error('injected write failure');
        }
      },
    }), artifacts);
    const submitted = await http.post('/git/workspaces/ws-retry/submit', { sha: SUBMITTED });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const first = await http.post('/git/merge', { task_id: 'task-retry', receipt_id: 'rcpt-retry' });
    assert.notEqual(first.status, 200, JSON.stringify(first.body));
    assert.equal(artifacts.head(CANONICAL), SUBMITTED);
    assert.equal(artifacts.fastForwards.length, 1);
    const missing = await db.prepare('SELECT sha FROM wrgit_merges WHERE task_id=?').bind('task-retry').first<{ sha: string }>();
    assert.equal(missing, null);

    const retried = await http.post('/git/merge', { task_id: 'task-retry', receipt_id: 'rcpt-retry' });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.ok, true);
    if (!retried.body.ok) return;
    assert.equal(retried.body.data.sha, SUBMITTED);
    assert.equal(retried.body.data.fast_forward, true);
    assert.equal(artifacts.head(CANONICAL), SUBMITTED);
    assert.equal(artifacts.fastForwards.length, 1);
    const stored = await db.prepare('SELECT sha, receipt_id FROM wrgit_merges WHERE task_id=?')
      .bind('task-retry').first<{ sha: string; receipt_id: string }>();
    assert.equal(stored?.sha, SUBMITTED);
    assert.equal(stored?.receipt_id, 'rcpt-retry');
    const row = await db.prepare('SELECT submitted_sha, merged_sha FROM wrgit_workspaces WHERE id=?')
      .bind('ws-retry').first<{ submitted_sha: string | null; merged_sha: string | null }>();
    assert.equal(row?.submitted_sha, SUBMITTED);
    assert.equal(row?.merged_sha, SUBMITTED);
  } finally {
    await close();
  }
});

test('submit rejects a sha that is not the workspace head', async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    artifacts.seed(CANONICAL, BASE, [{ sha: BASE, message: 'base', parents: [] }]);
    artifacts.seed('ws-head', SUBMITTED, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
    ]);
    await seedWorkspace(db, { id: 'ws-head', taskId: 'task-head', repo: 'ws-head', base: BASE });
    const http = appFor(db, artifacts);
    const submitted = await http.post('/git/workspaces/ws-head/submit', { sha: BASE });
    assert.ok(submitted.status === 409 || submitted.status === 422, JSON.stringify(submitted.body));
    assert.equal(codeOf(submitted.body), 'not_head');
    const row = await db.prepare('SELECT submitted_sha FROM wrgit_workspaces WHERE id=?')
      .bind('ws-head').first<{ submitted_sha: string | null }>();
    assert.equal(row?.submitted_sha, null);
    assert.equal(artifacts.head('ws-head'), SUBMITTED);
    assert.equal(artifacts.fastForwards.length, 0);
  } finally {
    await close();
  }
});

test('a receipt verified by the workspace author is rejected', async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    artifacts.seed(CANONICAL, BASE, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
    ]);
    artifacts.seed('ws-self', SUBMITTED, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
    ]);
    await seedWorkspace(db, { id: 'ws-self', taskId: 'task-self', repo: 'ws-self', base: BASE, agentId: VERIFIER });
    await storeReceipt(db, 'rcpt-self', 'task-self', SUBMITTED, false);
    const http = appFor(db, artifacts);
    const submitted = await http.post('/git/workspaces/ws-self/submit', { sha: SUBMITTED }, { 'x-test-as': VERIFIER });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const merged = await http.post('/git/merge', { task_id: 'task-self', receipt_id: 'rcpt-self' });
    assert.equal(merged.status, 409, JSON.stringify(merged.body));
    assert.equal(codeOf(merged.body), 'self_verification');
    assert.equal(artifacts.head(CANONICAL), BASE);
    assert.equal(artifacts.fastForwards.length, 0);
    const row = await db.prepare('SELECT merged_sha FROM wrgit_workspaces WHERE id=?')
      .bind('ws-self').first<{ merged_sha: string | null }>();
    assert.equal(row?.merged_sha, null);
  } finally {
    await close();
  }
});

test('a dead lock holder is replaced after expires_at and the merge completes', { timeout: 20_000 }, async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    artifacts.seed(CANONICAL, BASE, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
    ]);
    artifacts.seed('ws-expire', SUBMITTED, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
    ]);
    await seedWorkspace(db, { id: 'ws-expire', taskId: 'task-expire', repo: 'ws-expire', base: BASE });
    await storeReceipt(db, 'rcpt-expire', 'task-expire', SUBMITTED, false);
    const http = appFor(db, artifacts);
    const submitted = await http.post('/git/workspaces/ws-expire/submit', { sha: SUBMITTED });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const planted = await acquireMergeLock(db, { holder: 'agent:dead', ttlMs: 1_000, nowMs: Date.now() - 60_000 });
    assert.equal(planted.acquired, true);
    assert.equal(planted.lock.holder, 'agent:dead');
    assert.ok((planted.lock.expires_at ?? Number.POSITIVE_INFINITY) <= Date.now());
    const merged = await http.post('/git/merge', { task_id: 'task-expire', receipt_id: 'rcpt-expire' });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal(merged.body.ok, true);
    if (!merged.body.ok) return;
    assert.equal(merged.body.data.sha, SUBMITTED);
    assert.equal(artifacts.head(CANONICAL), SUBMITTED);
    assert.equal(artifacts.fastForwards.length, 1);
    const row = await db.prepare('SELECT holder, expires_at FROM wrgit_merge_lock WHERE id=1')
      .first<{ holder: string | null; expires_at: number | null }>();
    assert.equal(row?.holder ?? null, null);
    assert.equal(row?.expires_at ?? null, null);
    const stored = await db.prepare('SELECT merged_sha FROM wrgit_workspaces WHERE id=?')
      .bind('ws-expire').first<{ merged_sha: string | null }>();
    assert.equal(stored?.merged_sha, SUBMITTED);
  } finally {
    await close();
  }
});

test('an expired merge lock cannot fast-forward or record the old sha after a new holder submits', { timeout: 20_000 }, async () => {
  const { db, close } = await database();
  let armed = false;
  try {
    const artifacts = new MemoryArtifacts();
    artifacts.seed(CANONICAL, BASE, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'old head', parents: [BASE] },
    ]);
    artifacts.seed('ws-fence', SUBMITTED, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'old head', parents: [BASE] },
    ]);
    await seedWorkspace(db, { id: 'ws-fence', taskId: 'task-fence', repo: 'ws-fence', base: BASE });
    await storeReceipt(db, 'rcpt-fence', 'task-fence', SUBMITTED, false);
    const http = appFor(db, artifacts);
    const submitted = await http.post('/git/workspaces/ws-fence/submit', { sha: SUBMITTED });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    artifacts.onCanonicalGet = async () => {
      if (armed) return;
      armed = true;
      await db.prepare('UPDATE wrgit_merge_lock SET acquired_at=1, expires_at=1 WHERE id=1 AND holder IS NOT NULL').all();
      artifacts.advance('ws-fence', OTHER, 'new head', [SUBMITTED]);
      const resubmitted = await http.post('/git/workspaces/ws-fence/submit', { sha: OTHER });
      assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));
      const lock = await db.prepare('SELECT holder, acquired_at, expires_at FROM wrgit_merge_lock WHERE id=1')
        .first<{ holder: string | null; acquired_at: number | null; expires_at: number | null }>();
      const clear = lock?.holder == null && lock?.acquired_at == null && lock?.expires_at == null;
      const full = lock?.holder != null && lock?.acquired_at != null && lock?.expires_at != null && lock.expires_at >= lock.acquired_at;
      assert.equal(clear || full, true);
    };
    const merged = await http.post('/git/merge', { task_id: 'task-fence', receipt_id: 'rcpt-fence' });
    assert.equal(artifacts.head(CANONICAL), BASE);
    assert.equal(artifacts.fastForwards.length, 0);
    assert.equal(merged.status, 409, JSON.stringify(merged.body));
    assert.equal(codeOf(merged.body), 'stale_lock');
    assert.equal(merged.body.ok, false);
    if (!merged.body.ok) {
      assert.match(merged.body.error.message, /no longer belongs to this execution/);
      assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(merged.body.error.message), false);
    }
    const recorded = await db.prepare('SELECT sha FROM wrgit_merges WHERE task_id=?').bind('task-fence').first<{ sha: string }>();
    assert.equal(recorded, null);
    const row = await db.prepare('SELECT submitted_sha, merged_sha FROM wrgit_workspaces WHERE id=?')
      .bind('ws-fence').first<{ submitted_sha: string | null; merged_sha: string | null }>();
    assert.equal(row?.submitted_sha, OTHER);
    assert.equal(row?.merged_sha, null);
  } finally {
    await close();
  }
});

test('canonical already at the submitted sha without this submission attempt fails closed', async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    artifacts.seed(CANONICAL, SUBMITTED, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'already canonical', parents: [BASE] },
    ]);
    artifacts.seed('ws-unproven', SUBMITTED, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
    ]);
    await seedWorkspace(db, { id: 'ws-unproven', taskId: 'task-unproven', repo: 'ws-unproven', base: BASE });
    await storeReceipt(db, 'rcpt-unproven', 'task-unproven', SUBMITTED, false);
    const http = appFor(db, artifacts);
    const submitted = await http.post('/git/workspaces/ws-unproven/submit', { sha: SUBMITTED });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const merged = await http.post('/git/merge', { task_id: 'task-unproven', receipt_id: 'rcpt-unproven' });
    assert.equal(merged.status, 409, JSON.stringify(merged.body));
    assert.equal(codeOf(merged.body), 'unproven_fast_forward');
    assert.equal(merged.body.ok, false);
    if (!merged.body.ok) assert.match(merged.body.error.message, /without a recorded merge attempt/);
    assert.equal(artifacts.head(CANONICAL), SUBMITTED);
    assert.equal(artifacts.fastForwards.length, 0);
    const recorded = await db.prepare('SELECT sha FROM wrgit_merges WHERE task_id=?').bind('task-unproven').first<{ sha: string }>();
    assert.equal(recorded, null);
    const row = await db.prepare('SELECT merged_sha FROM wrgit_workspaces WHERE id=?')
      .bind('ws-unproven').first<{ merged_sha: string | null }>();
    assert.equal(row?.merged_sha, null);
  } finally {
    await close();
  }
});

test('a workspace opened through the WG-3 route merges through WG-5', { timeout: 20_000 }, async () => {
  const { db, close } = await database();
  const lines: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const original = Object.fromEntries(methods.map(name => [name, console[name]])) as Record<(typeof methods)[number], (...args: unknown[]) => void>;
  for (const name of methods) {
    console[name] = (...args: unknown[]) => {
      lines.push(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '));
    };
  }
  try {
    await taskFixtures(db as unknown as Parameters<typeof taskFixtures>[0]);
    const artifacts = new MemoryArtifacts();
    artifacts.seed(WRGIT_CANONICAL_REPO, BASE, [{ sha: BASE, message: 'base', parents: [] }]);
    const http = appFor(db, artifacts, { wrgit: true });
    const made = await http.post('/api/v1/rooms/room_main/tasks', {
      schema_version: '1', goal: 'wg3 workspace merge', done_conditions: ['verified'],
    }, { 'idempotency-key': crypto.randomUUID() });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(made.body.ok, true);
    if (!made.body.ok) return;
    const taskId = (made.body.data as { task?: { id?: string } }).task?.id;
    assert.equal(typeof taskId, 'string');
    if (!taskId) return;
    // Only the claimant opens a workspace (#83 follow-up): take the lease as the default caller first.
    await db.batch([
      db.prepare("UPDATE tasks SET state='in_progress', version=version+1 WHERE id=?").bind(taskId),
      db.prepare('UPDATE task_leases SET holder_id=?, lease_epoch=lease_epoch+1, expires_at_ms=? WHERE task_id=?').bind(callerFor('/git/workspaces'), Date.now() + 3_600_000, taskId),
    ]);
    const opened = await http.post('/git/workspaces', { task_id: taskId });
    assert.equal(opened.status, 200, opened.body.ok ? 'workspace open failed' : JSON.stringify(opened.body));
    const stored = await db.prepare('SELECT id, repo, base_sha, canonical_repo, unit FROM wrgit_workspaces WHERE task_id=?')
      .bind(taskId).first<{ id: string; repo: string; base_sha: string; canonical_repo: string | null; unit: string | null }>();
    assert.ok(stored);
    assert.equal(stored.canonical_repo, WRGIT_CANONICAL_REPO);
    assert.equal(stored.unit, taskId);
    assert.equal(stored.base_sha, BASE);
    artifacts.advance(stored.repo, SUBMITTED, 'workspace head', [BASE]);
    artifacts.putCommit(WRGIT_CANONICAL_REPO, SUBMITTED, 'workspace head', [BASE]);
    await storeReceipt(db, 'rcpt-wg3', taskId, SUBMITTED, false);
    const submitted = await http.post(`/git/workspaces/${stored.id}/submit`, { sha: SUBMITTED }, { 'x-test-as': 'synthetic:alpha' });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const merged = await http.post('/git/merge', { task_id: taskId, receipt_id: 'rcpt-wg3' });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal(merged.body.ok, true);
    if (!merged.body.ok) return;
    assert.equal(merged.body.data.sha, SUBMITTED);
    assert.equal(merged.body.data.canonical_repo, WRGIT_CANONICAL_REPO);
    assert.equal(merged.body.data.fast_forward, true);
    const message = String(merged.body.data.message);
    assert.ok(message.includes(`Unit: ${taskId}`), message);
    assert.ok(message.includes('Author-Agent: synthetic:alpha'), message);
    assert.ok(message.includes(`Verifier: ${VERIFIER}`), message);
    assert.ok(message.includes('Receipt: rcpt-wg3'), message);
    assert.equal(artifacts.head(WRGIT_CANONICAL_REPO), SUBMITTED);
    assert.equal(artifacts.fastForwards.length, 1);
    const row = await db.prepare('SELECT merged_sha FROM wrgit_workspaces WHERE id=?')
      .bind(stored.id).first<{ merged_sha: string | null }>();
    assert.equal(row?.merged_sha, SUBMITTED);
    const token = opened.body.ok ? String(opened.body.data.token ?? '') : '';
    assert.equal(token.length > 0, true);
    assert.equal(lines.some(line => line.includes(token)), false);
    assert.equal(JSON.stringify(merged.body).includes(token), false);
  } finally {
    for (const name of methods) console[name] = original[name] as typeof console.log;
    await close();
  }
});

// Parks inside the ref update until the test expires wrgit_merge_lock, then until release().
// compareAndSet checks the generation after this park and before the write.
// A D1-blind fastForward writes after the park. Source rechecks the generation after that call returns.
function stallFastForward(db: Database, artifacts: MemoryArtifacts): { entered: () => boolean; expired: () => boolean; release: () => void } {
  let saw = false;
  let didExpire = false;
  let releaseGate = (): void => {};
  const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  artifacts.beforeFastForward = async () => {
    if (saw) return;
    saw = true;
    const start = Date.now();
    while (Date.now() - start < 5_000) {
      const row = await db.prepare('SELECT expires_at FROM wrgit_merge_lock WHERE id=1').first<{ expires_at: number | null }>();
      if (row?.expires_at != null && row.expires_at <= Date.now()) {
        didExpire = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!didExpire) throw new Error('fast-forward did not stall until the lock expired');
    await gate;
  };
  return {
    entered: () => saw,
    expired: () => didExpire,
    release: () => releaseGate(),
  };
}

async function mergeRows(db: Database, taskId?: string): Promise<{ task_id: string; sha: string; stale?: number }[]> {
  const sql = taskId
    ? 'SELECT task_id, sha FROM wrgit_merges WHERE task_id=?'
    : 'SELECT task_id, sha FROM wrgit_merges';
  const loaded = taskId
    ? await db.prepare(sql).bind(taskId).all<{ task_id: string; sha: string }>()
    : await db.prepare(sql).all<{ task_id: string; sha: string }>();
  return loaded.results;
}

async function settleIntents(db: Database, artifacts: MemoryArtifacts): Promise<{ recorded: number; released: number }> {
  const mod = await import('../src/server/wrgit/merge.ts');
  const reconcile = (mod as { reconcileMergeIntents?: (db: Database, artifacts: MemoryArtifacts) => Promise<{ recorded: number; released: number }> }).reconcileMergeIntents;
  assert.equal(typeof reconcile, 'function', 'an open intent with no merge row stays in doubt until reconciliation reads Artifacts');
  return reconcile!(db, artifacts);
}

function canonicalBase(): MemoryArtifacts {
  const artifacts = new MemoryArtifacts();
  artifacts.seed(CANONICAL, BASE, [
    { sha: BASE, message: 'base', parents: [] },
    { sha: SUBMITTED, message: 'old head', parents: [BASE] },
  ]);
  return artifacts;
}

async function openSubmitted(db: Database, artifacts: MemoryArtifacts, input: { id: string; taskId: string; repo: string; sha: string; receiptId: string }): Promise<void> {
  artifacts.putCommit(CANONICAL, input.sha, 'workspace head', [BASE]);
  artifacts.seed(input.repo, input.sha, [
    { sha: BASE, message: 'base', parents: [] },
    { sha: input.sha, message: 'workspace head', parents: [BASE] },
  ]);
  await seedWorkspace(db, { id: input.id, taskId: input.taskId, repo: input.repo, base: BASE });
  await storeReceipt(db, input.receiptId, input.taskId, input.sha, false);
}

test('a fast-forward that lands after the lock generation moves stays a hold', { timeout: 20_000 }, async () => {
  const { db, close } = await database();
  const artifacts = canonicalBase();
  const stall = stallFastForward(db, artifacts);
  let pending: Promise<{ status: number; body: Body }> = Promise.resolve({ status: 0, body: { ok: false, error: { code: '', message: '' } } });
  try {
    await openSubmitted(db, artifacts, { id: 'ws-delay', taskId: 'task-delay', repo: 'ws-delay', sha: SUBMITTED, receiptId: 'rcpt-delay' });
    const http = appFor(db, artifacts);
    const submitted = await http.post('/git/workspaces/ws-delay/submit', { sha: SUBMITTED });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    pending = http.post('/git/merge', { task_id: 'task-delay', receipt_id: 'rcpt-delay' });
    await until(() => stall.entered());
    await db.prepare('UPDATE wrgit_merge_lock SET acquired_at=1, expires_at=1 WHERE id=1 AND holder IS NOT NULL').all();
    await until(() => stall.expired());
    artifacts.advance('ws-delay', OTHER, 'later submission', [SUBMITTED]);
    const resubmitted = await http.post('/git/workspaces/ws-delay/submit', { sha: OTHER });
    assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));
    const during = await db.prepare('SELECT submitted_sha FROM wrgit_workspaces WHERE id=?')
      .bind('ws-delay').first<{ submitted_sha: string | null }>();
    assert.equal(during?.submitted_sha, OTHER);
    stall.release();
    const late = await pending;
    assert.equal(late.status, 409, JSON.stringify(late.body));
    assert.equal(codeOf(late.body), 'stale_lock');
    assert.equal(artifacts.head(CANONICAL), SUBMITTED);
    assert.equal((await mergeRows(db, 'task-delay')).length, 0, 'the stalled execution must not record the landed ref write');

    const settled = await settleIntents(db, artifacts);
    assert.equal(settled.recorded, 0, 'sha/generation drift must not be recorded as merged');
    assert.equal(settled.released, 0);
    assert.equal((await mergeRows(db, 'task-delay')).length, 0);
    const intent = await db.prepare('SELECT outcome FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-delay').first<{ outcome: string | null }>();
    assert.equal(intent?.outcome, null);

    await openSubmitted(db, artifacts, { id: 'ws-after', taskId: 'task-after', repo: 'ws-after', sha: OTHER, receiptId: 'rcpt-after' });
    const againSubmitted = await http.post('/git/workspaces/ws-after/submit', { sha: OTHER });
    assert.equal(againSubmitted.status, 200, JSON.stringify(againSubmitted.body));
    const again = await http.post('/git/merge', { task_id: 'task-after', receipt_id: 'rcpt-after' });
    assert.equal(codeOf(again.body), 'merge_hold');
  } finally {
    stall.release();
    await pending.catch(() => undefined);
    await close();
  }
});

test('reconciliation settles an in-doubt intent with no Artifacts effect and then allows a merge', { timeout: 20_000 }, async () => {
  const { db, close } = await database();
  try {
    const artifacts = canonicalBase();
    artifacts.beforeFastForward = async () => { throw new Error('no external effect'); };
    await openSubmitted(db, artifacts, { id: 'ws-none', taskId: 'task-none', repo: 'ws-none', sha: SUBMITTED, receiptId: 'rcpt-none' });
    const http = appFor(db, artifacts);
    const submitted = await http.post('/git/workspaces/ws-none/submit', { sha: SUBMITTED });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const failed = await http.post('/git/merge', { task_id: 'task-none', receipt_id: 'rcpt-none' });
    assert.notEqual(failed.status, 200, JSON.stringify(failed.body));
    assert.equal(artifacts.head(CANONICAL), BASE);
    assert.equal(artifacts.fastForwards.length, 0);
    const intent = await db.prepare('SELECT id FROM wrgit_merge_intents WHERE task_id=?').bind('task-none').first<{ id: string }>();
    assert.ok(intent, 'the intent row is open after a failure with no ref write');

    artifacts.beforeFastForward = null;
    const held = await http.post('/git/merge', { task_id: 'task-none', receipt_id: 'rcpt-none' });
    assert.equal(held.status, 409, JSON.stringify(held.body));
    assert.equal(codeOf(held.body), 'merge_hold');
    assert.equal(artifacts.fastForwards.length, 0);
    assert.equal((await mergeRows(db, 'task-none')).length, 0);

    const settled = await settleIntents(db, artifacts);
    assert.equal(settled.recorded, 0);
    assert.equal(settled.released, 1);
    assert.equal((await mergeRows(db, 'task-none')).length, 0);
    const outcome = await db.prepare('SELECT outcome FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-none').first<{ outcome: string | null }>();
    assert.equal(outcome?.outcome, 'not_merged');

    const merged = await http.post('/git/merge', { task_id: 'task-none', receipt_id: 'rcpt-none' });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal(artifacts.head(CANONICAL), SUBMITTED);
    assert.equal(artifacts.fastForwards.length, 1);
    assert.equal((await mergeRows(db, 'task-none')).length, 1);
  } finally {
    await close();
  }
});

test('a second worker during a stalled fast-forward holds and the stalled call records nothing', { timeout: 20_000 }, async () => {
  const { db, close } = await database();
  const artifacts = canonicalBase();
  const stall = stallFastForward(db, artifacts);
  let pending: Promise<{ status: number; body: Body }> = Promise.resolve({ status: 0, body: { ok: false, error: { code: '', message: '' } } });
  try {
    await openSubmitted(db, artifacts, { id: 'ws-a', taskId: 'task-a', repo: 'ws-a', sha: SUBMITTED, receiptId: 'rcpt-a' });
    await openSubmitted(db, artifacts, { id: 'ws-b', taskId: 'task-b', repo: 'ws-b', sha: OTHER, receiptId: 'rcpt-b' });
    const http = appFor(db, artifacts);
    assert.equal((await http.post('/git/workspaces/ws-a/submit', { sha: SUBMITTED })).status, 200);
    assert.equal((await http.post('/git/workspaces/ws-b/submit', { sha: OTHER })).status, 200);
    pending = http.post('/git/merge', { task_id: 'task-a', receipt_id: 'rcpt-a' });
    await until(() => stall.entered());
    await db.prepare('UPDATE wrgit_merge_lock SET acquired_at=1, expires_at=1 WHERE id=1 AND holder IS NOT NULL').all();
    await until(() => stall.expired());
    const other = await http.post('/git/merge', { task_id: 'task-b', receipt_id: 'rcpt-b' });
    assert.equal(other.status, 409, JSON.stringify(other.body));
    assert.equal(codeOf(other.body), 'merge_hold');
    assert.equal(artifacts.fastForwards.length, 0);
    assert.equal((await mergeRows(db)).length, 0);
    stall.release();
    const late = await pending;
    assert.notEqual(late.status, 200, JSON.stringify(late.body));
    assert.equal((await mergeRows(db, 'task-a')).length, 0, 'the stalled execution must not write a merge row after losing the lock');
    assert.equal((await mergeRows(db, 'task-b')).length, 0);
  } finally {
    stall.release();
    await pending.catch(() => undefined);
    await close();
  }
});

test('a coincidental move to the intent sha is not proof and the hold stays until reconciliation', { timeout: 20_000 }, async () => {
  const { db, close } = await database();
  try {
    const artifacts = canonicalBase();
    artifacts.beforeFastForward = async () => { throw new Error('no external effect'); };
    await openSubmitted(db, artifacts, { id: 'ws-same', taskId: 'task-same', repo: 'ws-same', sha: SUBMITTED, receiptId: 'rcpt-same' });
    await openSubmitted(db, artifacts, { id: 'ws-other', taskId: 'task-other', repo: 'ws-other', sha: OTHER, receiptId: 'rcpt-other' });
    const http = appFor(db, artifacts);
    assert.equal((await http.post('/git/workspaces/ws-same/submit', { sha: SUBMITTED })).status, 200);
    assert.equal((await http.post('/git/workspaces/ws-other/submit', { sha: OTHER })).status, 200);
    const failed = await http.post('/git/merge', { task_id: 'task-same', receipt_id: 'rcpt-same' });
    assert.notEqual(failed.status, 200, JSON.stringify(failed.body));
    assert.equal(artifacts.head(CANONICAL), BASE);
    assert.equal(artifacts.fastForwards.length, 0);
    const intent = await db.prepare('SELECT sha FROM wrgit_merge_intents WHERE task_id=?').bind('task-same').first<{ sha: string }>();
    assert.equal(intent?.sha, SUBMITTED);

    artifacts.beforeFastForward = null;
    artifacts.advance(CANONICAL, SUBMITTED, 'coincidental', [BASE]);
    assert.equal(artifacts.head(CANONICAL), SUBMITTED);
    const recovered = await http.post('/git/merge', { task_id: 'task-same', receipt_id: 'rcpt-same' });
    assert.equal(recovered.status, 409, JSON.stringify(recovered.body));
    assert.equal(codeOf(recovered.body), 'merge_hold');
    assert.equal((await mergeRows(db)).length, 0, 'the same sha alone must not be recorded as this intent effect');

    const other = await http.post('/git/merge', { task_id: 'task-other', receipt_id: 'rcpt-other' });
    assert.equal(other.status, 409, JSON.stringify(other.body));
    assert.equal(codeOf(other.body), 'merge_hold');
    assert.equal((await mergeRows(db)).length, 0);

    const settled = await settleIntents(db, artifacts);
    assert.equal(settled.recorded, 0);
    assert.ok(settled.released >= 1);
    assert.equal((await mergeRows(db)).length, 0);
    const outcome = await db.prepare('SELECT outcome FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-same').first<{ outcome: string | null }>();
    assert.equal(outcome?.outcome, 'not_merged');

    const after = await http.post('/git/merge', { task_id: 'task-same', receipt_id: 'rcpt-same' });
    assert.equal(after.status, 409, JSON.stringify(after.body));
    assert.equal(codeOf(after.body), 'unproven_fast_forward');
    assert.equal((await mergeRows(db, 'task-same')).length, 0);
  } finally {
    await close();
  }
});

test('r6: a fast-forward that loses the lock generation does not move canonical and records stale_lock', { timeout: 20_000 }, async () => {
  const { db, close } = await database();
  const artifacts = canonicalBase();
  artifacts.casOnLockGeneration = true;
  artifacts.fenceDb = db;
  const stall = stallFastForward(db, artifacts);
  let pending: Promise<{ status: number; body: Body }> = Promise.resolve({ status: 0, body: { ok: false, error: { code: '', message: '' } } });
  try {
    await openSubmitted(db, artifacts, { id: 'ws-gen', taskId: 'task-gen', repo: 'ws-gen', sha: SUBMITTED, receiptId: 'rcpt-gen' });
    const http = appFor(db, artifacts);
    assert.equal((await http.post('/git/workspaces/ws-gen/submit', { sha: SUBMITTED })).status, 200);
    pending = http.post('/git/merge', { task_id: 'task-gen', receipt_id: 'rcpt-gen' });
    await until(() => stall.entered());
    await db.prepare('UPDATE wrgit_merge_lock SET acquired_at=1, expires_at=1 WHERE id=1 AND holder IS NOT NULL').all();
    await until(() => stall.expired());
    artifacts.advance('ws-gen', OTHER, 'new submission', [SUBMITTED]);
    const resubmitted = await http.post('/git/workspaces/ws-gen/submit', { sha: OTHER });
    assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));
    stall.release();
    const late = await pending;
    assert.equal(late.status, 409, JSON.stringify(late.body));
    assert.equal(codeOf(late.body), 'stale_lock');
    assert.equal(artifacts.head(CANONICAL), BASE, 'the old sha must not move canonical after the lock generation changes');
    assert.equal(artifacts.fastForwards.length, 0);
    const intent = await db.prepare('SELECT * FROM wrgit_merge_intents WHERE task_id=?').bind('task-gen').first<Record<string, unknown>>();
    assert.equal(JSON.stringify(intent).includes('stale_lock'), true, JSON.stringify(intent));
    const recorded = await db.prepare('SELECT sha FROM wrgit_merges WHERE task_id=?').bind('task-gen').first<{ sha: string }>();
    assert.equal(recorded, null);
  } finally {
    stall.release();
    await pending.catch(() => undefined);
    await close();
  }
});

test('r6: an empty log while the old fast-forward is in flight does not settle not_merged', { timeout: 20_000 }, async () => {
  const { db, close } = await database();
  const artifacts = canonicalBase();
  const stall = stallFastForward(db, artifacts);
  let pending: Promise<{ status: number; body: Body }> = Promise.resolve({ status: 0, body: { ok: false, error: { code: '', message: '' } } });
  try {
    await openSubmitted(db, artifacts, { id: 'ws-hold', taskId: 'task-hold', repo: 'ws-hold', sha: SUBMITTED, receiptId: 'rcpt-hold' });
    const http = appFor(db, artifacts);
    assert.equal((await http.post('/git/workspaces/ws-hold/submit', { sha: SUBMITTED })).status, 200);
    pending = http.post('/git/merge', { task_id: 'task-hold', receipt_id: 'rcpt-hold' });
    await until(() => stall.entered());
    await db.prepare('UPDATE wrgit_merge_lock SET acquired_at=1, expires_at=1 WHERE id=1 AND holder IS NOT NULL').all();
    await until(() => stall.expired());
    const during = await settleIntents(db, artifacts);
    assert.equal(during.recorded, 0);
    assert.equal(during.released, 0, 'an empty log while the holder may still act is a hold, not not_merged');
    const open = await db.prepare('SELECT outcome FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-hold').first<{ outcome: string | null }>();
    assert.equal(open?.outcome, null);
    assert.equal(artifacts.head(CANONICAL), BASE);
    stall.release();
    const late = await pending;
    assert.equal(late.status, 409, JSON.stringify(late.body));
    assert.equal(codeOf(late.body), 'stale_lock');
    assert.equal(artifacts.head(CANONICAL), SUBMITTED);
    const settled = await settleIntents(db, artifacts);
    assert.equal(settled.recorded, 0, 'sha/generation drift must not be recorded as merged');
    assert.equal(settled.released, 0);
    const outcome = await db.prepare('SELECT outcome FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-hold').first<{ outcome: string | null }>();
    assert.equal(outcome?.outcome, null);
    assert.equal((await mergeRows(db, 'task-hold')).length, 0);
  } finally {
    stall.release();
    await pending.catch(() => undefined);
    await close();
  }
});

function intentProofMessage(intent: { id: string; sha: string; receipt_id: string }): string {
  return [
    `Merge ${intent.sha}`,
    '',
    `Unit: ${UNIT}`,
    `Author-Agent: ${AUTHOR}`,
    `Verifier: ${VERIFIER}`,
    `Receipt: ${intent.receipt_id}`,
    `Intent: ${intent.id}`,
  ].join('\n');
}

test('r6: a matching fast-forward log on a different ref does not record a merge', async () => {
  const { db, close } = await database();
  try {
    const artifacts = canonicalBase();
    artifacts.beforeFastForward = async () => { throw new Error('no external effect'); };
    await openSubmitted(db, artifacts, { id: 'ws-ref', taskId: 'task-ref', repo: 'ws-ref', sha: SUBMITTED, receiptId: 'rcpt-ref' });
    const http = appFor(db, artifacts);
    assert.equal((await http.post('/git/workspaces/ws-ref/submit', { sha: SUBMITTED })).status, 200);
    const failed = await http.post('/git/merge', { task_id: 'task-ref', receipt_id: 'rcpt-ref' });
    assert.notEqual(failed.status, 200, JSON.stringify(failed.body));
    const intent = await db.prepare('SELECT id, sha, receipt_id, expected_sha FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-ref').first<{ id: string; sha: string; receipt_id: string; expected_sha: string }>();
    assert.ok(intent);
    artifacts.appendFastForward(CANONICAL, {
      ref: 'refs/heads/side',
      from: intent.expected_sha,
      to: intent.sha,
      message: intentProofMessage(intent),
    });
    assert.equal(artifacts.head(CANONICAL), BASE);
    const settled = await settleIntents(db, artifacts);
    assert.equal(settled.recorded, 0);
    assert.equal((await mergeRows(db, 'task-ref')).length, 0);
    const outcome = await db.prepare('SELECT outcome FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-ref').first<{ outcome: string | null }>();
    assert.notEqual(outcome?.outcome, 'merged');
    assert.equal(artifacts.head(CANONICAL), BASE);
  } finally {
    await close();
  }
});

test('r6: a canonical log line is not a merge when canonical does not point at the new sha', async () => {
  const { db, close } = await database();
  try {
    const artifacts = canonicalBase();
    artifacts.beforeFastForward = async () => { throw new Error('no external effect'); };
    await openSubmitted(db, artifacts, { id: 'ws-headchk', taskId: 'task-headchk', repo: 'ws-headchk', sha: SUBMITTED, receiptId: 'rcpt-headchk' });
    const http = appFor(db, artifacts);
    assert.equal((await http.post('/git/workspaces/ws-headchk/submit', { sha: SUBMITTED })).status, 200);
    const failed = await http.post('/git/merge', { task_id: 'task-headchk', receipt_id: 'rcpt-headchk' });
    assert.notEqual(failed.status, 200, JSON.stringify(failed.body));
    const intent = await db.prepare('SELECT id, sha, receipt_id, expected_sha FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-headchk').first<{ id: string; sha: string; receipt_id: string; expected_sha: string }>();
    assert.ok(intent);
    artifacts.appendFastForward(CANONICAL, {
      ref: 'main',
      from: intent.expected_sha,
      to: intent.sha,
      message: intentProofMessage(intent),
    });
    assert.equal(artifacts.head(CANONICAL), BASE);
    const settled = await settleIntents(db, artifacts);
    assert.equal(settled.recorded, 0);
    assert.equal((await mergeRows(db, 'task-headchk')).length, 0);
    const outcome = await db.prepare('SELECT outcome FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-headchk').first<{ outcome: string | null }>();
    assert.notEqual(outcome?.outcome, 'merged');
    assert.equal(artifacts.head(CANONICAL), BASE);
  } finally {
    await close();
  }
});

test('r7: a D1-blind fast-forward that drifts the lock generation is a hold, not merged', { timeout: 20_000 }, async () => {
  const { db, close } = await database();
  const artifacts = canonicalBase();
  assert.equal(artifacts.casOnLockGeneration, false);
  assert.equal(artifacts.fenceDb, null);
  const stall = stallFastForward(db, artifacts);
  let pending: Promise<{ status: number; body: Body }> = Promise.resolve({ status: 0, body: { ok: false, error: { code: '', message: '' } } });
  try {
    await openSubmitted(db, artifacts, { id: 'ws-blind', taskId: 'task-blind', repo: 'ws-blind', sha: SUBMITTED, receiptId: 'rcpt-blind' });
    const http = appFor(db, artifacts);
    assert.equal((await http.post('/git/workspaces/ws-blind/submit', { sha: SUBMITTED })).status, 200);
    pending = http.post('/git/merge', { task_id: 'task-blind', receipt_id: 'rcpt-blind' });
    await until(() => stall.entered());
    await db.prepare('UPDATE wrgit_merge_lock SET acquired_at=1, expires_at=1 WHERE id=1 AND holder IS NOT NULL').all();
    await until(() => stall.expired());
    artifacts.advance('ws-blind', OTHER, 'new submission', [SUBMITTED]);
    const resubmitted = await http.post('/git/workspaces/ws-blind/submit', { sha: OTHER });
    assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));
    stall.release();
    const late = await pending;
    assert.equal(late.status, 409, JSON.stringify(late.body));
    assert.equal(codeOf(late.body), 'stale_lock');
    assert.equal(artifacts.head(CANONICAL), SUBMITTED, 'a D1-blind double still moves the ref');
    assert.equal(artifacts.fastForwards.length, 1);
    const settled = await settleIntents(db, artifacts);
    assert.equal(settled.recorded, 0, 'sha/generation drift must not be recorded as merged');
    assert.equal(settled.released, 0, 'drift stays a hold');
    const outcome = await db.prepare('SELECT outcome, fence_fault FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-blind').first<{ outcome: string | null; fence_fault: string | null }>();
    assert.equal(outcome?.outcome, null);
    assert.equal(outcome?.fence_fault, 'stale_lock');
    const recorded = await db.prepare('SELECT sha FROM wrgit_merges WHERE task_id=?').bind('task-blind').first<{ sha: string }>();
    assert.equal(recorded, null);
  } finally {
    stall.release();
    await pending.catch(() => undefined);
    await close();
  }
});

test('r7: write_open older than the lease does not hold an empty log', { timeout: 20_000 }, async () => {
  const { db, close } = await database();
  try {
    const artifacts = canonicalBase();
    artifacts.beforeFastForward = async () => { throw new Error('no external effect'); };
    await openSubmitted(db, artifacts, { id: 'ws-lease', taskId: 'task-lease', repo: 'ws-lease', sha: SUBMITTED, receiptId: 'rcpt-lease' });
    const http = appFor(db, artifacts);
    assert.equal((await http.post('/git/workspaces/ws-lease/submit', { sha: SUBMITTED })).status, 200);
    const failed = await http.post('/git/merge', { task_id: 'task-lease', receipt_id: 'rcpt-lease' });
    assert.notEqual(failed.status, 200, JSON.stringify(failed.body));
    assert.equal(artifacts.head(CANONICAL), BASE);
    assert.equal(artifacts.fastForwards.length, 0);
    const intent = await db.prepare('SELECT id FROM wrgit_merge_intents WHERE task_id=?').bind('task-lease').first<{ id: string }>();
    assert.ok(intent);
    const old = Date.now() - 120_000;
    await db.prepare('UPDATE wrgit_merge_intents SET write_open=1, created_at=? WHERE id=?').bind(old, intent.id).all();
    try {
      await db.prepare('UPDATE wrgit_merge_intents SET write_open_at=? WHERE id=?').bind(old, intent.id).all();
    } catch {
      // 0073 adds write_open_at. Until then the lease is the intent age.
    }
    const settled = await settleIntents(db, artifacts);
    assert.equal(settled.recorded, 0);
    assert.equal(settled.released, 1, 'an expired write_open lease is not an in-flight holder');
    const outcome = await db.prepare('SELECT outcome FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-lease').first<{ outcome: string | null }>();
    assert.equal(outcome?.outcome, 'not_merged');
    assert.equal((await mergeRows(db, 'task-lease')).length, 0);
  } finally {
    await close();
  }
});

test('write_open lease is longer than the Artifacts call timeout plus skew', () => {
  assert.ok(WRITE_OPEN_LEASE_MS > ARTIFACTS_CALL_TIMEOUT_MS + MERGE_CLOCK_SKEW_MS);
});

test('budget floor holds when remaining time is skew and proceeds one millisecond above it', () => {
  assert.deepEqual(artifactsCallBudget(MERGE_CLOCK_SKEW_MS), { action: 'hold' });
  assert.deepEqual(artifactsCallBudget(MERGE_CLOCK_SKEW_MS + 1), { action: 'call', timeoutMs: 1 });
  assert.equal(artifactsCallBudget(MERGE_CLOCK_SKEW_MS - 1).action, 'hold');
});

function budgetDb(db: Database, leftMs: number, frozen: number): Database {
  let armed = false;
  return wrapDb(db, {
    async beforeFirst(sql) {
      if (armed || !sql.includes('SELECT expires_at FROM wrgit_merge_lock')) return;
      armed = true;
      await db.prepare('UPDATE wrgit_merge_lock SET expires_at=? WHERE id=1').bind(frozen + leftMs).all();
    },
  });
}

test('remaining lock time equal to skew holds and makes no Artifacts call', async () => {
  const { db, close } = await database();
  const frozen = 1_800_000_000_000;
  const previous = mergeClock.now;
  mergeClock.now = () => frozen;
  try {
    const artifacts = canonicalBase();
    await openSubmitted(db, artifacts, { id: 'ws-floor', taskId: 'task-floor', repo: 'ws-floor', sha: SUBMITTED, receiptId: 'rcpt-floor' });
    const http = appFor(budgetDb(db, MERGE_CLOCK_SKEW_MS, frozen), artifacts);
    assert.equal((await http.post('/git/workspaces/ws-floor/submit', { sha: SUBMITTED })).status, 200);
    const before = artifacts.calls.slice();
    const held = await http.post('/git/merge', { task_id: 'task-floor', receipt_id: 'rcpt-floor' });
    assert.equal(held.status, 409, JSON.stringify(held.body));
    assert.equal(codeOf(held.body), 'stale_lock');
    assert.deepEqual(artifacts.calls.slice(before.length), ['get']);
    assert.equal(artifacts.calls.includes('fastForward'), false);
    assert.equal(artifacts.calls.includes('compareAndSet'), false);
    assert.equal(artifacts.calls.includes('log'), false);
    assert.equal(artifacts.calls.includes('fastForwardLog'), false);
    assert.equal(artifacts.fastForwards.length, 0);
    assert.equal((await mergeRows(db, 'task-floor')).length, 0);
    const workspace = await db.prepare('SELECT status, merged_sha FROM wrgit_workspaces WHERE id=?')
      .bind('ws-floor').first<{ status: string; merged_sha: string | null }>();
    assert.equal(workspace?.status, 'submitted');
    assert.equal(workspace?.merged_sha, null);
  } finally {
    mergeClock.now = previous;
    await close();
  }
});

test('remaining lock time of skew plus one millisecond proceeds into the Artifacts call', async () => {
  const { db, close } = await database();
  const frozen = 1_800_000_000_000;
  const previous = mergeClock.now;
  mergeClock.now = () => frozen;
  try {
    const artifacts = canonicalBase();
    await openSubmitted(db, artifacts, { id: 'ws-proceed', taskId: 'task-proceed', repo: 'ws-proceed', sha: SUBMITTED, receiptId: 'rcpt-proceed' });
    const http = appFor(budgetDb(db, MERGE_CLOCK_SKEW_MS + 1, frozen), artifacts);
    assert.equal((await http.post('/git/workspaces/ws-proceed/submit', { sha: SUBMITTED })).status, 200);
    const merged = await http.post('/git/merge', { task_id: 'task-proceed', receipt_id: 'rcpt-proceed' });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal(artifacts.calls.includes('fastForward'), true);
    assert.equal(artifacts.signalAbortedAtCall.at(-1), false);
    assert.equal(artifacts.fastForwards.length, 1);
    assert.equal(artifacts.head(CANONICAL), SUBMITTED);
  } finally {
    mergeClock.now = previous;
    await close();
  }
});

test('reconcile holds when the live ref matches neither the intent sha nor the submitted sha', async () => {
  const { db, close } = await database();
  try {
    const artifacts = canonicalBase();
    artifacts.beforeFastForward = async () => { throw new Error('no external effect'); };
    await openSubmitted(db, artifacts, { id: 'ws-drift', taskId: 'task-drift', repo: 'ws-drift', sha: SUBMITTED, receiptId: 'rcpt-drift' });
    const http = appFor(db, artifacts);
    assert.equal((await http.post('/git/workspaces/ws-drift/submit', { sha: SUBMITTED })).status, 200);
    const failed = await http.post('/git/merge', { task_id: 'task-drift', receipt_id: 'rcpt-drift' });
    assert.notEqual(failed.status, 200, JSON.stringify(failed.body));
    artifacts.advance(CANONICAL, WRONG, 'canonical drift', [BASE]);
    assert.equal(artifacts.head(CANONICAL), WRONG);
    const settled = await settleIntents(db, artifacts);
    assert.equal(settled.recorded, 0);
    assert.equal(settled.released, 0, 'a ref that matches neither sha stays a hold');
    assert.equal((await mergeRows(db, 'task-drift')).length, 0);
    const outcome = await db.prepare('SELECT outcome FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-drift').first<{ outcome: string | null }>();
    assert.equal(outcome?.outcome, null);
  } finally {
    await close();
  }
});

test('a late write after lease takeover holds and the stale holder writes no merge row', { timeout: 20_000 }, async () => {
  const { db, close } = await database();
  const artifacts = canonicalBase();
  let saw = false;
  let releaseGate = (): void => {};
  const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  artifacts.beforeFastForward = async () => {
    if (saw) return;
    saw = true;
    await gate;
  };
  const completionWrites: string[] = [];
  let watch = false;
  const wrapped = wrapDb(db, {
    async beforeAll(sql) {
      if (watch && /wrgit_workspaces|wrgit_merges/.test(sql) && /INSERT|UPDATE/i.test(sql)) completionWrites.push(sql);
    },
    async beforeFirst(sql) {
      if (watch && /wrgit_workspaces|wrgit_merges/.test(sql) && /INSERT|UPDATE/i.test(sql)) completionWrites.push(sql);
    },
  });
  let pending: Promise<{ status: number; body: Body }> = Promise.resolve({ status: 0, body: { ok: false, error: { code: '', message: '' } } });
  try {
    await openSubmitted(db, artifacts, { id: 'ws-late', taskId: 'task-late', repo: 'ws-late', sha: SUBMITTED, receiptId: 'rcpt-late' });
    const http = appFor(wrapped, artifacts);
    assert.equal((await http.post('/git/workspaces/ws-late/submit', { sha: SUBMITTED })).status, 200);
    pending = http.post('/git/merge', { task_id: 'task-late', receipt_id: 'rcpt-late' });
    await until(() => saw);
    const before = await db.prepare('SELECT submitted_sha, status, merged_sha FROM wrgit_workspaces WHERE id=?')
      .bind('ws-late').first<{ submitted_sha: string | null; status: string; merged_sha: string | null }>();
    const intent = await db.prepare('SELECT id FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-late').first<{ id: string }>();
    assert.ok(intent);
    const openedAt = mergeClock.now() - WRITE_OPEN_LEASE_MS - 1;
    await db.prepare('UPDATE wrgit_merge_intents SET write_open=1, write_open_at=? WHERE id=?').bind(openedAt, intent.id).all();
    watch = true;
    const claim = await takeoverExpiredLease(db, artifacts, intent.id, 'reclaimer-late');
    assert.equal(claim.rowsChanged, 1);
    assert.equal(claim.wroteLease, true);
    assert.equal(claim.ref, BASE);
    releaseGate();
    const late = await pending;
    assert.equal(late.status, 409, JSON.stringify(late.body));
    assert.equal(codeOf(late.body), 'stale_lock');
    assert.equal(artifacts.head(CANONICAL), SUBMITTED, 'the original write lands after the generation moves');
    assert.deepEqual(completionWrites, []);
    const after = await db.prepare('SELECT submitted_sha, status, merged_sha FROM wrgit_workspaces WHERE id=?')
      .bind('ws-late').first<{ submitted_sha: string | null; status: string; merged_sha: string | null }>();
    assert.deepEqual(after, before);
    assert.equal(after?.status, 'submitted');
    assert.equal((await mergeRows(db, 'task-late')).length, 0);
    const settled = await settleIntents(db, artifacts);
    assert.equal(settled.recorded, 0);
    assert.equal(settled.released, 0);
    const outcome = await db.prepare('SELECT outcome FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-late').first<{ outcome: string | null }>();
    assert.equal(outcome?.outcome, null);
  } finally {
    releaseGate();
    await pending.catch(() => undefined);
    await close();
  }
});

test('two reclaimers racing one generation write one lease for the winner', async () => {
  const { db, close } = await database();
  try {
    const artifacts = canonicalBase();
    artifacts.beforeFastForward = async () => { throw new Error('no external effect'); };
    await openSubmitted(db, artifacts, { id: 'ws-race', taskId: 'task-race', repo: 'ws-race', sha: SUBMITTED, receiptId: 'rcpt-race' });
    const http = appFor(db, artifacts);
    assert.equal((await http.post('/git/workspaces/ws-race/submit', { sha: SUBMITTED })).status, 200);
    const failed = await http.post('/git/merge', { task_id: 'task-race', receipt_id: 'rcpt-race' });
    assert.notEqual(failed.status, 200, JSON.stringify(failed.body));
    const intent = await db.prepare('SELECT id FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-race').first<{ id: string }>();
    assert.ok(intent);
    const seen = await db.prepare('SELECT generation FROM wrgit_merge_fence WHERE id=1').first<{ generation: number }>();
    assert.ok(seen);
    const callsBefore = artifacts.calls.length;
    const forwardsBefore = artifacts.fastForwards.length;
    const [first, second] = await Promise.all([
      reclaimWriteOpen(db, artifacts, intent.id, seen.generation, 'reclaimer-a'),
      reclaimWriteOpen(db, artifacts, intent.id, seen.generation, 'reclaimer-b'),
    ]);
    const results = [first, second];
    const winners = results.filter(result => result.rowsChanged === 1);
    const losers = results.filter(result => result.rowsChanged !== 1);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0]?.wroteLease, false);
    assert.equal(losers[0]?.ref, null);
    const generation = await db.prepare('SELECT generation FROM wrgit_merge_fence WHERE id=1').first<{ generation: number }>();
    assert.equal(generation?.generation, seen.generation + 1);
    const leases = await db.prepare('SELECT owner, generation FROM wrgit_write_open_lease').all<{ owner: string; generation: number }>();
    assert.equal(leases.results.length, 1);
    assert.equal(leases.results[0]?.owner, winners[0]?.owner);
    assert.equal(leases.results[0]?.generation, seen.generation + 1);
    const owner = await db.prepare('SELECT write_open_owner FROM wrgit_merge_intents WHERE id=?')
      .bind(intent.id).first<{ write_open_owner: string | null }>();
    assert.equal(owner?.write_open_owner, winners[0]?.owner);
    assert.equal(artifacts.fastForwards.length, forwardsBefore);
    assert.equal(artifacts.calls.slice(callsBefore).includes('fastForward'), false);
    assert.equal(artifacts.calls.slice(callsBefore).includes('compareAndSet'), false);
  } finally {
    await close();
  }
});

// WG-11 (dots 5468cfd3): with the binding configured but WRGIT_ENABLED off, /git/* must be absent
// like /git/workspaces: no Artifacts call, no lock row, no workspace write.
test('WRGIT_ENABLED off: submit and merge are 404 and touch neither the binding nor D1', async () => {
  const { db, close } = await database();
  try {
    const artifacts = canonicalBase();
    await openSubmitted(db, artifacts, { id: 'ws-off', taskId: 'task-off', repo: 'ws-off', sha: SUBMITTED, receiptId: 'rcpt-off' });
    await db.prepare("UPDATE wrgit_workspaces SET status='open', submitted_sha=NULL WHERE id='ws-off'").all();
    const snapshot = async () => JSON.stringify((await db.prepare('SELECT * FROM wrgit_workspaces ORDER BY id').all()).results);
    const before = await snapshot();
    const calls = artifacts.calls.length;
    const http = appFor(db, artifacts, { wrgit: false });
    const submitted = await http.post('/git/workspaces/ws-off/submit', { sha: SUBMITTED });
    assert.equal(submitted.status, 404, JSON.stringify(submitted.body));
    const merged = await http.post('/git/merge', { task_id: 'task-off', receipt_id: 'rcpt-off' });
    assert.equal(merged.status, 404, JSON.stringify(merged.body));
    assert.deepEqual(artifacts.calls.slice(calls), []);
    assert.equal(await snapshot(), before);
  } finally {
    await close();
  }
});

test('submit by a principal other than the workspace owner is 403 and touches neither the binding nor the row', async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    artifacts.seed('ws-owner', SUBMITTED, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
    ]);
    await seedWorkspace(db, { id: 'ws-owner', taskId: 'task-owner', repo: 'ws-owner', base: BASE });
    const http = appFor(db, artifacts);
    const before = artifacts.calls.length;
    const stolen = await http.post('/git/workspaces/ws-owner/submit', { sha: SUBMITTED }, { 'x-test-as': MERGER });
    assert.equal(stolen.status, 403, JSON.stringify(stolen.body));
    assert.equal(codeOf(stolen.body), 'FORBIDDEN');
    assert.equal(artifacts.calls.length, before);
    const row = await db.prepare('SELECT status, submitted_sha FROM wrgit_workspaces WHERE id=?')
      .bind('ws-owner').first<{ status: string; submitted_sha: string | null }>();
    assert.deepEqual(row, { status: 'open', submitted_sha: null });
    const owned = await http.post('/git/workspaces/ws-owner/submit', { sha: SUBMITTED });
    assert.equal(owned.status, 200, JSON.stringify(owned.body));
  } finally {
    await close();
  }
});

test('merge called by the workspace author is 403 even with a non-author PASS receipt', async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    artifacts.seed(CANONICAL, BASE, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
    ]);
    artifacts.seed('ws-selfmerge', SUBMITTED, [
      { sha: BASE, message: 'base', parents: [] },
      { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
    ]);
    await seedWorkspace(db, { id: 'ws-selfmerge', taskId: 'task-selfmerge', repo: 'ws-selfmerge', base: BASE });
    await storeReceipt(db, 'rcpt-selfmerge', 'task-selfmerge', SUBMITTED, false);
    const http = appFor(db, artifacts);
    assert.equal((await http.post('/git/workspaces/ws-selfmerge/submit', { sha: SUBMITTED })).status, 200);
    const before = artifacts.calls.length;
    const merged = await http.post('/git/merge', { task_id: 'task-selfmerge', receipt_id: 'rcpt-selfmerge' }, { 'x-test-as': AUTHOR });
    assert.equal(merged.status, 403, JSON.stringify(merged.body));
    assert.equal(codeOf(merged.body), 'FORBIDDEN');
    assert.equal(artifacts.calls.length, before);
    assert.equal(artifacts.head(CANONICAL), BASE);
    assert.equal(artifacts.fastForwards.length, 0);
    const intents = await db.prepare('SELECT COUNT(*) AS n FROM wrgit_merge_intents WHERE workspace_id=?')
      .bind('ws-selfmerge').first<{ n: number }>();
    assert.equal(intents?.n, 0);
    const ok = await http.post('/git/merge', { task_id: 'task-selfmerge', receipt_id: 'rcpt-selfmerge' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  } finally {
    await close();
  }
});

// #83 follow-up item 3: a task holds one workspace per agent, so merge must target the submitted row, not task_id LIMIT 1.
async function twoWorkspaces(db: Database, artifacts: MemoryArtifacts, taskId: string): Promise<void> {
  const history = [
    { sha: BASE, message: 'base', parents: [] },
    { sha: SUBMITTED, message: 'workspace head', parents: [BASE] },
  ];
  artifacts.seed(CANONICAL, BASE, history);
  artifacts.seed(`${taskId}-a`, SUBMITTED, history);
  artifacts.seed(`${taskId}-b`, SUBMITTED, history);
  await db.batch([
    db.prepare("INSERT INTO principals(id) VALUES ('agent:other')"),
    db.prepare("INSERT INTO memberships(principal_id, room_id, active, can_post) VALUES ('agent:other', 'room_main', 1, 1)"),
  ]);
  // A's row is inserted first, so an unordered task_id lookup lands on it.
  await seedWorkspace(db, { id: `${taskId}-a`, taskId, repo: `${taskId}-a`, base: BASE, agentId: 'agent:other' });
  await seedWorkspace(db, { id: `${taskId}-b`, taskId, repo: `${taskId}-b`, base: BASE });
  await storeReceipt(db, `rcpt-${taskId}`, taskId, SUBMITTED, false);
}

test('merge targets the one workspace that submitted the receipt sha, not the first row of the task', async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    await twoWorkspaces(db, artifacts, 'task-two');
    const http = appFor(db, artifacts);
    const submitted = await http.post('/git/workspaces/task-two-b/submit', { sha: SUBMITTED });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const merged = await http.post('/git/merge', { task_id: 'task-two', receipt_id: 'rcpt-task-two' });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    if (!merged.body.ok) return;
    assert.equal(merged.body.data.workspace_id, 'task-two-b');
    assert.equal(artifacts.head(CANONICAL), SUBMITTED);
    const a = await db.prepare('SELECT status, merged_sha FROM wrgit_workspaces WHERE id=?').bind('task-two-a').first<{ status: string; merged_sha: string | null }>();
    assert.deepEqual({ ...a }, { status: 'open', merged_sha: null });
  } finally {
    await close();
  }
});

test('the merge author check runs on the resolved workspace, not the first row of the task', async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    await twoWorkspaces(db, artifacts, 'task-own');
    const http = appFor(db, artifacts);
    assert.equal((await http.post('/git/workspaces/task-own-b/submit', { sha: SUBMITTED })).status, 200);
    const merged = await http.post('/git/merge', { task_id: 'task-own', receipt_id: 'rcpt-task-own' }, { 'x-test-as': AUTHOR });
    assert.equal(merged.status, 403, JSON.stringify(merged.body));
    assert.equal(codeOf(merged.body), 'FORBIDDEN');
    assert.equal(artifacts.head(CANONICAL), BASE);
    assert.equal((await mergeRows(db, 'task-own')).length, 0);
  } finally {
    await close();
  }
});

test('two workspaces submitted at the receipt sha are ambiguous and nothing merges', async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    await twoWorkspaces(db, artifacts, 'task-amb');
    const http = appFor(db, artifacts);
    assert.equal((await http.post('/git/workspaces/task-amb-a/submit', { sha: SUBMITTED }, { 'x-test-as': 'agent:other' })).status, 200);
    assert.equal((await http.post('/git/workspaces/task-amb-b/submit', { sha: SUBMITTED })).status, 200);
    const merged = await http.post('/git/merge', { task_id: 'task-amb', receipt_id: 'rcpt-task-amb' });
    assert.equal(merged.status, 409, JSON.stringify(merged.body));
    assert.equal(codeOf(merged.body), 'ambiguous');
    assert.equal(artifacts.head(CANONICAL), BASE);
    assert.equal((await mergeRows(db, 'task-amb')).length, 0);
  } finally {
    await close();
  }
});

// #83 follow-up item 1: can_post is rechecked inside the write statement, as in decisions.ts.
test('a can_post revoke after the route authorize stops submit and merge at the write statement', async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    await twoWorkspaces(db, artifacts, 'task-rev');
    let target = '';
    const revokeAt = (marker: string) => async (sql: string) => {
      if (target && sql.includes(marker)) {
        await db.prepare("UPDATE memberships SET can_post=0 WHERE principal_id=? AND room_id='room_main'").bind(target).all();
        target = '';
      }
    };
    const hooked = wrapDb(db, { beforeFirst: async sql => { await revokeAt("SET head_sha=?, submitted_sha=?, status='submitted'")(sql); await revokeAt('INSERT INTO wrgit_merge_intents')(sql); } });
    const http = appFor(hooked, artifacts);

    target = AUTHOR;
    const submitted = await http.post('/git/workspaces/task-rev-b/submit', { sha: SUBMITTED });
    assert.equal(submitted.status, 403, JSON.stringify(submitted.body));
    const row = await db.prepare('SELECT submitted_sha FROM wrgit_workspaces WHERE id=?').bind('task-rev-b').first<{ submitted_sha: string | null }>();
    assert.equal(row?.submitted_sha, null);

    await db.prepare("UPDATE memberships SET can_post=1 WHERE principal_id=?").bind(AUTHOR).all();
    assert.equal((await http.post('/git/workspaces/task-rev-b/submit', { sha: SUBMITTED })).status, 200);
    target = MERGER;
    const merged = await http.post('/git/merge', { task_id: 'task-rev', receipt_id: 'rcpt-task-rev' });
    assert.equal(merged.status, 403, JSON.stringify(merged.body));
    assert.equal(artifacts.head(CANONICAL), BASE);
    assert.equal(artifacts.fastForwards.length, 0);
    assert.equal((await mergeRows(db, 'task-rev')).length, 0);
  } finally {
    await close();
  }
});

// Dots/Grok re 481660f: a submit can land between merge's resolve and its lock. The lock must re-resolve.
test('a second submit of the same sha between resolve and the merge lock is ambiguous and nothing merges', async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    await twoWorkspaces(db, artifacts, 'task-race');
    let armed = false;
    const barrier = async (sql: string) => {
      if (armed && sql.includes('UPDATE wrgit_merge_lock SET holder=?')) {
        armed = false;
        // Submit A at the same sha in the gap: resolve already saw only B.
        await db.prepare("UPDATE wrgit_workspaces SET head_sha=?, submitted_sha=?, status='submitted' WHERE id=?")
          .bind(SUBMITTED, SUBMITTED, 'task-race-a').all();
      }
    };
    const http = appFor(wrapDb(db, { beforeFirst: barrier, beforeAll: barrier }), artifacts);
    assert.equal((await http.post('/git/workspaces/task-race-b/submit', { sha: SUBMITTED })).status, 200);
    armed = true;
    const merged = await http.post('/git/merge', { task_id: 'task-race', receipt_id: 'rcpt-task-race' });
    assert.equal(armed, false, 'the barrier ran');
    assert.equal(merged.status, 409, JSON.stringify(merged.body));
    assert.equal(codeOf(merged.body), 'ambiguous');
    assert.equal(artifacts.head(CANONICAL), BASE);
    assert.equal(artifacts.fastForwards.length, 0);
    const intents = await db.prepare('SELECT COUNT(*) AS n FROM wrgit_merge_intents').first<{ n: number }>();
    assert.equal(intents?.n, 0);
  } finally {
    await close();
  }
});

// Dots/Grok re 481660f: can_post must hold past claimIntent. The external fast-forward is the only window a revoke cannot stop.
function revokeHook(db: Database) {
  const state = { marker: '' };
  const hook = async (sql: string) => {
    if (state.marker && sql.includes(state.marker)) {
      state.marker = '';
      await db.prepare("UPDATE memberships SET can_post=0 WHERE principal_id=? AND room_id='room_main'").bind(MERGER).all();
    }
  };
  return { state, db: wrapDb(db, { beforeFirst: hook, beforeAll: hook }) };
}

async function restoreMerger(db: Database): Promise<void> {
  await db.prepare("UPDATE memberships SET can_post=1 WHERE principal_id=? AND room_id='room_main'").bind(MERGER).all();
}

test('a can_post revoke after the intent claim and before the fast-forward gets 403, no write and no hold', async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    await twoWorkspaces(db, artifacts, 'task-rv1');
    const hooked = revokeHook(db);
    const http = appFor(hooked.db, artifacts);
    assert.equal((await http.post('/git/workspaces/task-rv1-b/submit', { sha: SUBMITTED })).status, 200);
    hooked.state.marker = 'SET write_open=1';
    const merged = await http.post('/git/merge', { task_id: 'task-rv1', receipt_id: 'rcpt-task-rv1' });
    assert.equal(hooked.state.marker, '', 'the revoke ran');
    assert.equal(merged.status, 403, JSON.stringify(merged.body));
    assert.equal(codeOf(merged.body), 'FORBIDDEN');
    assert.equal(artifacts.head(CANONICAL), BASE);
    assert.equal(artifacts.fastForwards.length, 0);
    assert.equal((await mergeRows(db, 'task-rv1')).length, 0);
    const intent = await db.prepare('SELECT outcome, write_open FROM wrgit_merge_intents').first<{ outcome: string | null; write_open: number }>();
    assert.deepEqual({ ...intent }, { outcome: 'not_merged', write_open: 0 });
    // The settled intent leaves no merge hold: a restored merger can merge.
    await restoreMerger(db);
    const again = await http.post('/git/merge', { task_id: 'task-rv1', receipt_id: 'rcpt-task-rv1' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(artifacts.head(CANONICAL), SUBMITTED);
  } finally {
    await close();
  }
});

test('a can_post revoke after the fast-forward gets 403 and records nothing; reconcile records the landed write', async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    await twoWorkspaces(db, artifacts, 'task-rv2');
    const hooked = revokeHook(db);
    const http = appFor(hooked.db, artifacts);
    assert.equal((await http.post('/git/workspaces/task-rv2-b/submit', { sha: SUBMITTED })).status, 200);
    hooked.state.marker = 'SELECT sha, receipt_id FROM wrgit_merges';
    const merged = await http.post('/git/merge', { task_id: 'task-rv2', receipt_id: 'rcpt-task-rv2' });
    assert.equal(hooked.state.marker, '', 'the revoke ran');
    assert.equal(merged.status, 403, JSON.stringify(merged.body));
    assert.equal(codeOf(merged.body), 'FORBIDDEN');
    // The in-flight external write is not revocable: canonical main already moved.
    assert.equal(artifacts.head(CANONICAL), SUBMITTED);
    assert.equal(artifacts.fastForwards.length, 1);
    assert.equal((await mergeRows(db, 'task-rv2')).length, 0);
    const ws = await db.prepare('SELECT status FROM wrgit_workspaces WHERE id=?').bind('task-rv2-b').first<{ status: string }>();
    assert.equal(ws?.status, 'submitted');
    const settled = await settleIntents(db, artifacts);
    assert.deepEqual(settled, { recorded: 1, released: 0 });
    assert.equal((await mergeRows(db, 'task-rv2')).length, 1);
  } finally {
    await close();
  }
});

test('recovery of a proven intent by a merger revoked mid-request gets 403; an authorized retry records it', async () => {
  const { db, close } = await database();
  try {
    const artifacts = new MemoryArtifacts();
    await twoWorkspaces(db, artifacts, 'task-rv3');
    const hooked = revokeHook(db);
    const http = appFor(hooked.db, artifacts);
    assert.equal((await http.post('/git/workspaces/task-rv3-b/submit', { sha: SUBMITTED })).status, 200);
    // First call lands the fast-forward, then loses can_post before bookkeeping.
    hooked.state.marker = 'SELECT sha, receipt_id FROM wrgit_merges';
    assert.equal((await http.post('/git/merge', { task_id: 'task-rv3', receipt_id: 'rcpt-task-rv3' })).status, 403);
    await restoreMerger(db);
    // Second call takes the recovery path for its own proven intent, and is revoked mid-request.
    hooked.state.marker = 'SELECT sha, receipt_id FROM wrgit_merges';
    const recovery = await http.post('/git/merge', { task_id: 'task-rv3', receipt_id: 'rcpt-task-rv3' });
    assert.equal(hooked.state.marker, '', 'the revoke ran');
    assert.equal(recovery.status, 403, JSON.stringify(recovery.body));
    assert.equal(codeOf(recovery.body), 'FORBIDDEN');
    assert.equal((await mergeRows(db, 'task-rv3')).length, 0);
    assert.equal(artifacts.fastForwards.length, 1);
    await restoreMerger(db);
    const ok = await http.post('/git/merge', { task_id: 'task-rv3', receipt_id: 'rcpt-task-rv3' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await mergeRows(db, 'task-rv3')).length, 1);
    assert.equal(artifacts.fastForwards.length, 1);
  } finally {
    await close();
  }
});

test('the Artifacts call budget never exceeds ARTIFACTS_CALL_TIMEOUT_MS, even with the whole lock TTL left', () => {
  for (const left of [ARTIFACTS_CALL_TIMEOUT_MS + MERGE_CLOCK_SKEW_MS + 1, 25_000, 29_000, 30_000]) {
    const budget = artifactsCallBudget(left);
    assert.equal(budget.action, 'call');
    assert.ok(budget.action === 'call' && budget.timeoutMs <= ARTIFACTS_CALL_TIMEOUT_MS, `left=${left} gave ${JSON.stringify(budget)}`);
    assert.ok(budget.action === 'call' && budget.timeoutMs < WRITE_OPEN_LEASE_MS);
  }
  assert.deepEqual(artifactsCallBudget(30_000), { action: 'call', timeoutMs: ARTIFACTS_CALL_TIMEOUT_MS });
});

test('counterexample: a provider that ignores the abort signal lands its effect after the lease is reclaimed; the stale holder records nothing', { timeout: 20_000 }, async () => {
  const { db, close } = await database();
  const frozen = 1_800_000_000_000;
  const previous = mergeClock.now;
  mergeClock.now = () => frozen;
  let abortedWhenLanded: boolean | null = null;
  let reclaimed = false;
  try {
    const artifacts = canonicalBase();
    await openSubmitted(db, artifacts, { id: 'ws-ignore', taskId: 'task-ignore', repo: 'ws-ignore', sha: SUBMITTED, receiptId: 'rcpt-ignore' });
    // 30 ms call budget, so the abort fires quickly.
    const http = appFor(budgetDb(db, MERGE_CLOCK_SKEW_MS + 30, frozen), artifacts);
    assert.equal((await http.post('/git/workspaces/ws-ignore/submit', { sha: SUBMITTED })).status, 200);
    artifacts.beforeFastForward = async input => {
      const signal = input.signal;
      assert.ok(signal, 'the call carries an abort signal');
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      // The provider ignores the abort. Meanwhile the lease expires and a reclaimer takes over.
      const intent = await db.prepare('SELECT id FROM wrgit_merge_intents WHERE task_id=?').bind('task-ignore').first<{ id: string }>();
      assert.ok(intent);
      await db.prepare('UPDATE wrgit_merge_intents SET write_open_at=? WHERE id=?').bind(frozen - WRITE_OPEN_LEASE_MS - 1, intent.id).all();
      const claim = await takeoverExpiredLease(db, artifacts, intent.id, 'reclaimer-ignore');
      reclaimed = claim.wroteLease;
      abortedWhenLanded = signal.aborted;
    };
    const late = await http.post('/git/merge', { task_id: 'task-ignore', receipt_id: 'rcpt-ignore' });
    assert.equal(reclaimed, true, 'the lease was reclaimed before the effect landed');
    assert.equal(abortedWhenLanded, true, 'the effect landed after the abort fired');
    // The external effect is not bounded by the lease: canonical moved anyway.
    assert.equal(artifacts.head(CANONICAL), SUBMITTED);
    assert.equal(late.status, 409, JSON.stringify(late.body));
    assert.equal(codeOf(late.body), 'stale_lock');
    assert.equal((await mergeRows(db, 'task-ignore')).length, 0);
    const workspace = await db.prepare('SELECT status, merged_sha FROM wrgit_workspaces WHERE id=?')
      .bind('ws-ignore').first<{ status: string; merged_sha: string | null }>();
    assert.deepEqual(workspace, { status: 'submitted', merged_sha: null });
  } finally {
    mergeClock.now = previous;
    await close();
  }
});

function failWorkspaceMarkOnce(db: Database) {
  const state = { armed: false };
  const hook = async (sql: string) => {
    if (state.armed && sql.includes("SET head_sha=?, merged_sha=?, status='merged'")) {
      state.armed = false;
      throw new Error('injected: worker died after the merge record');
    }
  };
  return { state, db: wrapDb(db, { beforeFirst: hook, beforeAll: hook }) };
}

async function partialMerge(db: Database, taskId: string) {
  const artifacts = new MemoryArtifacts();
  await twoWorkspaces(db, artifacts, taskId);
  const hooked = failWorkspaceMarkOnce(db);
  const revoke = revokeHook(hooked.db);
  const http = appFor(revoke.db, artifacts);
  assert.equal((await http.post(`/git/workspaces/${taskId}-b/submit`, { sha: SUBMITTED })).status, 200);
  hooked.state.armed = true;
  const first = await http.post('/git/merge', { task_id: taskId, receipt_id: `rcpt-${taskId}` });
  assert.notEqual(first.status, 200, JSON.stringify(first.body));
  assert.equal(hooked.state.armed, false, 'the injected failure ran');
  assert.equal((await mergeRows(db, taskId)).length, 1, 'the merge record exists');
  const ws = await db.prepare('SELECT status FROM wrgit_workspaces WHERE id=?').bind(`${taskId}-b`).first<{ status: string }>();
  assert.equal(ws?.status, 'submitted', 'the workspace was not marked merged');
  return { artifacts, http, revoke: revoke.state };
}

test('partial recovery: a retry after the merge record exists by a revoked merger is 403 and writes nothing', async () => {
  const { db, close } = await database();
  try {
    const { artifacts, http, revoke } = await partialMerge(db, 'task-pr1');
    const intentBefore = await db.prepare('SELECT outcome, settled_at FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-pr1').first<{ outcome: string | null; settled_at: number | null }>();
    // Revoke after the route authorize passed: the existing-record lookup inside the merge lock.
    revoke.marker = 'SELECT sha, receipt_id FROM wrgit_merges WHERE workspace_id=?';
    const retry = await http.post('/git/merge', { task_id: 'task-pr1', receipt_id: 'rcpt-task-pr1' });
    assert.equal(revoke.marker, '', 'the revoke ran mid-request');
    assert.equal(retry.status, 403, JSON.stringify(retry.body));
    assert.equal(codeOf(retry.body), 'FORBIDDEN');
    const ws = await db.prepare('SELECT status, merged_sha FROM wrgit_workspaces WHERE id=?')
      .bind('task-pr1-b').first<{ status: string; merged_sha: string | null }>();
    assert.deepEqual(ws, { status: 'submitted', merged_sha: null });
    const intentAfter = await db.prepare('SELECT outcome, settled_at FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-pr1').first<{ outcome: string | null; settled_at: number | null }>();
    assert.deepEqual(intentAfter, intentBefore);
    assert.equal(artifacts.fastForwards.length, 1);
  } finally {
    await close();
  }
});

test('partial recovery: a revoke after the existing-record check and before the workspace mark UPDATE is 403 and writes nothing', async () => {
  const { db, close } = await database();
  try {
    const { artifacts, http, revoke } = await partialMerge(db, 'task-pr3');
    const intentBefore = await db.prepare('SELECT outcome, settled_at FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-pr3').first<{ outcome: string | null; settled_at: number | null }>();
    // The existing-record branch's canPost() passes; the revoke lands on the workspace mark UPDATE itself.
    revoke.marker = "SET head_sha=?, merged_sha=?, status='merged'";
    const retry = await http.post('/git/merge', { task_id: 'task-pr3', receipt_id: 'rcpt-task-pr3' });
    assert.equal(revoke.marker, '', 'the revoke ran mid-request');
    assert.equal(retry.status, 403, JSON.stringify(retry.body));
    assert.equal(codeOf(retry.body), 'FORBIDDEN');
    const ws = await db.prepare('SELECT status, merged_sha FROM wrgit_workspaces WHERE id=?')
      .bind('task-pr3-b').first<{ status: string; merged_sha: string | null }>();
    assert.deepEqual(ws, { status: 'submitted', merged_sha: null });
    const intentAfter = await db.prepare('SELECT outcome, settled_at FROM wrgit_merge_intents WHERE task_id=?')
      .bind('task-pr3').first<{ outcome: string | null; settled_at: number | null }>();
    assert.deepEqual(intentAfter, intentBefore);
    assert.equal((await mergeRows(db, 'task-pr3')).length, 1);
    assert.equal(artifacts.fastForwards.length, 1);
  } finally {
    await close();
  }
});

test('partial recovery: an authorized retry after the merge record exists completes the merge', async () => {
  const { db, close } = await database();
  try {
    const { artifacts, http } = await partialMerge(db, 'task-pr2');
    const retry = await http.post('/git/merge', { task_id: 'task-pr2', receipt_id: 'rcpt-task-pr2' });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    const ws = await db.prepare('SELECT status, merged_sha FROM wrgit_workspaces WHERE id=?')
      .bind('task-pr2-b').first<{ status: string; merged_sha: string | null }>();
    assert.deepEqual(ws, { status: 'merged', merged_sha: SUBMITTED });
    assert.equal((await mergeRows(db, 'task-pr2')).length, 1);
    assert.equal(artifacts.fastForwards.length, 1);
  } finally {
    await close();
  }
});

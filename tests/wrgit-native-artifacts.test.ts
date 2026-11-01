import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { taskFixtures } from '../scripts/task-fixtures.ts';
import { createHash } from 'node:crypto';
import { Fault } from '../src/server/contracts.ts';
import { GATE_VERSION, evaluateVerifierReceipt } from '../src/server/verifier-receipt.ts';
import { RED_CASE_IDS } from '../src/phase-contracts/verifier-receipt.ts';
import type { Database, Env } from '../src/server/db.ts';
import { createApp, type Authenticate } from '../src/server/app.ts';
import { Workroom } from '../src/server/domain.ts';
import { wrgitClaim } from '../src/server/wrgit/routes.ts';
import { nativeArtifacts, type NativeArtifacts, type NativeArtifactsRepo } from '../src/server/wrgit/native-artifacts.ts';
import { WRGIT_CANONICAL_REPO, workspaceRepoName } from '../src/server/wrgit/workspaces.ts';

// WG-11 r2: Dots FAIL @a344f19. The real ARTIFACTS binding is a namespace whose get(name)
// returns a disposable repo handle (workers-types 5.20261028.1, interface Artifacts /
// ArtifactsRepo). This fake has only that shape, so any caller that expects fork/log/
// issueToken on the namespace itself fails here.

const BASE = 'c0ffee00' + '0'.repeat(32);
const REPO_NAME = /^[A-Za-z0-9._-]+$/;

class FakeArtifactsError extends Error {
  readonly name = 'ArtifactsError';
  constructor(readonly code: string) { super(`artifacts ${code} (detail art_test_leak)`); }
}

interface Stored { name: string; commits: { hash: string; message: string }[]; source: string | null }
interface Call { op: string; repo: string }

class NativeFake implements NativeArtifacts {
  readonly repos = new Map<string, Stored>();
  readonly calls: Call[] = [];
  disposed = 0;
  failGet: string | null = null;
  failFork: string | null = null;
  // When set, fork holds for this long so concurrent requests overlap inside the binding call.
  forkDelayMs = 0;
  readonly overlap: number[] = [];
  constructor() { this.repos.set(WRGIT_CANONICAL_REPO, { name: WRGIT_CANONICAL_REPO, commits: [{ hash: BASE, message: 'base' }], source: null }); }
  private check(name: string) { if (!REPO_NAME.test(name)) throw new FakeArtifactsError('INVALID_REPO_NAME'); }
  private result(name: string) {
    return { id: 'id-' + name, name, description: null, defaultBranch: 'main', remote: `https://u:p@artifacts.example/workroom/${name}.git?token=x`, token: 'art_test_create' };
  }
  async create(name: string) { this.check(name); this.repos.set(name, { name, commits: [], source: null }); return this.result(name); }
  async import(params: { source: { url: string }; target: { name: string } }) { this.check(params.target.name); this.repos.set(params.target.name, { name: params.target.name, commits: [{ hash: BASE, message: 'imported' }], source: params.source.url }); return this.result(params.target.name); }
  async list() { return { repos: [], total: this.repos.size }; }
  async delete(name: string) { return this.repos.delete(name); }
  async get(name: string): Promise<NativeArtifactsRepo> {
    this.calls.push({ op: 'get', repo: name });
    if (this.failGet) throw new FakeArtifactsError(this.failGet);
    this.check(name);
    const stored = this.repos.get(name);
    if (!stored) throw new FakeArtifactsError('NOT_FOUND');
    return {
      async info() { return { id: 'id-' + name, name, description: null, defaultBranch: 'main', createdAt: '', updatedAt: '', lastPushAt: null, source: stored.source, readOnly: false, remote: `https://artifacts.example/workroom/${name}.git` }; },
      async log(opts?: { limit?: number }) { return stored.commits.slice(0, opts?.limit ?? 50).map(c => ({ hash: c.hash, treeHash: c.hash, message: c.message, author: { name: 'a', email: 'a@x' }, committer: { name: 'a', email: 'a@x' }, parents: [], authoredAt: 1, committedAt: 1 })); },
      fork: async (target: string) => {
        this.calls.push({ op: 'fork', repo: `${name}->${target}` });
        if (this.failFork) throw new FakeArtifactsError(this.failFork);
        if (this.forkDelayMs) {
          this.overlap.push(this.calls.filter(c => c.op === 'get').length);
          await new Promise(resolve => setTimeout(resolve, this.forkDelayMs));
        }
        this.check(target);
        if (this.repos.has(target)) throw new FakeArtifactsError('ALREADY_EXISTS');
        this.repos.set(target, { name: target, commits: stored.commits.map(c => ({ ...c })), source: `artifacts:workroom/${name}` });
        return this.result(target);
      },
      createToken: async (scope: 'read' | 'write' = 'write') => { this.calls.push({ op: 'createToken', repo: name }); return { id: 't1', plaintext: `art_test_${scope}_${crypto.randomUUID()}`, scope, expiresAt: '2026-10-29T00:00:00.000Z' }; },
      async readFile() { return new Blob([new TextEncoder().encode('hi')]); },
      [Symbol.dispose]: () => { this.disposed += 1; },
    } as unknown as NativeArtifactsRepo;
  }
}

const authenticate: Authenticate = async request => {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (token === 'alpha') return { principal: 'synthetic:alpha', write: true };
  if (token === 'beta') return { principal: 'synthetic:beta', write: true };
  throw new Fault('UNAUTHENTICATED', 'fixture token required', 401);
};

let db: Database;
let close: () => Promise<void>;
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrgit-native-'));
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null) } }', d1Databases: { DB: 'wrgit-native' }, d1Persist: dir, cf: false });
  db = await mf.getD1Database('DB') as unknown as Database;
  await migrate(db as unknown as Awaited<ReturnType<Miniflare['getD1Database']>>, 9999);
  await db.batch([
    db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
    ...['alpha', 'beta'].map(n => db.prepare('INSERT INTO principals(id) VALUES (?)').bind('synthetic:' + n)),
    ...['alpha', 'beta'].map(n => db.prepare('INSERT INTO memberships(principal_id,room_id,can_post) VALUES (?, ?, 1)').bind('synthetic:' + n, 'room_main')),
  ]);
  await taskFixtures(db as unknown as Awaited<ReturnType<Miniflare['getD1Database']>>);
  close = async () => { await mf.dispose(); rmSync(dir, { recursive: true, force: true }); };
});
after(async () => { await close?.(); });

function env(fake: NativeFake | undefined, enabled: boolean): Env {
  return { DB: db, WRGIT_ENABLED: enabled ? '1' : '0', ARTIFACTS: fake } as Env;
}

async function call(e: Env, path: string, body?: unknown, token = 'alpha') {
  const headers: Record<string, string> = { authorization: 'Bearer ' + token, 'idempotency-key': crypto.randomUUID() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await createApp(authenticate, { ui: false }).fetch(new Request('http://127.0.0.1' + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }), e);
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as { data?: Record<string, unknown>; error?: { code?: string } } };
}

async function newTask(e: Env) {
  const made = await call(e, '/api/v1/rooms/room_main/tasks', { schema_version: '1', goal: 'native', done_conditions: ['ok'] });
  assert.equal(made.status, 200, made.text);
  const data = made.json.data as { task: { id: string; version: number }; lease: { lease_epoch: number } };
  return { id: data.task.id, version: data.task.version, lease_epoch: data.lease.lease_epoch };
}

function claim(e: Env, t: { id: string; version: number; lease_epoch: number }, token = 'alpha') {
  return call(e, `/api/v1/rooms/room_main/tasks/${t.id}/claim`, { schema_version: '1', expected_version: t.version, lease_epoch: t.lease_epoch }, token);
}

async function state(taskId: string) {
  const row = await db.prepare(`SELECT t.state AS state, l.holder_id AS holder FROM tasks t JOIN task_leases l ON l.task_id=t.id WHERE t.id=?`).bind(taskId).first<{ state: string; holder: string | null }>();
  const pending = await db.prepare('SELECT count(*) AS n FROM wrgit_workspace_pending WHERE task_id=?').bind(taskId).first<{ n: number }>();
  const ws = await db.prepare('SELECT count(*) AS n FROM wrgit_workspaces WHERE task_id=?').bind(taskId).first<{ n: number }>();
  return { state: row?.state, holder: row?.holder, pending: Number(pending?.n), workspaces: Number(ws?.n) };
}

describe('WR-GIT over the native ARTIFACTS binding shape', { concurrency: false }, () => {
  test('canonical repo name is a valid native repo name', () => {
    assert.match(WRGIT_CANONICAL_REPO, REPO_NAME);
  });

  test('adapter maps namespace.get(repo) handles onto get/fork/log/issueToken and disposes each handle', async () => {
    const fake = new NativeFake();
    const artifacts = nativeArtifacts(fake);
    const info = await artifacts.get(WRGIT_CANONICAL_REPO);
    assert.equal(info.headSha, BASE);
    assert.equal(info.defaultBranch, 'main');
    const forked = await artifacts.fork(WRGIT_CANONICAL_REPO, 'ws-1');
    assert.equal(forked.name, 'ws-1');
    assert.equal((await artifacts.log('ws-1'))[0]?.hash, BASE);
    const token = await artifacts.issueToken('ws-1', 'write');
    assert.equal(token.scope, 'write');
    assert.match(token.token, /^art_test_write_/);
    assert.equal(token.expiresAt, Date.parse('2026-10-29T00:00:00.000Z'));
    assert.deepEqual([...(await artifacts.readFile('ws-1', 'main', 'a.txt'))!], [...new TextEncoder().encode('hi')]);
    assert.equal(fake.disposed, fake.calls.filter(c => c.op === 'get').length);
  });

  test('adapter normalizes ArtifactsError to its code and drops the native message', async () => {
    const artifacts = nativeArtifacts(new NativeFake());
    await assert.rejects(artifacts.get('missing'), (error: Error) => error.message === 'NOT_FOUND' && !error.message.includes('art_test_'));
  });

  test('flag off: claim does not touch the binding', async () => {
    const fake = new NativeFake();
    const e = env(fake, false);
    const t = await newTask(e);
    const claimed = await claim(e, t);
    assert.equal(claimed.status, 200, claimed.text);
    assert.deepEqual(fake.calls, []);
    assert.equal((await state(t.id)).workspaces, 0);
  });

  test('flag off: claim_next does not touch the binding', async () => {
    await db.prepare("UPDATE tasks SET state='canceled', version=version+1 WHERE state='open'").all();
    const fake = new NativeFake();
    const e = env(fake, false);
    const t = await newTask(e);
    const room = new Workroom(db, 'synthetic:alpha', undefined, undefined, wrgitClaim(e, nativeArtifacts(fake)));
    const next = await room.tasks.claimNext({ schema_version: '1', room: 'room_main', idempotency_key: crypto.randomUUID() });
    assert.equal((next.data as { task?: { id?: string } }).task?.id, t.id);
    assert.deepEqual(fake.calls, []);
  });

  test('flag on: claim_next forks the workspace for the task it claims', async () => {
    await db.prepare("UPDATE tasks SET state='canceled', version=version+1 WHERE state='open'").all();
    const fake = new NativeFake();
    const e = env(fake, true);
    const t = await newTask(e);
    const room = new Workroom(db, 'synthetic:alpha', undefined, undefined, wrgitClaim(e, nativeArtifacts(fake)));
    const next = await room.tasks.claimNext({ schema_version: '1', room: 'room_main', idempotency_key: crypto.randomUUID() });
    assert.equal((next.data as { task?: { id?: string } }).task?.id, t.id);
    assert.ok(fake.repos.has(workspaceRepoName(t.id, 'synthetic:alpha')));
    assert.deepEqual(await state(t.id), { state: 'in_progress', holder: 'synthetic:alpha', pending: 0, workspaces: 1 });
  });

  test('flag on: claim forks a per-agent workspace from canonical through the native handle', async () => {
    const fake = new NativeFake();
    const e = env(fake, true);
    const t = await newTask(e);
    const claimed = await claim(e, t);
    assert.equal(claimed.status, 200, claimed.text);
    const repo = workspaceRepoName(t.id, 'synthetic:alpha');
    assert.ok(fake.calls.some(c => c.op === 'fork' && c.repo === `${WRGIT_CANONICAL_REPO}->${repo}`));
    assert.deepEqual(await state(t.id), { state: 'in_progress', holder: 'synthetic:alpha', pending: 0, workspaces: 1 });
    assert.ok(!claimed.text.includes('art_test_'));
  });

  test('flag on: POST /git/workspaces returns a write token and a remote without credentials', async () => {
    const fake = new NativeFake();
    const e = env(fake, true);
    const t = await newTask(e);
    assert.equal((await claim(e, t)).status, 200);
    const opened = await call(e, '/git/workspaces', { task_id: t.id });
    assert.equal(opened.status, 200, opened.text);
    const data = opened.json.data as { remote_url: string; token: string; base_sha: string };
    assert.match(data.token, /^art_test_write_/);
    assert.equal(data.base_sha, BASE);
    assert.ok(!data.remote_url.includes('u:p@') && !data.remote_url.includes('token='), data.remote_url);
  });

  test('flag on: distinct agents get distinct workspace repos', async () => {
    const fake = new NativeFake();
    const e = env(fake, true);
    const t = await newTask(e);
    assert.equal((await claim(e, t)).status, 200);
    const a = workspaceRepoName(t.id, 'synthetic:alpha');
    const b = workspaceRepoName(t.id, 'synthetic:beta');
    assert.notEqual(a, b);
    assert.ok(fake.repos.has(a));
    assert.ok(!fake.repos.has(b));
    // Only the claimant opens a workspace (#83 follow-up), so beta cannot fork on alpha's task.
    const other = await call(e, '/git/workspaces', { task_id: t.id }, 'beta');
    assert.equal(other.status, 403, other.text);
    assert.ok(!fake.repos.has(b));
    const u = await newTask(e);
    assert.equal((await claim(e, u, 'beta')).status, 200);
    const own = workspaceRepoName(u.id, 'synthetic:beta');
    assert.notEqual(own, a);
    assert.ok(fake.repos.has(own));
  });

  test('flag on: binding error before the claim leaves the task open and returns 503', async () => {
    const fake = new NativeFake();
    fake.failGet = 'INTERNAL_ERROR';
    const e = env(fake, true);
    const t = await newTask(e);
    const claimed = await claim(e, t);
    assert.equal(claimed.status, 503, claimed.text);
    assert.equal((await state(t.id)).state, 'open');
    assert.ok(!claimed.text.includes('art_test_'));
  });

  test('flag on: fork failure after the D1 claim is recoverable and a retry finishes the workspace', async () => {
    const fake = new NativeFake();
    fake.failFork = 'INTERNAL_ERROR';
    const e = env(fake, true);
    const t = await newTask(e);
    const first = await claim(e, t);
    assert.equal(first.status, 503, first.text);
    assert.deepEqual(await state(t.id), { state: 'in_progress', holder: 'synthetic:alpha', pending: 1, workspaces: 0 });
    fake.failFork = null;
    const retry = await claim(e, t);
    assert.equal(retry.status, 200, retry.text);
    assert.deepEqual(await state(t.id), { state: 'in_progress', holder: 'synthetic:alpha', pending: 0, workspaces: 1 });
  });

  test('flag on: merge fails closed with 503 because the native binding has no fast-forward', async () => {
    const fake = new NativeFake();
    const e = env(fake, true);
    const t = await newTask(e);
    assert.equal((await claim(e, t)).status, 200);
    await db.prepare('UPDATE wrgit_workspaces SET submitted_sha=? WHERE task_id=?').bind(BASE, t.id).all();
    const merged = await call(e, '/git/merge', { task_id: t.id, receipt_id: 'none' }, 'beta');
    assert.equal(merged.status, 503, merged.text);
    assert.equal(fake.repos.get(WRGIT_CANONICAL_REPO)?.commits[0]?.hash, BASE);
  });
  test('flag on: merge stays fail-closed with a stored receipt from another room and issuer while no native writer exists', async () => {
    // Dots 147dc074: the receipt lookup is keyed by id only. Until room, named verifier and
    // caller=issuer binding exist, the missing native fast-forward must stop merge first.
    const fake = new NativeFake();
    const e = env(fake, true);
    const t = await newTask(e);
    assert.equal((await claim(e, t)).status, 200);
    await db.prepare('UPDATE wrgit_workspaces SET submitted_sha=?, head_sha=?, status=? WHERE task_id=?').bind(BASE, BASE, 'submitted', t.id).all();
    const receiptId = 'rcpt-foreign-' + t.id;
    // A structurally valid PASS for this task and sha, but issued in another room by a third
    // principal who is not the merge caller. Only the missing native writer stops it today.
    const runs = RED_CASE_IDS.map(case_id => { const evidence = `log ${case_id}`; return { case_id, evidence, evidence_sha256: createHash('sha256').update(evidence, 'utf8').digest('hex') }; });
    const seen = {
      consumer: 'P2', producer_id: 'synthetic_alpha', acceptor_id: 'synthetic_gamma', next_maker: 'synthetic_alpha',
      author_lineage: { method: 'author.impl', dependencies: ['pkg-a'] }, verifier_lineage: { method: 'verifier.impl', dependencies: ['pkg-a'] },
      sha: BASE, observed_sha: BASE, claimed_gate_version: GATE_VERSION, task_id: t.id, attempt_id: 'attempt_1',
      artifact_digest: 'e'.repeat(64), verifier_id: 'synthetic_gamma', lease: { epoch: 'lease_1', stale: false },
      capability_label_as_authority: false, approval_events: ['accept'], observation_ok: true, runs,
    };
    const evaluation = evaluateVerifierReceipt(seen as Parameters<typeof evaluateVerifierReceipt>[0]);
    assert.equal(evaluation.disposition, 'PASS');
    await db.prepare(`INSERT INTO verifier_receipts(id, room_id, principal_id, disposition, observation_json, result_json, idempotency_key, recorded_at)
      VALUES (?, 'room_other', 'synthetic:gamma', 'PASS', ?, ?, ?, ?)`).bind(receiptId, JSON.stringify(seen), JSON.stringify({ disposition: 'PASS', receipt: evaluation.receipt, observation: seen }), 'idem-' + receiptId, Date.now()).all();
    const merged = await call(e, '/git/merge', { task_id: t.id, receipt_id: receiptId }, 'beta');
    assert.equal(merged.status, 503, merged.text);
    assert.equal(merged.json.error?.code, 'UNAVAILABLE');
    assert.equal(fake.repos.get(WRGIT_CANONICAL_REPO)?.commits[0]?.hash, BASE);
    const ws = await db.prepare('SELECT status, merged_sha FROM wrgit_workspaces WHERE task_id=?').bind(t.id).first<{ status: string; merged_sha: string | null }>();
    assert.deepEqual(ws, { status: 'submitted', merged_sha: null });
    const intents = await db.prepare('SELECT count(*) AS n FROM wrgit_merge_intents WHERE receipt_id=?').bind(receiptId).first<{ n: number }>();
    assert.equal(Number(intents?.n), 0);
    const merges = await db.prepare('SELECT count(*) AS n FROM wrgit_merges WHERE task_id=?').bind(t.id).first<{ n: number }>();
    assert.equal(Number(merges?.n), 0);
  });

  test('race: two agents claiming one task at once leave one holder, one workspace and one fork', async () => {
    const fake = new NativeFake();
    fake.forkDelayMs = 150;
    const e = env(fake, true);
    const t = await newTask(e);
    const [a, b] = await Promise.all([claim(e, t, 'alpha'), claim(e, t, 'beta')]);
    const wins = [a, b].filter(r => r.status === 200);
    assert.equal(wins.length, 1, `${a.status} ${a.text} | ${b.status} ${b.text}`);
    const winner = a.status === 200 ? 'synthetic:alpha' : 'synthetic:beta';
    const after = await state(t.id);
    assert.deepEqual(after, { state: 'in_progress', holder: winner, pending: 0, workspaces: 1 });
    const owner = await db.prepare('SELECT agent_id FROM wrgit_workspaces WHERE task_id=?').bind(t.id).first<{ agent_id: string }>();
    assert.equal(owner?.agent_id, winner);
    assert.equal(fake.calls.filter(c => c.op === 'fork').length, 1);
    assert.ok(fake.repos.has(workspaceRepoName(t.id, winner)));
    assert.ok(!fake.repos.has(workspaceRepoName(t.id, winner === 'synthetic:alpha' ? 'synthetic:beta' : 'synthetic:alpha')));
  });

  test('race: the holder opening its workspace twice at once ends with one workspace row and one repo', async () => {
    const fake = new NativeFake();
    const e = env(fake, true);
    const t = await newTask(e);
    assert.equal((await claim(e, t)).status, 200);
    const repo = workspaceRepoName(t.id, 'synthetic:alpha');
    fake.repos.delete(repo);
    await db.prepare('DELETE FROM wrgit_workspaces WHERE task_id=?').bind(t.id).all();
    fake.forkDelayMs = 150;
    const getsBefore = fake.calls.filter(c => c.op === 'get').length;
    const [x, y] = await Promise.all([
      call(e, '/git/workspaces', { task_id: t.id }),
      call(e, '/git/workspaces', { task_id: t.id }),
    ]);
    // Both requests were inside the binding before the first fork returned.
    assert.ok(fake.overlap.length >= 1 && fake.overlap[0]! - getsBefore >= 2, JSON.stringify({ overlap: fake.overlap, getsBefore }));
    // Opening is idempotent for the holder: the overlapping request adopts the fork instead of failing.
    assert.deepEqual([x.status, y.status], [200, 200], `${x.text} | ${y.text}`);
    // Dots 147dc074: the URL lives in the response envelope's data, not at the top level.
    const urls = [x, y].map(r => r.json.data?.remote_url);
    for (const url of urls) assert.ok(typeof url === 'string' && url.length > 0, JSON.stringify(urls));
    assert.equal(urls[0], urls[1]);
    // Both results bind to the one row: same repo, same creator, same stored remote.
    const rows = await db.prepare('SELECT repo, agent_id, remote_url FROM wrgit_workspaces WHERE task_id=?').bind(t.id).all<{ repo: string; agent_id: string; remote_url: string | null }>();
    assert.equal(rows.results.length, 1);
    assert.deepEqual(rows.results[0], { repo, agent_id: 'synthetic:alpha', remote_url: urls[0] });
    assert.ok((urls[0] as string).includes(`/${repo}.git`));
    assert.ok(fake.repos.has(repo));
    assert.ok(![x.text, y.text].some(text => text.includes('art_test_leak')));
  });
});

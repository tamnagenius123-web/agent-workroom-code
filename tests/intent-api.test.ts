import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { hashPassword } from '../src/auth/password.ts';
import { createApp } from '../src/server/app.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';

const ORIGIN = 'https://intent.test';

function applySql(db: Database, sql: string) {
  const statements = sql.trim().split(/;\s*\n/).filter(s => s.trim()).map(s => db.prepare(s));
  return db.batch(statements);
}

async function database(): Promise<{ db: Database; close: () => Promise<void> }> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: 'intent-api-' + crypto.randomUUID() },
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const db = await mf.getD1Database('DB') as Database;
  return { db, close: () => mf.dispose() };
}

test('migration 0054 creates the intent tables and rejects a non-owner author', async () => {
  const name = readdirSync('migrations').find(entry => /^0054_.*\.sql$/.test(entry));
  assert.ok(name, 'migrations/0054_*.sql is missing');
  const sql = readFileSync('migrations/' + name, 'utf8');
  assert.match(sql, /CREATE TABLE intent_versions\b/);
  assert.match(sql, /CREATE TABLE rules\b/);
  assert.match(sql, /CREATE TABLE intent_reads\b/);
  assert.match(sql, /author_principal TEXT NOT NULL CHECK \(author_principal='user:minsung'\)/);
  assert.match(sql, /REFERENCES owner_directives\(id\)/);
  const { db, close } = await database();
  try {
    await applySql(db, 'CREATE TABLE owner_directives (id TEXT PRIMARY KEY);\n');
    await applySql(db, sql);
    const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('intent_versions','rules','intent_reads') ORDER BY name").all<{ name: string }>()).results.map(row => row.name);
    assert.deepEqual(tables, ['intent_reads', 'intent_versions', 'rules']);
    const versionCols = (await db.prepare('PRAGMA table_info(intent_versions)').all<{ name: string }>()).results.map(row => row.name);
    assert.deepEqual(versionCols, ['version', 'north_star', 'intent_md', 'parent_version', 'directive_id', 'author_principal', 'content_hash', 'created_at']);
    const ruleCols = (await db.prepare('PRAGMA table_info(rules)').all<{ name: string }>()).results.map(row => row.name);
    assert.deepEqual(ruleCols, ['rule_id', 'text', 'kind', 'status', 'introduced_in', 'retired_in', 'superseded_by', 'provenance', 'retire_reason']);
    await db.prepare("INSERT INTO owner_directives(id) VALUES ('d1')").all();
    await db.prepare(`INSERT INTO intent_versions(version, north_star, intent_md, parent_version, directive_id, author_principal, content_hash, created_at)
      VALUES (1, 'star', 'why', NULL, 'd1', 'user:minsung', 'abc', '2026-10-26T00:00:00.000Z')`).all();
    await assert.rejects(
      () => db.prepare(`INSERT INTO intent_versions(version, north_star, intent_md, parent_version, directive_id, author_principal, content_hash, created_at)
        VALUES (2, 'star', 'why', 1, 'd1', 'agent:dots', 'abd', '2026-10-26T00:00:01.000Z')`).all(),
      /CHECK|constraint/i,
    );
    await assert.rejects(
      () => db.prepare(`INSERT INTO rules(rule_id, text, kind, status, introduced_in, retired_in, superseded_by, provenance, retire_reason)
        VALUES ('R', 't', 'gate', 'active', 1, NULL, NULL, 'file:x', NULL)`).all(),
      /CHECK|constraint/i,
    );
    await db.prepare("INSERT INTO intent_reads(agent_id, version, read_at) VALUES ('agent:dots', 1, '2026-10-26T00:00:02.000Z')").all();
    await assert.rejects(
      () => db.prepare("INSERT INTO intent_reads(agent_id, version, read_at) VALUES ('agent:dots', 1, '2026-10-26T00:00:03.000Z')").all(),
      /UNIQUE|PRIMARY|constraint/i,
    );
  } finally { await close(); }
});

test('registry marks 0054 used and worker plus app mount the intent routes', () => {
  const registry = readFileSync('migrations/REGISTRY.md', 'utf8');
  const allocations = readFileSync('src/phase-contracts/migrations.ts', 'utf8');
  assert.match(registry, /\| 0054 \| I1 intent layer \(0054_intent\.sql\) \| used \|/);
  assert.match(registry, /^merge_order:.*\b0054\b/m);
  assert.match(allocations, /'0054': \{ unit: 'I1 intent layer \(0054_intent\.sql\)', status: 'used' \}/);
  assert.match(readFileSync('src/server/worker.ts', 'utf8'), /intentOwnerRoutes/);
  assert.match(readFileSync('src/server/app.ts', 'utf8'), /intentAgentRoute/);
});

interface RuleBrief { id: string; text: string }
interface Diff { added: RuleBrief[]; retired: RuleBrief[]; changed: RuleBrief[] }
interface View {
  v: number; north_star: string; intent_md: string; rules_active: RuleBrief[]; diff: Diff;
}
interface WriteBody {
  version: number; parent_version: number | null; directive_id: string; content_hash: string; replayed: boolean;
}
interface LineDiff { a: number; b: number; north_star: { from: string; to: string }; intent_md_diff: { op: string; line: string }[]; rules: Diff }
interface Envelope<T> { ok: boolean; data: T; error?: { code: string; message: string } }

const OWNER_FIXTURE = `
CREATE TABLE owner_verified_messages (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL
);
CREATE TABLE owner_sessions (
  sid_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX owner_sessions_expiry ON owner_sessions(expires_at);
CREATE TABLE owner_login_gate (
  key_hash TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE owner_directives (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  actor_id TEXT NOT NULL REFERENCES principals(id),
  text TEXT NOT NULL,
  message_id TEXT REFERENCES messages(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (actor_id, idempotency_key)
);
CREATE INDEX owner_directives_message ON owner_directives(message_id);
`;

test('owner POST/PUT /owner/intent and agent GET /v1/intent since and diff', async () => {
  const [{ intentOwnerRoutes }, { issueOwnerSession }] = await Promise.all([
    import('../src/server/intent.ts'),
    import('../src/server/owner-session.ts'),
  ]);
  const { db, close } = await database();
  try {
    await migrate(db, 4);
    await db.batch([
      db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
      db.prepare("INSERT INTO principals(id, active) VALUES ('user:minsung', 1)"),
      db.prepare("INSERT INTO principals(id, active) VALUES ('agent:dots', 1)"),
      db.prepare("INSERT INTO principals(id, active) VALUES ('agent:reader', 1)"),
      db.prepare("INSERT INTO principal_roles(principal_id, kind) VALUES ('user:minsung', 'user')"),
      db.prepare("INSERT INTO memberships(principal_id, room_id, active, can_post) VALUES ('agent:dots', 'room_main', 1, 1)"),
      db.prepare("INSERT INTO memberships(principal_id, room_id, active, can_post) VALUES ('agent:reader', 'room_main', 1, 0)"),
    ]);
    await applySql(db, OWNER_FIXTURE);
    await applySql(db, readFileSync('migrations/0054_intent.sql', 'utf8'));
    const hash = await hashPassword('synthetic-owner-password');
    const env = { DB: db, OWNER_PASSWORD_HASH: hash };
    const issued = await issueOwnerSession(db, hash);
    const app = createApp(async request => {
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (token === 'agent-dots') return { principal: 'agent:dots', write: true };
      if (token === 'agent-read') return { principal: 'agent:reader', write: false };
      if (token === 'owner-relay') return { principal: 'user:minsung', write: true };
      throw new Fault('UNAUTHENTICATED', 'A token is required.', 401);
    }, { ui: false, pre: (request, bound) => intentOwnerRoutes(request, bound as typeof env) });

    const ownerHeaders = (key: string, csrf = issued.session.csrf): Record<string, string> => ({
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'x-csrf-token': csrf,
      Cookie: `__Host-owner_session=${issued.cookie}`,
      ...(key ? { 'Idempotency-Key': key } : {}),
    });
    const call = (path: string, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, init), env);
    const bodyOf = async <T>(response: Response) => await response.json() as Envelope<T>;
    const versions = async () => (await db.prepare('SELECT COUNT(*) AS n FROM intent_versions').all<{ n: number }>()).results[0]?.n ?? 0;

    const noSession = await call('/owner/intent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer agent-dots', Origin: ORIGIN, 'Idempotency-Key': 'agent-write-1' },
      body: JSON.stringify({ north_star: 'stolen', intent_md: 'no' }),
    });
    assert.equal(noSession.status, 401);
    const relay = await call('/owner/intent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner-relay', Origin: ORIGIN, 'Idempotency-Key': 'relay-write-1' },
      body: JSON.stringify({ north_star: 'stolen', intent_md: 'no' }),
    });
    assert.equal(relay.status, 401);
    const csrf = await call('/owner/intent', {
      method: 'POST', headers: ownerHeaders('csrf-reject-1', 'not-the-token'),
      body: JSON.stringify({ north_star: 'North star one', intent_md: 'line one\nline two' }),
    });
    assert.equal(csrf.status, 403);
    const crossSite = await call('/owner/intent', {
      method: 'POST', headers: { ...ownerHeaders('cross-site-01'), Origin: 'https://evil.test' },
      body: JSON.stringify({ north_star: 'North star one', intent_md: 'line one\nline two' }),
    });
    assert.equal(crossSite.status, 403);
    assert.equal(await versions(), 0);

    const created = await call('/owner/intent', {
      method: 'POST', headers: ownerHeaders('post-v1-aaaa'),
      body: JSON.stringify({
        north_star: 'North star one',
        intent_md: 'line one\nline two',
        rules: [
          { op: 'add', rule_id: 'B1', text: 'Sandbox holds', kind: 'boundary', provenance: 'file:section-f' },
          { op: 'add', rule_id: 'N1', text: 'Ask before merge', kind: 'norm', provenance: 'msg:f884a2ad' },
          { op: 'add', rule_id: 'N2', text: 'Prefer short posts', kind: 'preference', provenance: 'file:AGENTS.md' },
        ],
      }),
    });
    assert.equal(created.status, 200);
    const first = (await bodyOf<WriteBody>(created)).data;
    assert.equal(first.version, 1);
    assert.equal(first.parent_version, null);
    assert.equal(first.replayed, false);
    assert.match(first.content_hash, /^[0-9a-f]{64}$/);
    assert.equal((await db.prepare('SELECT author_principal FROM intent_versions WHERE version=1').all<{ author_principal: string }>()).results[0]?.author_principal, 'user:minsung');

    const replay = await call('/owner/intent', {
      method: 'POST', headers: ownerHeaders('post-v1-aaaa'),
      body: JSON.stringify({
        north_star: 'North star one',
        intent_md: 'line one\nline two',
        rules: [
          { op: 'add', rule_id: 'B1', text: 'Sandbox holds', kind: 'boundary', provenance: 'file:section-f' },
          { op: 'add', rule_id: 'N1', text: 'Ask before merge', kind: 'norm', provenance: 'msg:f884a2ad' },
          { op: 'add', rule_id: 'N2', text: 'Prefer short posts', kind: 'preference', provenance: 'file:AGENTS.md' },
        ],
      }),
    });
    assert.equal(replay.status, 200);
    const replayed = (await bodyOf<WriteBody>(replay)).data;
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.version, 1);
    assert.equal(replayed.content_hash, first.content_hash);
    assert.equal(await versions(), 1);

    const clash = await call('/owner/intent', {
      method: 'POST', headers: ownerHeaders('post-v1-aaaa'),
      body: JSON.stringify({ north_star: 'Different star', intent_md: 'line one\nline two' }),
    });
    assert.equal(clash.status, 409);
    assert.equal(await versions(), 1);

    const badRule = await call('/owner/intent', {
      method: 'PUT', headers: ownerHeaders('put-bad-cccc'),
      body: JSON.stringify({ north_star: 'Changed', intent_md: 'line one\nline two', parent_version: 1, rules: [{ op: 'retire', rule_id: 'NOPE', retire_reason: 'missing' }] }),
    });
    assert.equal(badRule.status, 400);
    assert.equal((await db.prepare('SELECT north_star FROM intent_versions WHERE version=1').all<{ north_star: string }>()).results[0]?.north_star, 'North star one');
    assert.equal(await versions(), 1);

    const wrongParent = await call('/owner/intent', {
      method: 'PUT', headers: ownerHeaders('put-wrong-dd'),
      body: JSON.stringify({ north_star: 'North star one', intent_md: 'line one\nline two changed', parent_version: 99, rules: [{ op: 'retire', rule_id: 'N1', retire_reason: 'too soon' }] }),
    });
    assert.equal(wrongParent.status, 409);
    assert.equal(await versions(), 1);

    const second = await call('/owner/intent', {
      method: 'PUT', headers: ownerHeaders('put-v2-bbbb'),
      body: JSON.stringify({
        north_star: 'North star one',
        intent_md: 'line one\nline two changed',
        parent_version: 1,
        rules: [
          { op: 'retire', rule_id: 'N1', retire_reason: 'covered by the sandbox gate' },
          { op: 'deprecate', rule_id: 'N2' },
        ],
      }),
    });
    assert.equal(second.status, 200);
    const v2 = (await bodyOf<WriteBody>(second)).data;
    assert.equal(v2.version, 2);
    assert.equal(v2.parent_version, 1);
    assert.equal(v2.replayed, false);
    const boundary = (await db.prepare('SELECT text, kind, status, provenance, retired_in, retire_reason FROM rules WHERE rule_id=?').bind('B1').all<{ text: string; kind: string; status: string; provenance: string; retired_in: number | null; retire_reason: string | null }>()).results[0];
    assert.deepEqual(boundary, { text: 'Sandbox holds', kind: 'boundary', status: 'active', provenance: 'file:section-f', retired_in: null, retire_reason: null });
    const retired = (await db.prepare('SELECT status, retired_in, retire_reason, provenance FROM rules WHERE rule_id=?').bind('N1').all<{ status: string; retired_in: number; retire_reason: string; provenance: string }>()).results[0];
    assert.deepEqual(retired, { status: 'retired', retired_in: 2, retire_reason: 'covered by the sandbox gate', provenance: 'msg:f884a2ad' });
    const deprecated = (await db.prepare('SELECT status, retired_in, provenance FROM rules WHERE rule_id=?').bind('N2').all<{ status: string; retired_in: number | null; provenance: string }>()).results[0];
    assert.deepEqual(deprecated, { status: 'deprecated', retired_in: null, provenance: 'file:AGENTS.md' });

    const sinceOne = await call('/v1/intent?since=1', { headers: { Authorization: 'Bearer agent-dots' } });
    assert.equal(sinceOne.status, 200);
    assert.deepEqual((await bodyOf<View>(sinceOne)).data, {
      v: 2,
      north_star: 'North star one',
      intent_md: 'line one\nline two changed',
      rules_active: [{ id: 'B1', text: 'Sandbox holds' }],
      diff: {
        added: [],
        retired: [{ id: 'N1', text: 'Ask before merge' }],
        changed: [{ id: 'N2', text: 'Prefer short posts' }],
      },
    });

    const compared = await call('/v1/intent/diff?a=1&b=2', { headers: { Authorization: 'Bearer agent-read' } });
    assert.equal(compared.status, 200);
    assert.deepEqual((await bodyOf<LineDiff>(compared)).data, {
      a: 1,
      b: 2,
      north_star: { from: 'North star one', to: 'North star one' },
      intent_md_diff: [{ op: 'del', line: 'line two' }, { op: 'add', line: 'line two changed' }],
      rules: {
        added: [],
        retired: [{ id: 'N1', text: 'Ask before merge' }],
        changed: [{ id: 'N2', text: 'Prefer short posts' }],
      },
    });

    const named = await call('/owner/intent', {
      method: 'PUT', headers: ownerHeaders('put-v3-eeee'),
      body: JSON.stringify({
        north_star: 'North star one',
        intent_md: 'line one\nline two changed',
        parent_version: 2,
        rules: [{ op: 'change', rule_id: 'B1', text: 'Sandbox holds tight' }],
      }),
    });
    const namedBody = await bodyOf<WriteBody>(named);
    assert.equal(named.status, 200);
    assert.equal(namedBody.data.version, 3);
    const directive = (await db.prepare('SELECT text FROM owner_directives WHERE id=?').bind(namedBody.data.directive_id).all<{ text: string }>()).results[0];
    assert.match(directive?.text ?? '', /B1/);
    const sinceTwo = await call('/v1/intent?since=2', { headers: { Authorization: 'Bearer agent-dots' } });
    assert.deepEqual((await bodyOf<View>(sinceTwo)).data.diff, {
      added: [],
      retired: [],
      changed: [{ id: 'B1', text: 'Sandbox holds tight' }],
    });
    const current = await call('/v1/intent', { headers: { Authorization: 'Bearer agent-read' } });
    assert.equal(current.status, 200);
    assert.match(current.headers.get('etag') ?? '', /^"[0-9a-f]{64}"$/);
    assert.deepEqual((await bodyOf<View>(current)).data, {
      v: 3,
      north_star: 'North star one',
      intent_md: 'line one\nline two changed',
      rules_active: [{ id: 'B1', text: 'Sandbox holds tight' }],
      diff: {
        added: [{ id: 'B1', text: 'Sandbox holds tight' }],
        retired: [{ id: 'N1', text: 'Ask before merge' }],
        changed: [{ id: 'N2', text: 'Prefer short posts' }],
      },
    });
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM intent_reads').all<{ n: number }>()).results[0]?.n, 0);

    const anon = await call('/v1/intent');
    assert.equal(anon.status, 401);
    const posted = await call('/v1/intent', { method: 'POST', headers: { Authorization: 'Bearer agent-dots', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(posted.status, 405);
    const missingKey = await call('/owner/intent', { method: 'POST', headers: ownerHeaders(''), body: JSON.stringify({ north_star: 'North star one', intent_md: 'again' }) });
    assert.equal(missingKey.status, 400);
    const future = await call('/v1/intent?since=99', { headers: { Authorization: 'Bearer agent-dots' } });
    assert.equal(future.status, 404);
    const extra = await call('/v1/intent?since=1&full=1', { headers: { Authorization: 'Bearer agent-dots' } });
    assert.equal(extra.status, 400);
    const backwards = await call('/v1/intent/diff?a=2&b=1', { headers: { Authorization: 'Bearer agent-dots' } });
    assert.equal(backwards.status, 400);
    const ownerGet = await call('/owner/intent', { headers: ownerHeaders('') });
    assert.equal(ownerGet.status, 405);
    assert.equal(await versions(), 3);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM owner_directives').all<{ n: number }>()).results[0]?.n, 3);
  } finally { await close(); }
});

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalActiveState(northStar: string, intentMd: string, rules: { id: string; kind: string; text: string }[]): string {
  const rulesActive = [...rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({ intent_md: intentMd, north_star: northStar, rules_active: rulesActive });
}

// 24000 newlines → 24001 lines. The removed LCS matrix is (lines+1)^2 = 576_096_004 cells.
function largeIntent(first: string): string {
  return first + '\n'.repeat(24000) + 'end';
}

async function bootIntent() {
  const [{ intentOwnerRoutes }, { issueOwnerSession }] = await Promise.all([
    import('../src/server/intent.ts'),
    import('../src/server/owner-session.ts'),
  ]);
  const { db, close } = await database();
  await migrate(db, 4);
  await db.batch([
    db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
    db.prepare("INSERT INTO principals(id, active) VALUES ('user:minsung', 1)"),
    db.prepare("INSERT INTO principals(id, active) VALUES ('agent:dots', 1)"),
    db.prepare("INSERT INTO principal_roles(principal_id, kind) VALUES ('user:minsung', 'user')"),
    db.prepare("INSERT INTO memberships(principal_id, room_id, active, can_post) VALUES ('agent:dots', 'room_main', 1, 1)"),
  ]);
  await applySql(db, OWNER_FIXTURE);
  await applySql(db, readFileSync('migrations/0054_intent.sql', 'utf8'));
  const hash = await hashPassword('synthetic-owner-password', 10_000);
  const env = { DB: db, OWNER_PASSWORD_HASH: hash };
  const issued = await issueOwnerSession(db, hash);
  const app = createApp(async request => {
    if (request.headers.get('authorization') === 'Bearer agent-dots') return { principal: 'agent:dots', write: true };
    throw new Fault('UNAUTHENTICATED', 'A token is required.', 401);
  }, { ui: false, pre: (request, bound) => intentOwnerRoutes(request, bound as typeof env) });
  const ownerHeaders = (key: string): Record<string, string> => ({
    Origin: ORIGIN, 'Content-Type': 'application/json', 'x-csrf-token': issued.session.csrf,
    Cookie: `__Host-owner_session=${issued.cookie}`, 'Idempotency-Key': key,
  });
  const call = (path: string, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, init), env);
  const bodyOf = async <T>(response: Response) => await response.json() as Envelope<T>;
  const write = async (method: 'POST' | 'PUT', key: string, payload: unknown) => {
    const response = await call('/owner/intent', { method, headers: ownerHeaders(key), body: JSON.stringify(payload) });
    const json = await bodyOf<WriteBody>(response);
    assert.equal(response.status, 200, JSON.stringify(json));
    return json.data;
  };
  const view = async (path: string) => {
    const response = await call(path, { headers: { Authorization: 'Bearer agent-dots' } });
    const json = await bodyOf<View>(response);
    return { response, json };
  };
  return { db, close, write, view, call, bodyOf };
}

test('Q15 content_hash and ETag follow the cumulative active-rule state', async () => {
  const { db, close, write, view } = await bootIntent();
  try {
    const star = 'Same star';
    const md = 'same body';
    await write('POST', 'q15-v1-aaaa', {
      north_star: star, intent_md: md,
      rules: [
        { op: 'add', rule_id: 'A', text: 'alpha', kind: 'norm', provenance: 'file:a' },
        { op: 'add', rule_id: 'B', text: 'beta', kind: 'norm', provenance: 'file:b' },
      ],
    });
    const v2 = await write('PUT', 'q15-v2-bbbb', {
      north_star: star, intent_md: md, parent_version: 1,
      rules: [{ op: 'retire', rule_id: 'B', retire_reason: 'folded into A' }],
    });
    const at2 = await view('/v1/intent');
    assert.deepEqual(at2.json.data.rules_active, [{ id: 'A', text: 'alpha' }]);
    const etag2 = at2.response.headers.get('etag');
    await write('PUT', 'q15-v3-cccc', {
      north_star: star, intent_md: md, parent_version: 2,
      rules: [{ op: 'add', rule_id: 'C', text: 'gamma', kind: 'preference', provenance: 'file:c' }],
    });
    const v4 = await write('PUT', 'q15-v4-dddd', {
      north_star: star, intent_md: md, parent_version: 3,
      rules: [{ op: 'change', rule_id: 'A', text: 'alpha-2' }],
    });
    const at4 = await view('/v1/intent');
    assert.deepEqual(at4.json.data.rules_active, [{ id: 'A', text: 'alpha-2' }, { id: 'C', text: 'gamma' }]);
    const etag4 = at4.response.headers.get('etag');
    const v5 = await write('PUT', 'q15-v5-eeee', {
      north_star: star, intent_md: md, parent_version: 4,
      rules: [
        { op: 'change', rule_id: 'A', text: 'alpha' },
        { op: 'retire', rule_id: 'C', retire_reason: 'restored' },
      ],
    });
    const at5 = await view('/v1/intent');
    assert.deepEqual(at5.json.data.rules_active, [{ id: 'A', text: 'alpha' }]);
    const etag5 = at5.response.headers.get('etag');
    const expected = await sha256Hex(canonicalActiveState(star, md, [{ id: 'A', kind: 'norm', text: 'alpha' }]));
    assert.notEqual(v4.content_hash, v2.content_hash, 'v2 and v4 have different cumulative active rules');
    assert.notEqual(etag4, etag2);
    assert.equal(v5.content_hash, v2.content_hash, 'identical cumulative active state shares a content_hash');
    assert.equal(v5.content_hash, expected);
    assert.equal(etag5, etag2);
    assert.equal(etag5, `"${expected}"`);
    const fingerprint = (await db.prepare('SELECT request_hash FROM owner_directives WHERE id=?').bind(v2.directive_id).all<{ request_hash: string }>()).results[0]?.request_hash;
    assert.notEqual(fingerprint, v2.content_hash, 'request fingerprint stays separate from content_hash');
    const since0 = await view('/v1/intent?since=0');
    const since2 = await view('/v1/intent?since=2');
    const since4 = await view('/v1/intent?since=4');
    assert.equal(since0.response.headers.get('etag'), etag5, 'since=0 is the full representation');
    assert.match(since2.response.headers.get('etag') ?? '', /^"[0-9a-f]{64}"$/);
    assert.notEqual(since2.response.headers.get('etag'), etag5, 'a since window is a different representation');
    assert.notEqual(since4.response.headers.get('etag'), since2.response.headers.get('etag'));
    const diff25 = await view('/v1/intent/diff?a=2&b=5');
    const diff25Again = await view('/v1/intent/diff?a=2&b=5');
    const diff24 = await view('/v1/intent/diff?a=2&b=4');
    const diffEtag = diff25.response.headers.get('etag');
    assert.match(diffEtag ?? '', /^"[0-9a-f]{64}"$/);
    assert.equal(diff25Again.response.headers.get('etag'), diffEtag, 'diff ETag is stable');
    assert.notEqual(diffEtag, etag5);
    assert.notEqual(diff24.response.headers.get('etag'), diffEtag, 'a different pair is a different representation');
    const source = readFileSync('src/server/intent.ts', 'utf8');
    assert.match(source, /ETag contract/);
    assert.match(source, /full:/);
    assert.match(source, /since:/);
    assert.match(source, /diff:/);
  } finally { await close(); }
});

if (process.env.I1_FIX_CHILD === '1') {
  test('bounded-diff-worker', async () => {
    const { close, write, call, bodyOf } = await bootIntent();
    try {
      const left = largeIntent('left');
      const right = largeIntent('right');
      assert.equal(left.split('\n').length, 24001);
      assert.equal(right.split('\n').length, 24001);
      assert.equal((24001 + 1) * (24001 + 1), 576_096_004);
      assert.ok(left.length <= 32768 && right.length <= 32768);
      await write('POST', 'big-v1-aaaa', { north_star: 'Star', intent_md: left, rules: [] });
      await write('PUT', 'big-v2-bbbb', { north_star: 'Star', intent_md: right, parent_version: 1, rules: [] });
      const started = Date.now();
      const response = await call('/v1/intent/diff?a=1&b=2', { headers: { Authorization: 'Bearer agent-dots' } });
      const elapsed = Date.now() - started;
      const json = await bodyOf<LineDiff>(response);
      assert.equal(response.status, 200, JSON.stringify(json));
      assert.ok(elapsed < 5_000, 'diff took ' + elapsed + 'ms');
      assert.ok(process.memoryUsage().heapUsed < 400 * 1024 * 1024, 'heap ' + process.memoryUsage().heapUsed);
      assert.deepEqual(json.data.intent_md_diff, [{ op: 'del', line: 'left' }, { op: 'add', line: 'right' }]);
      assert.ok(json.data.intent_md_diff.length <= 24001 + 24001);
    } finally { await close(); }
  });
} else {
  test('accepted 24001-line intent diff stays inside a linear bound', { timeout: 60_000 }, async () => {
    const { spawn } = await import('node:child_process');
    const env: NodeJS.ProcessEnv = { ...process.env, I1_FIX_CHILD: '1' };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [
      '--max-old-space-size=512', '--import', 'tsx', '--test', '--test-reporter=tap',
      '--test-name-pattern', 'bounded-diff-worker', 'tests/intent-api.test.ts',
    ], { env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 45_000);
      child.on('error', reject);
      child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    const out = Buffer.concat(stdout).toString() + Buffer.concat(stderr).toString();
    assert.equal(code, 0, out.slice(-4000));
    assert.match(out, /# fail 0/);
    assert.match(out, /# pass 1/);
  });
}

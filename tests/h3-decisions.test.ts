import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { createApp, READ_TOOLS } from '../src/server/app.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database, Statement } from '../src/server/db.ts';

const ORIGIN = 'https://decisions.test';
const SQL_NAME = '0055_decisions.sql';
const COLUMNS = [
  'id', 'directive_id', 'intent_version', 'statement', 'criteria_json', 'alternatives_json',
  'best_choice', 'scored_choice', 'weight', 'weight_rank', 'provenance', 'approval', 'owner_text',
  'recorded_by', 'room_id', 'idempotency_key', 'request_hash', 'created_at',
];

function applySql(db: Database, sql: string) {
  const statements = sql.trim().split(/;\s*\n/).filter(s => s.trim()).map(s => db.prepare(s));
  return db.batch(statements);
}

async function database(): Promise<{ db: Database; close: () => Promise<void> }> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: 'h3-decisions-' + crypto.randomUUID() },
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const db = await mf.getD1Database('DB') as Database;
  return { db, close: () => mf.dispose() };
}

test('migration 0055 stores weighted decisions linked to directives and intent versions', async () => {
  assert.equal(existsSync('migrations/' + SQL_NAME), true, 'migrations/0055_decisions.sql is missing');
  const sql = readFileSync('migrations/' + SQL_NAME, 'utf8');
  assert.match(sql, /CREATE TABLE decisions\b/);
  assert.match(sql, /directive_id TEXT NOT NULL REFERENCES owner_directives\(id\)/);
  assert.match(sql, /intent_version INTEGER NOT NULL REFERENCES intent_versions\(version\)/);
  assert.match(sql, /weight IN \('USER_STATED', 'relay', 'inferred'\)/);
  assert.match(sql, /weight = 'USER_STATED' AND weight_rank = 3 AND approval = 1/);
  assert.match(sql, /weight = 'relay' AND weight_rank = 2 AND approval = 0 AND owner_text IS NULL/);
  assert.match(sql, /weight = 'inferred' AND weight_rank = 1 AND approval = 0 AND owner_text IS NULL/);
  assert.match(sql, /UNIQUE \(recorded_by, room_id, idempotency_key\)/);
  const { db, close } = await database();
  try {
    await applySql(db, 'CREATE TABLE owner_directives (id TEXT PRIMARY KEY);\nCREATE TABLE intent_versions (version INTEGER PRIMARY KEY);\n');
    await applySql(db, sql);
    const cols = (await db.prepare('PRAGMA table_info(decisions)').all<{ name: string }>()).results.map(row => row.name);
    assert.deepEqual(cols, COLUMNS);
    const indexes = (await db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='decisions'").all<{ name: string }>()).results.map(row => row.name);
    for (const name of ['decisions_directive', 'decisions_created', 'decisions_intent']) assert.ok(indexes.includes(name), name);
    await db.prepare("INSERT INTO owner_directives(id) VALUES ('d1')").all();
    await db.prepare('INSERT INTO intent_versions(version) VALUES (1)').all();
    const insert = `INSERT INTO decisions(${COLUMNS.join(',')}) VALUES (${COLUMNS.map(() => '?').join(',')})`;
    const base = [
      'dec_00000000-0000-4000-8000-000000000001', 'd1', 1, 'cite the id',
      '[{"id":"c","label":"C","weight":1}]',
      '[{"id":"a","label":"A","scores":{"c":1},"weighted_score":1}]',
      'a', 'a', 'inferred', 1, 'directive:d1', 0, null,
      'agent:dots', 'room_main', 'idem-key-01', 'hash-1', '2026-10-27T00:00:00.000Z',
    ];
    await db.prepare(insert).bind(...base).all();
    await assert.rejects(() => db.prepare(insert).bind(...base.slice(0, 8), 'guessed', 1, ...base.slice(10)).all(), /CHECK|constraint/i);
    await assert.rejects(() => db.prepare(insert).bind(
      'dec_00000000-0000-4000-8000-000000000002', 'd1', 1, 'bad rank',
      base[4]!, base[5]!, 'a', 'a', 'relay', 3, 'directive:d1', 0, null,
      'agent:dots', 'room_main', 'idem-key-02', 'hash-2', '2026-10-27T00:00:01.000Z',
    ).all(), /CHECK|constraint/i);
    await assert.rejects(() => db.prepare(insert).bind(
      'dec_00000000-0000-4000-8000-000000000003', 'd1', 1, 'relay approval',
      base[4]!, base[5]!, 'a', 'a', 'relay', 2, 'directive:d1', 1, null,
      'agent:dots', 'room_main', 'idem-key-03', 'hash-3', '2026-10-27T00:00:02.000Z',
    ).all(), /CHECK|constraint/i);
    await assert.rejects(() => db.prepare(insert).bind(
      'dec_00000000-0000-4000-8000-000000000004', 'd1', 1, 'relay quote',
      base[4]!, base[5]!, 'a', 'a', 'relay', 2, 'directive:d1', 0, 'owner said yes',
      'agent:dots', 'room_main', 'idem-key-04', 'hash-4', '2026-10-27T00:00:03.000Z',
    ).all(), /CHECK|constraint/i);
    await assert.rejects(() => db.prepare(insert).bind(
      'dec_00000000-0000-4000-8000-000000000005', 'd1', 1, 'stated without approval',
      base[4]!, base[5]!, 'a', 'a', 'USER_STATED', 3, 'directive:d1', 0, 'owner said yes',
      'user:minsung', 'room_main', 'idem-key-05', 'hash-5', '2026-10-27T00:00:04.000Z',
    ).all(), /CHECK|constraint/i);
    await db.prepare(insert).bind(
      'dec_00000000-0000-4000-8000-000000000006', 'd1', 1, 'owner stated',
      base[4]!, base[5]!, 'a', 'a', 'USER_STATED', 3, 'directive:d1', 1, 'owner said yes',
      'user:minsung', 'room_main', 'idem-key-06', 'hash-6', '2026-10-27T00:00:05.000Z',
    ).all();
    const dup = [...base];
    dup[0] = 'dec_00000000-0000-4000-8000-000000000099';
    dup[16] = 'hash-dup';
    await assert.rejects(() => db.prepare(insert).bind(...dup).all(), /UNIQUE|constraint/i);
    await assert.rejects(() => db.prepare(insert).bind(
      'dec_00000000-0000-4000-8000-000000000007', 'missing', 1, 'no directive',
      base[4]!, base[5]!, 'a', 'a', 'inferred', 1, 'directive:missing', 0, null,
      'agent:muse', 'room_main', 'idem-key-07', 'hash-7', '2026-10-27T00:00:06.000Z',
    ).all(), /FOREIGN KEY|constraint/i);
    await assert.rejects(() => db.prepare(insert).bind(
      'dec_00000000-0000-4000-8000-000000000008', 'd1', 1, 'bad json',
      'not-json', base[5]!, 'a', 'a', 'inferred', 1, 'directive:d1', 0, null,
      'agent:muse', 'room_main', 'idem-key-08', 'hash-8', '2026-10-27T00:00:07.000Z',
    ).all(), /CHECK|constraint|json/i);
  } finally { await close(); }
});

test('registry, HTTP route, MCP tools, and the decisions skill are wired', () => {
  const registry = readFileSync('migrations/REGISTRY.md', 'utf8');
  const allocations = readFileSync('src/phase-contracts/migrations.ts', 'utf8');
  assert.match(registry, /\| 0055 \| H3 weighted decisions \(0055_decisions\.sql\) \| used \|/);
  assert.match(registry, /^merge_order:.*\b0054 0055\b/m);
  assert.match(allocations, /'0055': \{ unit: 'H3 weighted decisions \(0055_decisions\.sql\)', status: 'used' \}/);
  const app = readFileSync('src/server/app.ts', 'utf8');
  const mcp = readFileSync('src/server/mcp.ts', 'utf8');
  assert.match(app, /decisionAgentRoute/);
  assert.match(app, /\/v1\/decisions/);
  assert.match(mcp, /registerDecisionTools/);
  const decisions = readFileSync('src/server/decisions.ts', 'utf8');
  assert.match(decisions, /workroom_decision_cite/);
  assert.match(decisions, /workroom_decision_record/);
  assert.equal(READ_TOOLS.has('workroom_decision_cite'), true);
  assert.equal(READ_TOOLS.has('workroom_decision_record'), false);
  const skill = readFileSync('docs/skills/workroom-decisions.md', 'utf8');
  for (const phrase of ['workroom_decision_cite', 'workroom_decision_record', 'USER_STATED', 'relay', 'inferred', 'directive_id', 'intent_version']) {
    assert.ok(skill.includes(phrase), phrase);
  }
  assert.match(skill, /owner text is never stored as approval/i);
});

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

interface DecisionView {
  id: string;
  directive_id: string;
  intent_version: number;
  statement: string;
  criteria: { id: string; label: string; weight: number }[];
  alternatives: { id: string; label: string; scores: Record<string, number>; weighted_score: number }[];
  best_choice: string;
  scored_choice: string;
  weight: string;
  weight_rank: number;
  provenance: string;
  approval: boolean;
  owner_text: string | null;
  recorded_by: string;
  room_id: string;
  created_at: string;
}
interface Envelope<T> { ok: boolean; data: T; error?: { code: string; message: string }; meta: { count?: number; has_more?: boolean; replayed?: boolean; matched?: number } }

const CRITERIA = [
  { id: 'trace', label: 'Traceable', weight: 0.5 },
  { id: 'cost', label: 'Cheap', weight: 0.5 },
];
const ALTERNATIVES = [
  { id: 'cite', label: 'Cite a decision', scores: { trace: 1, cost: 1 } },
  { id: 'ask', label: 'Ask the owner', scores: { trace: 0, cost: 0 } },
];

function recordBody(extra: Record<string, unknown> = {}) {
  return {
    schema_version: '1',
    directive_id: 'dir-h3-1',
    intent_version: 1,
    statement: 'Agents cite a decision id instead of asking the owner again.',
    criteria: CRITERIA,
    alternatives: ALTERNATIVES,
    best_choice: 'ask',
    weight: 'inferred',
    provenance: 'directive:dir-h3-1',
    ...extra,
  };
}

async function seeded(options?: { database?: (db: Database) => Database }) {
  const { db, close } = await database();
  await migrate(db, 4);
  await db.batch([
    db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
    db.prepare("INSERT INTO principals(id, active) VALUES ('user:minsung', 1)"),
    db.prepare("INSERT INTO principals(id, active) VALUES ('agent:dots', 1)"),
    db.prepare("INSERT INTO principals(id, active) VALUES ('agent:muse', 1)"),
    db.prepare("INSERT INTO principals(id, active) VALUES ('agent:reader', 1)"),
    db.prepare("INSERT INTO principals(id, active) VALUES ('agent:muted', 1)"),
    db.prepare("INSERT INTO principals(id, active) VALUES ('agent:outsider', 1)"),
    db.prepare("INSERT INTO memberships(principal_id, room_id, active, can_post) VALUES ('agent:dots', 'room_main', 1, 1)"),
    db.prepare("INSERT INTO memberships(principal_id, room_id, active, can_post) VALUES ('agent:muse', 'room_main', 1, 1)"),
    db.prepare("INSERT INTO memberships(principal_id, room_id, active, can_post) VALUES ('agent:reader', 'room_main', 1, 0)"),
    db.prepare("INSERT INTO memberships(principal_id, room_id, active, can_post) VALUES ('agent:muted', 'room_main', 1, 0)"),
  ]);
  await applySql(db, OWNER_FIXTURE);
  await applySql(db, readFileSync('migrations/0054_intent.sql', 'utf8'));
  await db.batch([
    db.prepare(`INSERT INTO owner_directives(id, room_id, actor_id, text, message_id, idempotency_key, request_hash, created_at)
      VALUES ('dir-h3-1', 'room_main', 'user:minsung', 'cite decisions', NULL, 'dir-key-0001', 'hash-dir-1', '2026-10-26T00:00:00.000Z')`),
    db.prepare(`INSERT INTO owner_directives(id, room_id, actor_id, text, message_id, idempotency_key, request_hash, created_at)
      VALUES ('dir-h3-2', 'room_main', 'user:minsung', 'second directive', NULL, 'dir-key-0002', 'hash-dir-2', '2026-10-26T00:00:01.000Z')`),
    db.prepare(`INSERT INTO intent_versions(version, north_star, intent_md, parent_version, directive_id, author_principal, content_hash, created_at)
      VALUES (1, 'star', 'why', NULL, 'dir-h3-1', 'user:minsung', 'abc', '2026-10-26T00:00:02.000Z')`),
  ]);
  const env = { DB: options?.database?.(db) ?? db };
  const tokens: Record<string, { principal: string; write: boolean }> = {
    'agent-dots': { principal: 'agent:dots', write: true },
    'agent-muse': { principal: 'agent:muse', write: true },
    'agent-read': { principal: 'agent:reader', write: false },
    'agent-muted': { principal: 'agent:muted', write: true },
    'agent-out': { principal: 'agent:outsider', write: true },
  };
  const app = createApp(async request => {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const identity = tokens[token];
    if (!identity) throw new Fault('UNAUTHENTICATED', 'A token is required.', 401);
    return identity;
  }, { ui: false });
  const call = (path: string, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, init), env);
  const bodyOf = async <T>(response: Response) => await response.json() as Envelope<T>;
  return { db, close, call, bodyOf };
}

function authHeaders(token: string, key?: string): Record<string, string> {
  return {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    ...(key ? { 'Idempotency-Key': key } : {}),
  };
}

test('agents record decisions over HTTP; relay never stores owner text as approval', async () => {
  const decisions = await import('../src/server/decisions.ts');
  assert.ok(decisions.WEIGHT_RANK.USER_STATED > decisions.WEIGHT_RANK.relay);
  assert.ok(decisions.WEIGHT_RANK.relay > decisions.WEIGHT_RANK.inferred);
  const { db, close, call, bodyOf } = await seeded();
  try {
    const notReady = await call('/v1/decisions', { headers: authHeaders('agent-dots') });
    assert.equal(notReady.status, 503);
    assert.equal((await bodyOf<unknown>(notReady)).error?.code, 'NOT_READY');
    await applySql(db, readFileSync('migrations/' + SQL_NAME, 'utf8'));

    const ownerPhrase = '민성 승인: 그대로 해';
    const relayed = await call('/v1/decisions', {
      method: 'POST', headers: authHeaders('agent-dots', 'h3-relay-text-01'),
      body: JSON.stringify(recordBody({ weight: 'relay', owner_text: ownerPhrase, approval: true })),
    });
    assert.equal(relayed.status, 400);
    assert.equal((await bodyOf<unknown>(relayed)).error?.code, 'RELAY_NOT_APPROVAL');
    const stated = await call('/v1/decisions', {
      method: 'POST', headers: authHeaders('agent-dots', 'h3-user-stated-1'),
      body: JSON.stringify(recordBody({ weight: 'USER_STATED' })),
    });
    assert.equal(stated.status, 403);
    assert.equal((await bodyOf<unknown>(stated)).error?.code, 'AGENT_CANNOT_STATE');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM decisions').all<{ n: number }>()).results[0]?.n, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM owner_directives').all<{ n: number }>()).results[0]?.n, 2);
    const leaked = (await db.prepare("SELECT COUNT(*) AS n FROM owner_directives WHERE text LIKE '%' || ? || '%'").bind(ownerPhrase).all<{ n: number }>()).results[0]?.n;
    assert.equal(leaked, 0);

    const muted = await call('/v1/decisions', {
      method: 'POST', headers: authHeaders('agent-muted', 'h3-muted-post-01'),
      body: JSON.stringify(recordBody()),
    });
    assert.equal(muted.status, 403);
    const readerPost = await call('/v1/decisions', {
      method: 'POST', headers: authHeaders('agent-read', 'h3-reader-post1'),
      body: JSON.stringify(recordBody()),
    });
    assert.equal(readerPost.status, 403);
    const outsider = await call('/v1/decisions', { headers: authHeaders('agent-out') });
    assert.equal(outsider.status, 403);

    const created = await call('/v1/decisions', {
      method: 'POST', headers: authHeaders('agent-dots', 'h3-inferred-0001'),
      body: JSON.stringify(recordBody()),
    });
    assert.equal(created.status, 200, JSON.stringify(await created.clone().json()));
    const first = await bodyOf<DecisionView>(created);
    assert.equal(first.meta.replayed, false);
    assert.match(first.data.id, /^dec_[0-9a-f-]{36}$/);
    assert.equal(first.data.weight, 'inferred');
    assert.equal(first.data.weight_rank, 1);
    assert.equal(first.data.approval, false);
    assert.equal(first.data.owner_text, null);
    assert.equal(first.data.recorded_by, 'agent:dots');
    assert.equal(first.data.room_id, 'room_main');
    assert.equal(first.data.directive_id, 'dir-h3-1');
    assert.equal(first.data.intent_version, 1);
    assert.equal(first.data.best_choice, 'ask');
    assert.equal(first.data.scored_choice, 'cite');
    assert.equal(first.data.alternatives.find(row => row.id === 'cite')?.weighted_score, 1);
    assert.equal(first.data.alternatives.find(row => row.id === 'ask')?.weighted_score, 0);
    const stored = (await db.prepare('SELECT weight, weight_rank, approval, owner_text, statement FROM decisions WHERE id=?').bind(first.data.id).all<{
      weight: string; weight_rank: number; approval: number; owner_text: string | null; statement: string;
    }>()).results[0];
    assert.equal(stored?.approval, 0);
    assert.equal(stored?.owner_text, null);
    assert.equal(stored?.statement.includes(ownerPhrase), false);

    const replay = await call('/v1/decisions', {
      method: 'POST', headers: authHeaders('agent-dots', 'h3-inferred-0001'),
      body: JSON.stringify(recordBody()),
    });
    const replayed = await bodyOf<DecisionView>(replay);
    assert.equal(replay.status, 200);
    assert.equal(replayed.meta.replayed, true);
    assert.equal(replayed.data.id, first.data.id);
    const conflict = await call('/v1/decisions', {
      method: 'POST', headers: authHeaders('agent-dots', 'h3-inferred-0001'),
      body: JSON.stringify(recordBody({ statement: 'A different statement.' })),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await bodyOf<unknown>(conflict)).error?.code, 'IDEMPOTENCY_CONFLICT');

    const badSum = await call('/v1/decisions', {
      method: 'POST', headers: authHeaders('agent-dots', 'h3-bad-sum-0001'),
      body: JSON.stringify(recordBody({ criteria: [{ id: 'trace', label: 'Traceable', weight: 0.2 }] })),
    });
    assert.equal(badSum.status, 400);
    const missingParent = await call('/v1/decisions', {
      method: 'POST', headers: authHeaders('agent-dots', 'h3-missing-dir01'),
      body: JSON.stringify(recordBody({ directive_id: 'dir-missing', provenance: 'directive:dir-missing' })),
    });
    assert.equal(missingParent.status, 404);

    const second = await call('/v1/decisions', {
      method: 'POST', headers: authHeaders('agent-muse', 'h3-relay-0000001'),
      body: JSON.stringify(recordBody({
        weight: 'relay', directive_id: 'dir-h3-2', provenance: 'msg:room-post-1', best_choice: 'cite',
        statement: 'Relay records a pointer, not an owner approval.',
      })),
    });
    assert.equal(second.status, 200, JSON.stringify(await second.clone().json()));
    const relay = await bodyOf<DecisionView>(second);
    assert.equal(relay.data.weight, 'relay');
    assert.equal(relay.data.weight_rank, 2);
    assert.equal(relay.data.approval, false);
    assert.equal(relay.data.owner_text, null);
    assert.equal(relay.data.recorded_by, 'agent:muse');
    assert.equal(relay.data.scored_choice, 'cite');
    assert.equal(relay.data.best_choice, 'cite');

    const listed = await bodyOf<{ decisions: DecisionView[] }>(await call('/v1/decisions?directive_id=dir-h3-1', { headers: authHeaders('agent-read') }));
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.data.decisions.map(row => row.id), [first.data.id]);
    const since = await bodyOf<{ decisions: DecisionView[] }>(await call(
      '/v1/decisions?since=' + encodeURIComponent(first.data.created_at) + '&directive_id=dir-h3-1',
      { headers: authHeaders('agent-read') },
    ));
    assert.deepEqual(since.data.decisions, []);
    const all = await bodyOf<{ decisions: DecisionView[] }>(await call('/v1/decisions?since=2020-01-01T00:00:00.000Z', { headers: authHeaders('agent-dots') }));
    assert.deepEqual(all.data.decisions.map(row => row.weight).sort(), ['inferred', 'relay']);
    assert.ok((all.data.decisions[0]?.created_at ?? '') <= (all.data.decisions[1]?.created_at ?? ''));
    assert.equal(all.meta.count, 2);
    const badSince = await call('/v1/decisions?since=yesterday', { headers: authHeaders('agent-dots') });
    assert.equal(badSince.status, 400);
    const extra = await call('/v1/decisions?directive_id=dir-h3-1&limit=1', { headers: authHeaders('agent-dots') });
    assert.equal(extra.status, 400);
    const removed = await call('/v1/decisions', { method: 'DELETE', headers: authHeaders('agent-dots') });
    assert.equal(removed.status, 405);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM owner_directives').all<{ n: number }>()).results[0]?.n, 2);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM intent_versions').all<{ n: number }>()).results[0]?.n, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM decisions').all<{ n: number }>()).results[0]?.n, 2);
  } finally { await close(); }
});

test('MCP cite prefers USER_STATED over relay over inferred and record follows the same rules', async () => {
  await import('../src/server/decisions.ts');
  const { db, close, call } = await seeded();
  try {
    await applySql(db, readFileSync('migrations/' + SQL_NAME, 'utf8'));
    const rpc = async (token: string, method: string, params: Record<string, unknown>) => {
      const response = await call('/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28',
          'MCP-Method': method,
          ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method, params: {
            ...params,
            _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
          },
        }),
      });
      return { status: response.status, body: await response.json() as {
        error?: { code: string };
        result?: { isError?: boolean; tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[]; structuredContent?: Envelope<unknown> };
      } };
    };
    const tool = (token: string, name: string, args: Record<string, unknown>) => rpc(token, 'tools/call', {
      name, arguments: { schema_version: '1', room: 'room_main', ...args },
    });
    const listed = await rpc('agent-dots', 'tools/list', {});
    assert.equal(listed.status, 200);
    const tools = listed.body.result?.tools ?? [];
    const cite = tools.find(item => item.name === 'workroom_decision_cite');
    const record = tools.find(item => item.name === 'workroom_decision_record');
    assert.equal(cite?.annotations?.readOnlyHint, true);
    assert.equal(record?.annotations?.readOnlyHint, false);

    const inferred = await tool('agent-dots', 'workroom_decision_record', {
      idempotency_key: 'h3-mcp-inferred1', ...recordBody(),
    });
    assert.equal(inferred.body.result?.isError, false, JSON.stringify(inferred.body));
    const inferredRow = inferred.body.result?.structuredContent?.data as DecisionView;
    assert.equal(inferredRow.weight_rank, 1);
    assert.equal(inferredRow.approval, false);

    const relay = await tool('agent-muse', 'workroom_decision_record', {
      idempotency_key: 'h3-mcp-relay-001',
      ...recordBody({ weight: 'relay', provenance: 'msg:room-post-9', statement: 'Heard it in the room. Cite the directive, do not treat this as approval.' }),
    });
    assert.equal(relay.body.result?.isError, false, JSON.stringify(relay.body));
    const relayRow = relay.body.result?.structuredContent?.data as DecisionView;
    assert.equal(relayRow.weight, 'relay');
    assert.equal(relayRow.weight_rank, 2);
    assert.equal(relayRow.owner_text, null);

    const byRelay = await tool('agent-read', 'workroom_decision_cite', { directive_id: 'dir-h3-1' });
    assert.equal(byRelay.status, 200);
    assert.equal(byRelay.body.result?.isError, false, JSON.stringify(byRelay.body));
    const relayCite = byRelay.body.result?.structuredContent as Envelope<{ decision: DecisionView; matched: number }>;
    assert.equal(relayCite.data.decision.id, relayRow.id);
    assert.equal(relayCite.data.decision.weight, 'relay');
    assert.equal(relayCite.data.matched, 2);

    const ownerPhrase = '민성: 결정 번호를 인용하라';
    await db.prepare(`INSERT INTO decisions(
      id, directive_id, intent_version, statement, criteria_json, alternatives_json, best_choice, scored_choice,
      weight, weight_rank, provenance, approval, owner_text, recorded_by, room_id, idempotency_key, request_hash, created_at
    ) VALUES (?, 'dir-h3-1', 1, 'owner stated cite', ?, ?, 'cite', 'cite', 'USER_STATED', 3, 'directive:dir-h3-1', 1, ?, 'user:minsung', 'room_main', 'h3-owner-stated1', 'hash-owner', '2026-10-26T00:00:00.000Z')`).bind(
      'dec_00000000-0000-4000-8000-0000000000aa',
      JSON.stringify(CRITERIA),
      JSON.stringify(ALTERNATIVES.map(row => ({ ...row, weighted_score: row.id === 'cite' ? 1 : 0 }))),
      ownerPhrase,
    ).all();
    const byDirective = await tool('agent-dots', 'workroom_decision_cite', { directive_id: 'dir-h3-1' });
    const winner = byDirective.body.result?.structuredContent as Envelope<{ decision: DecisionView; matched: number }>;
    assert.equal(winner.data.decision.weight, 'USER_STATED');
    assert.equal(winner.data.decision.weight_rank, 3);
    assert.equal(winner.data.decision.approval, true);
    assert.equal(winner.data.decision.owner_text, ownerPhrase);
    assert.equal(winner.data.decision.id, 'dec_00000000-0000-4000-8000-0000000000aa');
    assert.equal(winner.data.matched, 3);
    const byId = await tool('agent-read', 'workroom_decision_cite', { id: inferredRow.id });
    const exact = byId.body.result?.structuredContent as Envelope<{ decision: DecisionView; matched: number }>;
    assert.equal(exact.data.decision.id, inferredRow.id);
    assert.equal(exact.data.decision.weight, 'inferred');
    assert.equal(exact.data.decision.owner_text, null);

    const missing = await tool('agent-dots', 'workroom_decision_cite', { id: 'dec_00000000-0000-4000-8000-0000000000ff' });
    assert.equal(missing.body.result?.isError, true);
    assert.equal(missing.body.result?.structuredContent?.error?.code, 'NOT_FOUND');
    const both = await tool('agent-dots', 'workroom_decision_cite', { id: inferredRow.id, directive_id: 'dir-h3-1' });
    assert.equal(both.body.result?.isError, true);
    const agentStated = await tool('agent-dots', 'workroom_decision_record', {
      idempotency_key: 'h3-mcp-stated-01', ...recordBody({ weight: 'USER_STATED' }),
    });
    assert.equal(agentStated.body.result?.isError, true);
    assert.equal(agentStated.body.result?.structuredContent?.error?.code, 'AGENT_CANNOT_STATE');
    const sneaky = await tool('agent-dots', 'workroom_decision_record', {
      idempotency_key: 'h3-mcp-sneaky-01', ...recordBody({ weight: 'relay', owner_text: ownerPhrase }),
    });
    assert.equal(sneaky.body.result?.isError, true);
    assert.equal(sneaky.body.result?.structuredContent?.error?.code, 'RELAY_NOT_APPROVAL');
    const hidden = (await db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE owner_text=? AND weight!=?').bind(ownerPhrase, 'USER_STATED').all<{ n: number }>()).results[0]?.n;
    assert.equal(hidden, 0);
    const readRecord = await tool('agent-read', 'workroom_decision_record', {
      idempotency_key: 'h3-mcp-reader-01', ...recordBody({ statement: 'reader must not write' }),
    });
    assert.equal(readRecord.status, 403);
    assert.equal(readRecord.body.error?.code, 'FORBIDDEN');
  } finally { await close(); }
});

function decisionCount(db: Database, room?: string) {
  const query = room
    ? db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE room_id=?').bind(room)
    : db.prepare('SELECT COUNT(*) AS n FROM decisions');
  return query.all<{ n: number }>().then(rows => rows.results[0]?.n ?? 0);
}

function revokeBeforeDecisionInsert(db: Database): Database {
  const revoke = () => db.prepare(
    "UPDATE memberships SET can_post=0 WHERE principal_id=? AND room_id=?",
  ).bind('agent:dots', 'room_main').all();
  const arm = (statement: Statement): Statement => ({
    bind(...args) { return arm(statement.bind(...args)); },
    async first<T>() { await revoke(); return statement.first<T>(); },
    async all<T>() { await revoke(); return statement.all<T>(); },
  });
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return /^\s*INSERT\s+INTO\s+decisions\b/i.test(sql) ? arm(statement) : statement;
    },
    batch(statements) { return db.batch(statements); },
  };
}

function prototypeBody(scoreKey: string, score: number) {
  return recordBody({
    criteria: [{ id: 'constructor', label: 'Inherited key', weight: 1 }],
    alternatives: [{ id: 'cite', label: 'Cite a decision', scores: { [scoreKey]: score } }],
    best_choice: 'cite',
  });
}

async function mcpTool(call: (path: string, init?: RequestInit) => Promise<Response>, token: string, name: string, args: Record<string, unknown>) {
  const response = await call('/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'MCP-Method': 'tools/call',
      'Mcp-Name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name, arguments: { schema_version: '1', room: 'room_main', ...args },
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
      },
    }),
  });
  return { status: response.status, body: await response.json() as {
    error?: { code: string };
    result?: { isError?: boolean; structuredContent?: Envelope<unknown> };
  } };
}

test('H3-FIX prototype criterion keys are rejected and a changed idempotent payload conflicts', async () => {
  const { db, close, call, bodyOf } = await seeded();
  try {
    await applySql(db, readFileSync('migrations/' + SQL_NAME, 'utf8'));
    const post = (key: string, payload: Record<string, unknown>) => call('/v1/decisions', {
      method: 'POST', headers: authHeaders('agent-dots', key), body: JSON.stringify(payload),
    });
    const first = await post('h3-proto-http-01', prototypeBody('unrelated', 1));
    assert.equal(first.status, 400, JSON.stringify(await first.clone().json()));
    assert.equal((await bodyOf<unknown>(first)).error?.code, 'INVALID_INPUT');
    const second = await post('h3-proto-http-01', prototypeBody('other', 0));
    assert.equal(second.status, 400, JSON.stringify(await second.clone().json()));
    assert.equal((await bodyOf<unknown>(second)).error?.code, 'INVALID_INPUT');
    assert.equal(await decisionCount(db), 0);

    const recorded = await mcpTool(call, 'agent-dots', 'workroom_decision_record', {
      idempotency_key: 'h3-proto-mcp-001', ...prototypeBody('unrelated', 1),
    });
    assert.equal(recorded.body.result?.isError, true, JSON.stringify(recorded.body));
    assert.equal(recorded.body.result?.structuredContent?.error?.code, 'INVALID_INPUT');
    assert.equal(await decisionCount(db), 0);

    const created = await post('h3-idem-ok-0001', recordBody());
    assert.equal(created.status, 200, JSON.stringify(await created.clone().json()));
    const createdBody = await bodyOf<DecisionView>(created);
    assert.equal(createdBody.meta.replayed, false);
    const replay = await post('h3-idem-ok-0001', recordBody());
    const replayed = await bodyOf<DecisionView>(replay);
    assert.equal(replay.status, 200);
    assert.equal(replayed.meta.replayed, true);
    assert.equal(replayed.data.id, createdBody.data.id);
    const conflict = await post('h3-idem-ok-0001', recordBody({ statement: 'A different statement.' }));
    assert.equal(conflict.status, 409, JSON.stringify(await conflict.clone().json()));
    assert.equal((await bodyOf<unknown>(conflict)).error?.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(await decisionCount(db), 1);
  } finally { await close(); }
});

test('H3-FIX can_post revoked before insert stores no decision', async () => {
  const { db, close, call, bodyOf } = await seeded({ database: revokeBeforeDecisionInsert });
  try {
    await applySql(db, readFileSync('migrations/' + SQL_NAME, 'utf8'));
    const response = await call('/v1/decisions', {
      method: 'POST', headers: authHeaders('agent-dots', 'h3-revoke-post01'),
      body: JSON.stringify(recordBody()),
    });
    const payload = await response.clone().json() as Envelope<DecisionView>;
    const membership = await db.prepare('SELECT can_post FROM memberships WHERE principal_id=? AND room_id=?')
      .bind('agent:dots', 'room_main').first<{ can_post: number }>();
    assert.equal(membership?.can_post, 0, 'revocation must land before the insert executes');
    assert.equal(response.status, 403, JSON.stringify(payload));
    assert.equal((await bodyOf<unknown>(response)).error?.code, 'FORBIDDEN');
    assert.equal(await decisionCount(db), 0);
  } finally { await close(); }
});

test('H3-FIX replay lookup is scoped to the room', async () => {
  const { db, close, call, bodyOf } = await seeded();
  try {
    await applySql(db, readFileSync('migrations/' + SQL_NAME, 'utf8'));
    const payload = JSON.stringify(recordBody());
    const probe = await call('/v1/decisions', {
      method: 'POST', headers: authHeaders('agent-dots', 'h3-hash-probe01'), body: payload,
    });
    assert.equal(probe.status, 200, JSON.stringify(await probe.clone().json()));
    const hash = (await db.prepare('SELECT request_hash FROM decisions WHERE idempotency_key=?')
      .bind('h3-hash-probe01').first<{ request_hash: string }>())?.request_hash;
    assert.ok(hash);
    await db.prepare('DELETE FROM decisions WHERE idempotency_key=?').bind('h3-hash-probe01').all();
    const foreignId = 'dec_00000000-0000-4000-8000-0000000000bb';
    await db.prepare(`INSERT INTO decisions(${COLUMNS.join(',')}) VALUES (${COLUMNS.map(() => '?').join(',')})`).bind(
      foreignId, 'dir-h3-1', 1, 'foreign room decision',
      JSON.stringify(CRITERIA),
      JSON.stringify(ALTERNATIVES.map(row => ({ ...row, weighted_score: row.id === 'cite' ? 1 : 0 }))),
      'ask', 'cite', 'inferred', 1, 'directive:dir-h3-1', 0, null,
      'agent:dots', 'room_other', 'h3-foreign-key01', hash, '2026-10-26T00:00:00.000Z',
    ).all();
    assert.equal(await decisionCount(db, 'room_main'), 0);
    assert.equal(await decisionCount(db, 'room_other'), 1);

    const replay = await call('/v1/decisions', {
      method: 'POST', headers: authHeaders('agent-dots', 'h3-foreign-key01'), body: payload,
    });
    const replayBody = await replay.clone().json() as Envelope<DecisionView>;
    assert.equal(replay.status, 200, JSON.stringify(replayBody));
    assert.equal(replayBody.meta.replayed, false);
    assert.equal(replayBody.data.room_id, 'room_main');
    assert.notEqual(replayBody.data.id, foreignId);
    assert.equal(await decisionCount(db, 'room_main'), 1);
    assert.equal(await decisionCount(db, 'room_other'), 1);

    const listed = await bodyOf<{ decisions: DecisionView[] }>(await call('/v1/decisions', { headers: authHeaders('agent-dots') }));
    assert.deepEqual(listed.data.decisions.map(row => row.id), [replayBody.data.id]);
    const cited = await mcpTool(call, 'agent-dots', 'workroom_decision_cite', { id: foreignId });
    assert.equal(cited.body.result?.isError, true, JSON.stringify(cited.body));
    assert.equal(cited.body.result?.structuredContent?.error?.code, 'NOT_FOUND');
  } finally { await close(); }
});

test('H3-FIX since rejects invalid calendar dates', async () => {
  const { db, close, call, bodyOf } = await seeded();
  try {
    await applySql(db, readFileSync('migrations/' + SQL_NAME, 'utf8'));
    const overflow = await call('/v1/decisions?since=2026-02-30T00:00:00.000Z', { headers: authHeaders('agent-dots') });
    assert.equal(overflow.status, 400, JSON.stringify(await overflow.clone().json()));
    assert.equal((await bodyOf<unknown>(overflow)).error?.code, 'INVALID_INPUT');
    const missingLeap = await call('/v1/decisions?since=2026-02-29T00:00:00.000Z', { headers: authHeaders('agent-dots') });
    assert.equal(missingLeap.status, 400);
    const leap = await call('/v1/decisions?since=2024-02-29T00:00:00.000Z', { headers: authHeaders('agent-dots') });
    assert.equal(leap.status, 200, JSON.stringify(await leap.clone().json()));
    const plain = await call('/v1/decisions?since=2026-02-28T00:00:00.000Z', { headers: authHeaders('agent-dots') });
    assert.equal(plain.status, 200, JSON.stringify(await plain.clone().json()));
  } finally { await close(); }
});

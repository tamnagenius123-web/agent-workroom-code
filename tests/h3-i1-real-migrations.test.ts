import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { createApp } from '../src/server/app.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import { intentOwnerRoutes } from '../src/server/intent.ts';

const ORIGIN = 'https://real-migrations.test';
// Matches the owner hash shape. The write never checks the password when storage is missing.
const OWNER_HASH = 'pbkdf2-sha256$600000$aaaaaaaaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function applySql(db: Database, sql: string) {
  const statements = sql.trim().split(/;\s*\n/).filter(statement => statement.trim()).map(statement => db.prepare(statement));
  return db.batch(statements);
}

// 0045 (owner_directives) is on main since grok/mem-layer; this suite pins the NOT_READY path for a D1 that has not applied it yet.
async function applyMigrations(db: Database, skip: readonly string[] = ['0045']): Promise<void> {
  const names = (await readdir('migrations')).filter(name => /^\d{4}.*\.sql$/.test(name) && !skip.includes(name.slice(0, 4))).sort();
  assert.ok(names.some(name => name.startsWith('0054_')) && names.some(name => name.startsWith('0055_')), '0054 and 0055 must be in migrations/');
  for (const name of names) await applySql(db, await readFile('migrations/' + name, 'utf8'));
}

async function database(): Promise<{ db: Database; close: () => Promise<void> }> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: 'h3-i1-real-' + crypto.randomUUID() },
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const db = await mf.getD1Database('DB') as Database;
  return { db, close: () => mf.dispose() };
}

interface Envelope { ok: boolean; error?: { code: string; message: string } }
interface Rpc {
  error?: { code: string; message?: string };
  result?: { isError?: boolean; structuredContent?: Envelope };
}

const DECISION = {
  schema_version: '1',
  directive_id: 'dir-real-1',
  intent_version: 1,
  statement: 'Cite a stored decision when the directive tables are absent.',
  criteria: [{ id: 'trace', label: 'Traceable', weight: 1 }],
  alternatives: [{ id: 'cite', label: 'Cite', scores: { trace: 1 } }],
  best_choice: 'cite',
  weight: 'inferred',
  provenance: 'directive:dir-real-1',
};

function notReady(label: string, status: number, body: unknown): string | null {
  const envelope = body as Envelope;
  const text = JSON.stringify(body);
  if (status === 503 && envelope.error?.code === 'NOT_READY' && !text.includes('no such table')) return null;
  return `${label} status=${status} code=${envelope.error?.code ?? ''} body=${text}`;
}

test('real migrations minus 0045 (owner_directives) return NOT_READY for decision record and intent writes', async () => {
  const { db, close } = await database();
  try {
    await applyMigrations(db);
    const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>()).results.map(row => row.name);
    assert.equal(tables.includes('owner_directives'), false);
    assert.equal(tables.includes('decisions'), true);
    assert.equal(tables.includes('intent_versions'), true);
    await db.batch([
      db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
      db.prepare("INSERT INTO principals(id, active) VALUES ('agent:dots', 1)"),
      db.prepare("INSERT INTO memberships(principal_id, room_id, active, can_post) VALUES ('agent:dots', 'room_main', 1, 1)"),
    ]);
    const env = { DB: db, OWNER_PASSWORD_HASH: OWNER_HASH };
    const app = createApp(async request => {
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (token === 'agent-dots') return { principal: 'agent:dots', write: true };
      throw new Fault('UNAUTHENTICATED', 'A token is required.', 401);
    }, { ui: false, pre: (request, bound) => intentOwnerRoutes(request, bound as typeof env) });
    const call = (path: string, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, init), env);
    const misses: string[] = [];

    const posted = await call('/v1/decisions', {
      method: 'POST',
      headers: { Authorization: 'Bearer agent-dots', 'Content-Type': 'application/json', 'Idempotency-Key': 'real-mig-http-01' },
      body: JSON.stringify(DECISION),
    });
    const postedBody = await posted.json() as Envelope;
    const httpMiss = notReady('POST /v1/decisions', posted.status, postedBody);
    if (httpMiss) misses.push(httpMiss);

    const recorded = await call('/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer agent-dots',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'MCP-Method': 'tools/call',
        'Mcp-Name': 'workroom_decision_record',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'workroom_decision_record',
          arguments: { room: 'room_main', idempotency_key: 'real-mig-mcp-01', ...DECISION },
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
        },
      }),
    });
    const recordedBody = await recorded.json() as Rpc;
    const tool = recordedBody.result?.structuredContent;
    const toolText = JSON.stringify(recordedBody);
    if (recordedBody.result?.isError !== true || tool?.error?.code !== 'NOT_READY' || toolText.includes('no such table')) {
      misses.push(`workroom_decision_record http=${recorded.status} isError=${String(recordedBody.result?.isError)} code=${tool?.error?.code ?? recordedBody.error?.code ?? ''} body=${toolText}`);
    }

    for (const method of ['POST', 'PUT'] as const) {
      const response = await call('/owner/intent', {
        method,
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': 'real-mig-intent-' + method.toLowerCase() },
        body: JSON.stringify(method === 'PUT'
          ? { north_star: 'North star', intent_md: 'Intent body', parent_version: 1 }
          : { north_star: 'North star', intent_md: 'Intent body' }),
      });
      const body = await response.json() as Envelope;
      const miss = notReady(method + ' /owner/intent', response.status, body);
      if (miss) misses.push(miss);
    }

    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM decisions').all<{ n: number }>()).results[0]?.n, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM intent_versions').all<{ n: number }>()).results[0]?.n, 0);
    assert.equal((await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='owner_directives'").first()), null);
    assert.deepEqual(misses, []);
  } finally { await close(); }
});

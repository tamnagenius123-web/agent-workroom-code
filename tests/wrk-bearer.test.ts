import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness } from '../scripts/local-harness.ts';
import { credentialHash } from '../src/auth/agent-credential.ts';
import { g5Authenticate } from '../src/auth/g5.ts';
import { hmac, sha256 } from '../src/auth/crypto.ts';
import { hashPassword } from '../src/auth/password.ts';
import { provisionClient } from '../src/auth/provision.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database, Statement } from '../src/server/db.ts';

const RESOURCE = 'https://oauth.test/mcp';
const ISSUER = 'https://oauth.test';
const REDIRECT = 'https://client.example/callback';
const PEPPER = 'test-pepper-test-pepper-test-032';
const PASSWORD = 'owner-password-fixture';
const CLIENT_ID = 'client-muse';
const PRINCIPAL = 'agent:muse';
const TOKEN = 'wrk_' + 'a'.repeat(40);
const OTHER = 'wrk_' + 'b'.repeat(40);

type WorkerResponse = { status: number; json(): Promise<unknown> };
type WorkerFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<WorkerResponse>;

function sqlOf(file: string, db: Database) {
  const body = readFileSync(file, 'utf8').split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  return body.split(';').map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement));
}

async function whoami(call: WorkerFetch, token: string, query = '') {
  const response = await call(RESOURCE + query, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'MCP-Method': 'tools/call',
      'Mcp-Name': 'workroom_whoami',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'workroom_whoami', arguments: { schema_version: '1' }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } },
    }),
  });
  return { status: response.status, body: await response.json() as { error?: { code: string }; result?: { isError: boolean; structuredContent: { data: { principal_id: string; can_post: boolean } } } } };
}

test('wrk_ bearer whoami, rejection cases, and an OAuth bearer still work', async () => {
  const ownerHash = await hashPassword(PASSWORD, 10_000, 'legacy');
  const app = await harness({
    production: true,
    bindings: {
      WORKROOM_RESOURCE: RESOURCE,
      WORKROOM_INGRESS_ID: 'workers-dev',
      OWNER_PASSWORD_HASH: ownerHash,
      WORKROOM_TOKEN_PEPPER: PEPPER,
      MCP_COMPAT: '1',
    },
  });
  try {
    await app.db.batch([
      ...sqlOf('tests/fixtures/g5-auth.sql', app.db),
      ...sqlOf('migrations/0079_agent_credentials.sql', app.db),
    ]);
    const now = Date.now();
    const provisioned = await provisionClient(PEPPER, {
      client_id: CLIENT_ID,
      principal_id: 'agent:oauth',
      agent_id: 'oauth',
      redirect_uris: [REDIRECT],
      scopes: ['workroom.read', 'workroom.write', 'offline_access'],
      resource: RESOURCE,
      ingress_id: 'workers-dev',
      can_post: true,
      binding_expires_at_ms: now + 86_400_000,
    }, now);
    await app.db.batch(provisioned.statements.map(statement => app.db.prepare(statement.sql).bind(...statement.params)));
    const verifier = 'b'.repeat(48);
    const challenge = await sha256(verifier);
    const authorize = new URL(ISSUER + '/oauth/authorize');
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', CLIENT_ID);
    authorize.searchParams.set('redirect_uri', REDIRECT);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('state', 'state-oauth-1');
    authorize.searchParams.set('resource', RESOURCE);
    const page = await app.mf.dispatchFetch(authorize.href);
    assert.equal(page.status, 200);
    const consent = /name="consent" value="([^"]+)"/.exec(await page.text())?.[1];
    assert.ok(consent);
    const approved = await app.mf.dispatchFetch(ISSUER + '/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ISSUER },
      body: new URLSearchParams({ consent, password: PASSWORD, decision: 'approve' }),
    });
    const next = /url=([^"]+)/.exec(await approved.text())?.[1];
    assert.ok(next);
    const code = new URL(next.replaceAll('&amp;', '&')).searchParams.get('code');
    assert.ok(code);
    const traded = await app.mf.dispatchFetch(ISSUER + '/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier,
        client_id: CLIENT_ID, client_secret: provisioned.secret, resource: RESOURCE,
      }),
    });
    assert.equal(traded.status, 200);
    const oauth = await traded.json() as { access_token: string };
    const call: WorkerFetch = (url, init) => app.mf.dispatchFetch(url, init);
    const oauthWho = await whoami(call, oauth.access_token);
    assert.equal(oauthWho.status, 200);
    assert.equal(oauthWho.body.result?.structuredContent.data.principal_id, 'agent:oauth');

    await app.db.prepare('INSERT OR IGNORE INTO principals(id) VALUES (?)').bind(PRINCIPAL).all();
    await app.db.prepare('INSERT OR IGNORE INTO memberships(principal_id,room_id,can_post) VALUES (?,?,1)').bind(PRINCIPAL, 'room_main').all();
    await app.db.prepare('INSERT OR IGNORE INTO principal_roles(principal_id,kind) VALUES (?,?)').bind(PRINCIPAL, 'agent').all();
    const hash = await credentialHash(TOKEN);
    assert.equal(hash.startsWith('sha256:'), true);
    assert.equal(hash.includes('='), false);
    await app.db.prepare(
      `INSERT INTO agent_credentials
        (key_id, principal_id, key_hash, scopes_json, minted_by, created_at, expires_at, revoked_at, credential_version)
       VALUES ('wrk_id_fixture', ?, ?, '["workroom.read"]', 'user:minsung', ?, ?, NULL, 1)`,
    ).bind(PRINCIPAL, hash, now, now + 86_400_000).all();

    const ok = await whoami(call, TOKEN);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.result?.isError, false);
    assert.equal(ok.body.result?.structuredContent.data.principal_id, PRINCIPAL);
    assert.equal(ok.body.result?.structuredContent.data.can_post, true);

    await app.db.prepare('UPDATE agent_credentials SET revoked_at=? WHERE key_id=?').bind(now, 'wrk_id_fixture').all();
    const revoked = await whoami(call, TOKEN);
    assert.equal(revoked.status, 401);
    assert.equal(revoked.body.error?.code, 'UNAUTHENTICATED');

    await app.db.prepare('UPDATE agent_credentials SET revoked_at=NULL, created_at=?, expires_at=? WHERE key_id=?').bind(now - 5_000, now - 1_000, 'wrk_id_fixture').all();
    const expired = await whoami(call, TOKEN);
    assert.equal(expired.status, 401);
    assert.equal(expired.body.error?.code, 'UNAUTHENTICATED');

    await app.db.prepare('UPDATE agent_credentials SET expires_at=? WHERE key_id=?').bind(now + 86_400_000, 'wrk_id_fixture').all();
    const wrong = await whoami(call, OTHER);
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error?.code, 'UNAUTHENTICATED');
    const still = await app.db.prepare('SELECT key_hash FROM agent_credentials WHERE key_id=?').bind('wrk_id_fixture').first<{ key_hash: string }>();
    assert.equal(still?.key_hash, hash);
    assert.notEqual(await credentialHash(OTHER), hash);

    const queried = await whoami(call, TOKEN, '?access_token=' + TOKEN);
    assert.equal(queried.status, 401);
    assert.equal(queried.body.error?.code, 'UNAUTHENTICATED');

    await app.db.prepare('DROP TABLE agent_credentials').all();
    const absent = await whoami(call, TOKEN);
    assert.equal(absent.status, 401);
    assert.equal(absent.body.error?.code, 'UNAUTHENTICATED');

    const oauthAgain = await whoami(call, oauth.access_token);
    assert.equal(oauthAgain.status, 200);
    assert.equal(oauthAgain.body.result?.structuredContent.data.principal_id, 'agent:oauth');
    const stored = await app.db.prepare('SELECT token_hash FROM oauth_tokens WHERE token_hash=?').bind(await hmac(PEPPER, 'token:' + oauth.access_token)).first();
    assert.ok(stored);
  } finally {
    await app.close();
  }
});

test('a wrk_ bearer does not query oauth_tokens', async () => {
  const seen: string[] = [];
  const missing = new Error('no such table: agent_credentials');
  const db = {
    prepare(sql: string): Statement {
      seen.push(sql);
      return {
        bind() { return this; },
        async first() { throw missing; },
        async all() { throw missing; },
      };
    },
    async batch() { return []; },
  } as Database;
  const request = new Request(RESOURCE, { headers: { Authorization: 'Bearer ' + TOKEN } });
  const ownerHash = await hashPassword(PASSWORD, 10_000, 'legacy');
  await assert.rejects(
    () => g5Authenticate(request, {
      DB: db,
      WORKROOM_RESOURCE: RESOURCE,
      WORKROOM_INGRESS_ID: 'workers-dev',
      OWNER_PASSWORD_HASH: ownerHash,
      WORKROOM_TOKEN_PEPPER: PEPPER,
    }),
    (error: unknown) => error instanceof Fault && error.status === 401,
  );
  assert.equal(seen.some(sql => sql.includes('oauth_tokens')), false);
  assert.equal(seen.some(sql => sql.includes('agent_credentials')), true);
});

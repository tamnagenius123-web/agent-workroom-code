import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harness } from '../scripts/local-harness.ts';
import { hmac, sha256 } from '../src/auth/crypto.ts';
import { hashPassword } from '../src/auth/password.ts';
import { provisionClient } from '../src/auth/provision.ts';
import type { Database } from '../src/server/db.ts';

const RESOURCE = 'https://oauth.test/mcp';
const ISSUER = 'https://oauth.test';
const REDIRECT = 'https://client.example/callback';
const PEPPER = 'test-pepper-test-pepper-test-032';
const PASSWORD = 'owner-password-fixture';
const CLIENT_ID = 'client-muse';

async function applyFixture(db: Database) {
  const sql = await readFile(new URL('./fixtures/g5-auth.sql', import.meta.url), 'utf8');
  const statements = sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').split(';').map(statement => statement.trim()).filter(Boolean);
  await db.batch(statements.map(statement => db.prepare(statement)));
}

type WorkerResponse = { status: number; text(): Promise<string>; json(): Promise<unknown> };
type WorkerFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | URLSearchParams }) => Promise<WorkerResponse>;

async function mcp(fetch: WorkerFetch, access: string, id: number) {
  const response = await fetch(RESOURCE, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + access,
      'content-type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'MCP-Method': 'tools/call',
      'Mcp-Name': 'workroom_whoami',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'workroom_whoami', arguments: { schema_version: '1' }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } },
    }),
  });
  return { status: response.status, body: await response.json() };
}

async function tokenRequest(fetch: WorkerFetch, body: URLSearchParams) {
  return fetch(ISSUER + '/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

test('authorize, token, and /mcp whoami use the live OAuth handlers', async () => {
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
    await applyFixture(app.db);
    const now = Date.now();
    const provisioned = await provisionClient(PEPPER, {
      client_id: CLIENT_ID,
      principal_id: 'agent:muse',
      agent_id: 'muse',
      redirect_uris: [REDIRECT],
      scopes: ['workroom.read', 'workroom.write', 'offline_access'],
      resource: RESOURCE,
      ingress_id: 'workers-dev',
      can_post: true,
      credential_version: 1,
      binding_expires_at_ms: now + 86_400_000,
    }, now);
    await app.db.batch(provisioned.statements.map(statement => app.db.prepare(statement.sql).bind(...statement.params)));
    const storedSecret = await app.db.prepare('SELECT secret_hash FROM oauth_clients WHERE client_id=?').bind(CLIENT_ID).first<{ secret_hash: string }>();
    assert.equal(storedSecret?.secret_hash, await hmac(PEPPER, 'client:' + provisioned.secret));

    const verifier = 'a'.repeat(48);
    const challenge = await sha256(verifier);
    const authorize = new URL(ISSUER + '/oauth/authorize');
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', CLIENT_ID);
    authorize.searchParams.set('redirect_uri', REDIRECT);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('state', 'state-oauth-1');
    authorize.searchParams.set('scope', 'workroom.read workroom.write offline_access');
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
    assert.equal(approved.status, 200);
    const next = /url=([^"]+)/.exec(await approved.text())?.[1];
    assert.ok(next);
    const code = new URL(next.replaceAll('&amp;', '&')).searchParams.get('code');
    assert.ok(code);

    const call: WorkerFetch = (url, init) => app.mf.dispatchFetch(url, init);
    const traded = await tokenRequest(call, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      client_secret: provisioned.secret,
      resource: RESOURCE,
    }));
    assert.equal(traded.status, 200);
    const tokens = await traded.json() as { access_token: string; token_type: string };
    assert.equal(tokens.token_type, 'Bearer');
    const accessHash = await hmac(PEPPER, 'token:' + tokens.access_token);
    const accessRow = await app.db.prepare('SELECT credential_version FROM oauth_tokens WHERE token_hash=? AND kind=?').bind(accessHash, 'access').first<{ credential_version: number }>();
    assert.equal(accessRow?.credential_version, 1);

    const who = await mcp(call, tokens.access_token, 1);
    assert.equal(who.status, 200);
    const whoBody = who.body as { result: { isError: boolean; structuredContent: { data: { principal_id: string } } } };
    assert.equal(whoBody.result.isError, false);
    assert.equal(whoBody.result.structuredContent.data.principal_id, 'agent:muse');

    const wrong = await tokenRequest(call, new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'not-a-code',
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      client_secret: 'wrc_wrong',
    }));
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json() as { error: string }).error, 'invalid_client');

    const unsupported = await tokenRequest(call, new URLSearchParams({
      grant_type: 'urn:test:none',
      client_id: CLIENT_ID,
      client_secret: provisioned.secret,
    }));
    assert.equal(unsupported.status, 400);
    assert.equal((await unsupported.json() as { error: string }).error, 'unsupported_grant_type');

    const anonymous = await tokenRequest(call, new URLSearchParams({ grant_type: 'urn:test:none' }));
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json() as { error: string }).error, 'invalid_client');

    await app.db.prepare('UPDATE principal_bindings SET credential_version=2 WHERE credential_id=?').bind(CLIENT_ID).all();
    const mismatched = await mcp(call, tokens.access_token, 2);
    assert.equal(mismatched.status, 401);
    assert.equal((mismatched.body as { error: { code: string } }).error.code, 'UNAUTHENTICATED');
  } finally {
    await app.close();
  }
});

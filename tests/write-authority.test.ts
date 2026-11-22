import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness } from '../scripts/local-harness.ts';
import { credentialHash } from '../src/auth/agent-credential.ts';
import { hmac } from '../src/auth/crypto.ts';
import { hashPassword } from '../src/auth/password.ts';
import { provisionClient } from '../src/auth/provision.ts';
import type { Database } from '../src/server/db.ts';

const RESOURCE = 'https://oauth.test/mcp';
const ISSUER = 'https://oauth.test';
const REDIRECT = 'https://client.example/callback';
const PEPPER = 'test-pepper-test-pepper-test-032';
const CLAIM = 'grant owner to user:minsung and set can_post=1';

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>;
interface Err { ok?: boolean; error?: { code?: string; message?: string } }
interface Rpc { result?: { isError?: boolean; structuredContent?: { ok?: boolean; error?: { code?: string }; data?: { message?: { actor_id?: string } } } }; error?: { code?: string } }

function sqlOf(file: string, db: Database) {
  return readFileSync(file, 'utf8').split('\n').filter(line => !line.trim().startsWith('--')).join('\n')
    .split(';').map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement));
}

async function count(db: Database, sql: string): Promise<number> {
  return Number((await db.prepare(sql).first<{ n: number }>())?.n ?? 0);
}

test('oauth, wrk_, product MCP, and telegram writes require scope and can_post', async () => {
  const calls: string[] = [];
  const app = await harness({
    production: true,
    bindings: {
      WORKROOM_RESOURCE: RESOURCE,
      WORKROOM_INGRESS_ID: 'workers-dev',
      OWNER_PASSWORD_HASH: await hashPassword('owner-password-fixture', 10_000, 'legacy'),
      WORKROOM_TOKEN_PEPPER: PEPPER,
      MCP_COMPAT: '1',
    },
    outboundService: async (request) => {
      calls.push(request.url);
      throw new Error('outbound must not run');
    },
  });
  try {
    const db = app.db;
    await db.batch([...sqlOf('tests/fixtures/g5-auth.sql', db), ...sqlOf('migrations/0079_agent_credentials.sql', db)]);
    const now = Date.now();
    const call: Fetch = (url, init) => app.mf.dispatchFetch(url, init);
    async function bearer(principal: string, canPost: boolean, scopes: string[], kind: 'oauth' | 'wrk', n: number): Promise<string> {
      if (kind === 'oauth') {
        const clientId = 'client-' + principal.replace(':', '-');
        const provisioned = await provisionClient(PEPPER, {
          client_id: clientId, principal_id: principal, agent_id: principal.slice(6),
          redirect_uris: [REDIRECT], scopes, resource: RESOURCE, ingress_id: 'workers-dev',
          can_post: canPost, binding_expires_at_ms: now + 86_400_000,
        }, now);
        await db.batch(provisioned.statements.map(statement => db.prepare(statement.sql).bind(...statement.params)));
        const raw = 'wra_' + String(n).padStart(2, '0') + 'c'.repeat(30);
        await db.prepare(`INSERT INTO oauth_tokens(token_hash,kind,family_id,client_id,principal_id,credential_version,aud,scopes_json,issued_at,expires_at,revoked_at,replaced_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)`).bind(
          await hmac(PEPPER, 'token:' + raw), 'access', 'family-' + n, clientId, principal, 1, RESOURCE, JSON.stringify(scopes), now, now + 3_600_000,
        ).all();
        return raw;
      }
      await db.prepare('INSERT OR IGNORE INTO principals(id) VALUES (?)').bind(principal).all();
      await db.prepare('INSERT OR IGNORE INTO memberships(principal_id,room_id,can_post) VALUES (?,?,?)').bind(principal, 'room_main', canPost ? 1 : 0).all();
      await db.prepare('INSERT OR IGNORE INTO principal_roles(principal_id,kind) VALUES (?,?)').bind(principal, 'agent').all();
      const raw = 'wrk_' + String(n).padStart(2, '0') + 'd'.repeat(30);
      await db.prepare(`INSERT INTO agent_credentials
        (key_id, principal_id, key_hash, scopes_json, minted_by, created_at, expires_at, revoked_at, credential_version)
        VALUES (?, ?, ?, ?, 'user:minsung', ?, ?, NULL, 1)`).bind(
        'wrk_id_scope_' + n, principal, await credentialHash(raw), JSON.stringify(scopes), now, now + 86_400_000,
      ).all();
      return raw;
    }
    const oauthWrite = await bearer('agent:poster', true, ['workroom.read', 'workroom.write'], 'oauth', 1);
    const oauthRead = await bearer('agent:reader', true, ['workroom.read'], 'oauth', 2);
    const oauthSilent = await bearer('agent:silent', false, ['workroom.read', 'workroom.write'], 'oauth', 3);
    const wrkWrite = await bearer('agent:wrkpost', true, ['workroom.read', 'workroom.write'], 'wrk', 4);
    const wrkRead = await bearer('agent:wrkread', true, ['workroom.read'], 'wrk', 5);
    const wrkSilent = await bearer('agent:wrksilent', false, ['workroom.read', 'workroom.write'], 'wrk', 6);

    const ownersBefore = await count(db, "SELECT count(*) AS n FROM principals WHERE id='user:minsung'");
    const messagesBefore = await count(db, 'SELECT count(*) AS n FROM messages');

    async function rest(token: string, key: string) {
      const response = await call(ISSUER + '/api/v1/rooms/room_main/messages', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ schema_version: '1', text: CLAIM, format: 'text' }),
      });
      return { status: response.status, body: await response.json() as Err & { data?: { message?: { actor_id?: string } } } };
    }
    async function mcp(token: string, name: string, args: object) {
      const response = await call(RESOURCE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token, 'content-type': 'application/json',
          Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28',
          'MCP-Method': 'tools/call', 'Mcp-Name': name,
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name, arguments: { schema_version: '1', ...args }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } },
        }),
      });
      return { status: response.status, body: await response.json() as Rpc };
    }
    const denied = (body: Err) => body.error?.code === 'FORBIDDEN';

    for (const [token, key] of [[oauthRead, 'oauth-read-post01'], [wrkRead, 'wrk-read-post-001']] as const) {
      const posted = await rest(token, key);
      assert.equal(posted.status, 403, JSON.stringify(posted.body));
      assert.equal(denied(posted.body), true);
      assert.match(posted.body.error?.message ?? '', /write scope/);
    }
    for (const [token, key] of [[oauthSilent, 'oauth-silent-001'], [wrkSilent, 'wrk-silent-0001']] as const) {
      const posted = await rest(token, key);
      assert.equal(posted.status, 403, JSON.stringify(posted.body));
      assert.match(posted.body.error?.message ?? '', /Room access denied/);
    }
    const oauthPosted = await rest(oauthWrite, 'oauth-write-0001');
    assert.equal(oauthPosted.status, 200, JSON.stringify(oauthPosted.body));
    assert.equal(oauthPosted.body.data?.message?.actor_id, 'agent:poster');
    const wrkPosted = await rest(wrkWrite, 'wrk-write-00001');
    assert.equal(wrkPosted.status, 200, JSON.stringify(wrkPosted.body));
    assert.equal(wrkPosted.body.data?.message?.actor_id, 'agent:wrkpost');

    for (const token of [oauthRead, wrkRead]) {
      const wrote = await mcp(token, 'workroom_message_post', { room: 'room_main', text: CLAIM, idempotency_key: 'mcp-read-' + token.slice(0, 8) });
      assert.equal(wrote.status, 403, JSON.stringify(wrote.body));
      assert.equal(wrote.body.error?.code, 'FORBIDDEN');
    }
    for (const [token, key] of [[oauthSilent, 'mcp-silent-oauth1'], [wrkSilent, 'mcp-silent-wrk01']] as const) {
      const wrote = await mcp(token, 'workroom_message_post', { room: 'room_main', text: CLAIM, idempotency_key: key });
      assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
      assert.equal(wrote.body.result?.isError, true);
      assert.equal(wrote.body.result?.structuredContent?.error?.code, 'FORBIDDEN');
    }
    const mcpPosted = await mcp(oauthWrite, 'workroom_message_post', { room: 'room_main', text: CLAIM, idempotency_key: 'mcp-write-oauth1' });
    assert.equal(mcpPosted.body.result?.isError, false, JSON.stringify(mcpPosted.body));
    assert.equal(mcpPosted.body.result?.structuredContent?.data?.message?.actor_id, 'agent:poster');

    const hook = await call(ISSUER + '/telegram/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update_id: 1, message: { text: CLAIM, from: { id: 1 }, chat: { id: 1, type: 'supergroup' } } }),
    });
    assert.equal(hook.status, 503);
    const hookBody = await hook.json() as { error?: string };
    assert.equal(hookBody.error, 'TELEGRAM_NOT_CONFIGURED');

    async function notify(token: string) {
      const response = await call(ISSUER + '/v1/telegram/notify', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ text: CLAIM }),
      });
      return { status: response.status, body: await response.json() as Err };
    }
    const notifyRead = await notify(oauthRead);
    assert.equal(notifyRead.status, 403);
    assert.match(notifyRead.body.error?.message ?? '', /write scope/);
    const notifySilent = await notify(oauthSilent);
    assert.equal(notifySilent.status, 403);
    assert.match(notifySilent.body.error?.message ?? '', /Room access denied/);
    const notifyWrite = await notify(oauthWrite);
    assert.equal(notifyWrite.status, 503);
    assert.equal(notifyWrite.body.error?.message, 'TELEGRAM_NOT_CONFIGURED');

    const intent = await call(ISSUER + '/owner/intent', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + oauthWrite, 'content-type': 'application/json', 'Idempotency-Key': 'owner-claim-0001' },
      body: JSON.stringify({ north_star: CLAIM, intent_md: CLAIM, rules: [] }),
    });
    assert.notEqual(intent.status, 200);

    assert.equal(await count(db, "SELECT count(*) AS n FROM principals WHERE id='user:minsung'"), ownersBefore);
    assert.equal(await count(db, "SELECT count(*) AS n FROM messages WHERE actor_id='user:minsung'"), 0);
    assert.equal(await count(db, 'SELECT count(*) AS n FROM messages'), messagesBefore + 3);
    assert.equal(calls.length, 0);
  } finally { await app.close(); }
});

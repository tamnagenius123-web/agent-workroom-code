import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness } from '../scripts/local-harness.ts';
import { credentialHash, recordAgentCredentialUse, LAST_USED_WRITE_WINDOW_MS } from '../src/auth/agent-credential.ts';
import { hashPassword } from '../src/auth/password.ts';
import type { Database } from '../src/server/db.ts';

const RESOURCE = 'https://oauth.test/mcp';
const PEPPER = 'test-pepper-test-pepper-test-032';
const PASSWORD = 'owner-password-fixture';
const PRINCIPAL = 'agent:muse';
const TOKEN = 'wrk_' + 'c'.repeat(40);
const KEY_ID = 'wrk_id_usage_fixture';

function sqlOf(file: string, db: Database) {
  const body = readFileSync(file, 'utf8').split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  return body.split(';').map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement));
}

async function boot(withUsageMigration: boolean) {
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
  const files = ['tests/fixtures/g5-auth.sql', 'migrations/0079_agent_credentials.sql'];
  if (withUsageMigration) files.push('migrations/0083_agent_credential_usage.sql');
  await app.db.batch(files.flatMap(file => sqlOf(file, app.db)));
  const now = Date.now();
  await app.db.prepare('INSERT OR IGNORE INTO principals(id) VALUES (?)').bind(PRINCIPAL).all();
  await app.db.prepare('INSERT OR IGNORE INTO memberships(principal_id,room_id,can_post) VALUES (?,?,1)').bind(PRINCIPAL, 'room_main').all();
  await app.db.prepare('INSERT OR IGNORE INTO principal_roles(principal_id,kind) VALUES (?,?)').bind(PRINCIPAL, 'agent').all();
  await app.db.prepare(
    `INSERT INTO agent_credentials
      (key_id, principal_id, key_hash, scopes_json, minted_by, created_at, expires_at, revoked_at, credential_version)
     VALUES (?, ?, ?, '["workroom.read"]', 'user:minsung', ?, ?, NULL, 1)`,
  ).bind(KEY_ID, PRINCIPAL, await credentialHash(TOKEN), now, now + 86_400_000).all();
  return app;
}

async function lastUsed(app: Awaited<ReturnType<typeof boot>>): Promise<number | null> {
  const row = await app.db.prepare('SELECT last_used_at FROM agent_credentials WHERE key_id=?').bind(KEY_ID).first<{ last_used_at: number | null }>();
  return row?.last_used_at ?? null;
}

test('recordAgentCredentialUse stamps last_used_at, throttled by the write window', async () => {
  const app = await boot(true);
  try {
    const t0 = 1_700_000_000_000;
    assert.equal(await lastUsed(app), null);
    assert.equal(await recordAgentCredentialUse(app.db, KEY_ID, t0), true);
    assert.equal(await lastUsed(app), t0);
    // Inside the window: the UPDATE still succeeds but must not move the stamp.
    assert.equal(await recordAgentCredentialUse(app.db, KEY_ID, t0 + 60_000), true);
    assert.equal(await lastUsed(app), t0);
    // Past the window: the stamp advances.
    const t1 = t0 + LAST_USED_WRITE_WINDOW_MS + 1;
    assert.equal(await recordAgentCredentialUse(app.db, KEY_ID, t1), true);
    assert.equal(await lastUsed(app), t1);
    // Unknown key_id: no row, no throw.
    assert.equal(await recordAgentCredentialUse(app.db, 'wrk_id_absent', t1 + LAST_USED_WRITE_WINDOW_MS + 1), true);
    assert.equal(await lastUsed(app), t1);
  } finally {
    await app.close();
  }
});

test('recordAgentCredentialUse is fail-soft before migration 0083 lands', async () => {
  const app = await boot(false);
  try {
    // No last_used_at column: the signal is skipped, never an exception.
    assert.equal(await recordAgentCredentialUse(app.db, KEY_ID, Date.now()), false);
  } finally {
    await app.close();
  }
});

test('a successful wrk_ request leaves a last_used stamp and an audit row; a rejected one leaves neither', async () => {
  const app = await boot(true);
  try {
    const call = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => app.mf.dispatchFetch(url, init);
    const whoami = async (token: string) => {
      const response = await call(RESOURCE, {
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
      return response.status;
    };
    const auditRows = async () => {
      const rows = await app.db.prepare(
        `SELECT principal_id, client_id, decision, reason FROM auth_audit WHERE action='resource:agent_credential'`,
      ).all<{ principal_id: string; client_id: string; decision: string; reason: string }>();
      return rows.results;
    };

    assert.equal(await lastUsed(app), null);
    assert.equal(await whoami(TOKEN), 200);
    const stamped = await lastUsed(app);
    assert.ok(stamped !== null && stamped > 0 && stamped <= Date.now());
    const rows = await auditRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.principal_id, PRINCIPAL);
    // The audit row names the credential by its non-secret key_id only.
    assert.equal(rows[0]?.client_id, KEY_ID);
    assert.equal(rows[0]?.decision, 'allow');

    await app.db.prepare('UPDATE agent_credentials SET revoked_at=? WHERE key_id=?').bind(Date.now(), KEY_ID).all();
    assert.equal(await whoami(TOKEN), 401);
    assert.equal(await lastUsed(app), stamped);
    assert.equal((await auditRows()).length, 1);
  } finally {
    await app.close();
  }
});

test('a failing auth_audit write does not fail wrk_ authentication, and the failure is signalled', async () => {
  const app = await boot(true);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  // The worker runs under Miniflare: its console.warn is forwarded to this
  // process's stdout/stderr, bypassing the console object, so capture both.
  const captured: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const capture = (write: (chunk: string) => boolean) => (chunk: unknown, ...rest: unknown[]) => {
    captured.push(String(chunk));
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  };
  process.stdout.write = capture(originalStdoutWrite) as typeof process.stdout.write;
  process.stderr.write = capture(originalStderrWrite) as typeof process.stderr.write;
  try {
    // Break only the audit sink: the INSERT INTO auth_audit now throws on
    // every call. The credential itself is untouched and still valid.
    await app.db.prepare('DROP TABLE auth_audit').all();
    const response = await app.mf.dispatchFetch(RESOURCE, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + TOKEN,
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
    // Fail-soft: authentication succeeds even though the audit row could
    // not be written, and the last_used stamp (the other signal) still lands.
    assert.equal(response.status, 200);
    const stamped = await lastUsed(app);
    assert.ok(stamped !== null && stamped > 0);
    // The failure must not disappear silently: the worker logs the
    // structured wrk_auth_audit_failed signal (error class only). The
    // forwarded log line can land just after the response, so poll briefly.
    const signalled = async () => warnings.some(line => line.includes('wrk_auth_audit_failed'))
      || captured.some(line => line.includes('wrk_auth_audit_failed'));
    for (let i = 0; i < 20 && !(await signalled()); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(await signalled(), `expected a wrk_auth_audit_failed signal, got console=${JSON.stringify(warnings)} captured=${JSON.stringify(captured.slice(-5))}`);
  } finally {
    console.warn = originalWarn;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    await app.close();
  }
});

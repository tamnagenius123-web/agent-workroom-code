import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORIGIN, RESOURCE, PASSWORD, PEPPER, b64, mf, start, fullEnv, go, authzQuery, page, submit, consent, tokens, me, mcp, resetOutbound, outboundCount, getSecrets } from './support/g5-harness.ts';
// Split from g5.test.ts (part 1/8); each test boots its own Miniflare + unique D1, so parts run in parallel.

test('G5 unconfigured or partially configured production stays closed with 503 AUTH_NOT_CONFIGURED', async () => {
  for (const b of [null, { ...fullEnv(), WORKROOM_TOKEN_PEPPER: '' }, { ...fullEnv(), OWNER_PASSWORD_HASH: 'plaintext' }, { ...fullEnv(), WORKROOM_RESOURCE: 'http://x.example/mcp' }]) {
    await start(b);
    for (const [path, init] of [['/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }], ['/api/v1/me', {}], ['/.well-known/oauth-authorization-server', {}], ['/oauth/token', { method: 'POST' }], ['/', {}]] as const) {
      const r = await go(path, init as RequestInit);
      assert.equal(r.status, 503, path);
      assert.equal((await r.json() as { error: { code: string } }).error.code, 'AUTH_NOT_CONFIGURED');
    }
  }
});

test('G5 discovery metadata and 401 challenge', async () => {
  await start(fullEnv());
  const pr = await (await go('/.well-known/oauth-protected-resource')).json() as Record<string, unknown>;
  assert.equal(pr.resource, RESOURCE); assert.deepEqual(pr.authorization_servers, [ORIGIN]);
  const as = await (await go('/.well-known/oauth-authorization-server')).json() as Record<string, unknown>;
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']); assert.equal(as.token_endpoint, ORIGIN + '/oauth/token');
  assert.ok((as.scopes_supported as string[]).includes('offline_access'));
  const r = await go('/api/v1/me');
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
  assert.equal((await go('/')).status, 401, 'UI not served in production');
  const db = await mf!.getD1Database('DB');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM auth_audit').first<{ n: number }>())!.n, 0, 'anonymous requests write no audit rows');
  assert.equal((await go('/api/v1/me', { headers: { Authorization: 'Bearer garbage-token-value-000000' } })).status, 401);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM auth_audit WHERE decision='deny'").first<{ n: number }>())!.n, 1, 'bad bearer is audited');
});

test('G5 dots and muse each complete OAuth+PKCE and act only as their own principal; cross-agent readback', async () => {
  const db = await start(fullEnv());
  const dots = await tokens('client:dots'), muse = await tokens('client:muse');
  assert.equal(dots.expires_in, 3600); assert.ok(dots.refresh_token);
  const d = await (await me(dots.access_token, { 'X-Workroom-Principal': 'agent:muse', 'oai-authenticated-user-id': 'spoof' })).json() as { data: { principal_id: string; synthetic: boolean } };
  assert.equal(d.data.principal_id, 'agent:dots'); assert.equal(d.data.synthetic, false);
  assert.equal(((await (await me(muse.access_token)).json()) as { data: { principal_id: string } }).data.principal_id, 'agent:muse');
  const posted = await go('/api/v1/rooms/room_main/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + dots.access_token, 'Content-Type': 'application/json', 'Idempotency-Key': 'g5-dots-post-0001' }, body: JSON.stringify({ schema_version: '1', text: 'hello from dots' }) });
  assert.equal(posted.status, 200);
  const read = await (await go('/api/v1/rooms/room_main/messages?limit=10', { headers: { Authorization: 'Bearer ' + muse.access_token } })).json() as { data: { messages: { text: string; author_id?: string; principal_id?: string }[] } };
  assert.ok(JSON.stringify(read).includes('hello from dots'));
  const who = await mcp(muse.access_token, 'tools/call', { name: 'workroom_whoami', arguments: { schema_version: '1' } });
  assert.equal(who.status, 200); assert.equal(who.body.result!.structuredContent!.data.principal_id, 'agent:muse');
  const list = await mcp(dots.access_token, 'tools/list');
  assert.equal(list.body.result!.tools!.length, 76);
  assert.ok(list.body.result!.tools!.some((t) => (t as { name: string }).name === 'workroom_usage_read'), 'workroom_usage_read registered');
  const audit = JSON.stringify((await db.prepare('SELECT * FROM auth_audit').all()).results);
  for (const s of [dots.access_token, dots.refresh_token!, muse.access_token, getSecrets()['client:dots']!, PEPPER]) assert.ok(!audit.includes(s));
  assert.ok(audit.includes('"approved_by"') === false);
  const codes = JSON.stringify((await db.prepare('SELECT approved_by FROM oauth_codes').all()).results);
  assert.ok(codes.includes('owner-password'));
  const stored = JSON.stringify((await db.prepare('SELECT * FROM oauth_tokens').all()).results);
  assert.ok(!stored.includes(dots.access_token) && !stored.includes(dots.refresh_token!), 'only hashes stored');
});

test('G5 authorize negatives: client, redirect, PKCE, resource, scope, deny, tampering', async () => {
  await start(fullEnv());
  assert.equal((await go('/oauth/authorize?' + await authzQuery({ client_id: 'client:unknown' }))).status, 400);
  const badRedirect = await go('/oauth/authorize?' + await authzQuery({ redirect_uri: 'https://evil.example/cb' }));
  assert.equal(badRedirect.status, 400); assert.equal(badRedirect.headers.get('location'), null);
  const cases: [Record<string, string>, string][] = [[{ code_challenge_method: 'plain' }, 'invalid_request'], [{ code_challenge: '' }, 'invalid_request'], [{ resource: 'https://other.example/mcp' }, 'invalid_target'], [{ scope: 'workroom.read workroom.admin' }, 'invalid_scope'], [{ response_type: 'token' }, 'unsupported_response_type']];
  for (const [over, error] of cases) {
    const r = await go('/oauth/authorize?' + await authzQuery(over));
    assert.equal(r.status, 302); assert.equal(new URL(r.headers.get('location')!).searchParams.get('error'), error);
  }
  const denied = await consent(await authzQuery(), 'deny', '');
  assert.equal(new URL(denied.headers.get('location')!).searchParams.get('error'), 'access_denied');
  const p = await page(await authzQuery());
  assert.ok(p.text.includes('type="password"'));
  assert.equal((await submit({ ...p, consent: b64('{"client_id":"client:dots"}') + '.sig' }, 'approve', PASSWORD)).status, 400, 'tampered form');
});

test('G5 owner password gate: wrong password, D1 lockout, no Access dependence', async () => {
  const db = await start(fullEnv());
  resetOutbound();
  const wrong = await consent(await authzQuery(), 'approve', 'not-the-password');
  assert.equal(wrong.status, 401); assert.equal(wrong.headers.get('location'), null);
  assert.ok((await wrong.text()).includes('Wrong password'));
  assert.equal((await consent(await authzQuery(), 'approve', '')).status, 401, 'empty password');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM oauth_codes').first<{ n: number }>())!.n, 0);
  for (let i = 0; i < 3; i++) assert.equal((await consent(await authzQuery(), 'approve', 'wrong-' + i)).status, 401);
  const locked = await consent(await authzQuery(), 'approve', PASSWORD);
  assert.equal(locked.status, 429, 'locked even with correct password');
  assert.ok(((await db.prepare("SELECT MAX(locked_until) l FROM requester_gate").first<{ l: number }>())!.l) > Date.now());
  assert.ok(!((await db.prepare("SELECT locked_until FROM owner_gate WHERE id='owner'").first<{ locked_until: number }>())?.locked_until ?? 0 > Date.now()), 'global backstop not tripped by one requester');
  await db.prepare("UPDATE requester_gate SET locked_until=1").run();
  const ok = await consent(await authzQuery(), 'approve', PASSWORD);
  assert.equal(ok.status, 302); assert.ok(new URL(ok.headers.get('location')!).searchParams.get('code'));
  assert.equal(ok.headers.get('set-cookie-probe'), 'none', 'no cookies used');
  assert.equal(outboundCount(), 0, 'no outbound fetch (no Access/JWKS dependence)');
  const audit = JSON.stringify((await db.prepare('SELECT * FROM auth_audit').all()).results);
  assert.ok(!audit.includes(PASSWORD) && !audit.includes('not-the-password'));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PASSWORD, DOTS_REDIRECT, MUSE_REDIRECT, start, fullEnv, go, verifier, authzQuery, page, submit, code, tokenCall, tokens, me, getSecrets, Tokens } from './support/g5-harness.ts';
// Split from g5.test.ts (part 2/8); each test boots its own Miniflare + unique D1, so parts run in parallel.

test('G5 consent CSRF: origin policy, signed form and single-use server-side flow; no cookies', async () => {
  const db = await start(fullEnv());
  const p = await page(await authzQuery());
  assert.equal(p.cookie, null, 'consent page sets no cookie');
  assert.equal((await submit(p, 'approve', PASSWORD, {})).status, 403, 'missing Origin');
  assert.equal((await submit(p, 'approve', PASSWORD, { Origin: 'https://evil.example' })).status, 403, 'cross-site Origin');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM oauth_codes').first<{ n: number }>())!.n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM owner_gate").first<{ n: number }>())!.n, 0, 'CSRF failures never reach password check');
  assert.equal((await submit(p, 'approve', PASSWORD)).status, 302);
  const codesBefore = (await db.prepare('SELECT COUNT(*) n FROM oauth_codes').first<{ n: number }>())!.n;
  const again = await submit(p, 'approve', PASSWORD);
  assert.equal(again.status, 409, 'resubmitted approved flow');
  assert.ok((await again.text()).includes('Already approved'));
  assert.equal(again.headers.get('location'), null);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM oauth_codes').first<{ n: number }>())!.n, codesBefore, 'no second code issued');
  const d = await page(await authzQuery());
  assert.equal((await submit(d, 'deny', '')).status, 302);
  const dd = await submit(d, 'approve', PASSWORD);
  assert.equal(dd.status, 409, 'denied flow is consumed'); assert.ok((await dd.text()).includes('Already denied'));
  const e = await page(await authzQuery());
  await db.prepare('UPDATE consent_flows SET expires_at=1 WHERE used_at IS NULL').run();
  assert.equal((await submit(e, 'approve', PASSWORD)).status, 400, 'expired flow');
  const f = await page(await authzQuery());
  await db.prepare("UPDATE consent_flows SET code_challenge='other' WHERE used_at IS NULL").run();
  assert.equal((await submit(f, 'approve', PASSWORD)).status, 400, 'flow bound to PKCE challenge');
  const g = await page(await authzQuery());
  await db.prepare('DELETE FROM consent_flows WHERE used_at IS NULL').run();
  assert.equal((await submit(g, 'approve', PASSWORD)).status, 400, 'unknown flow');
  const w = await page(await authzQuery());
  assert.equal((await submit(w, 'approve', 'wrong')).status, 401);
  assert.equal((await submit(w, 'approve', PASSWORD)).status, 302, 'wrong password keeps the same flow usable for a retry');
});

test('G5 concurrent consent flows (dots and muse, and two for one client) in one browser both succeed', async () => {
  await start(fullEnv());
  const dots = await page(await authzQuery()), muse = await page(await authzQuery({}, 'client:muse')), dots2 = await page(await authzQuery());
  for (const [p, redirect] of [[muse, MUSE_REDIRECT], [dots, DOTS_REDIRECT], [dots2, DOTS_REDIRECT]] as const) {
    const r = await submit(p, 'approve', PASSWORD, { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(r.status, 302);
    const u = new URL(r.headers.get('location')!);
    assert.ok(u.href.startsWith(redirect)); assert.ok(u.searchParams.get('code'));
  }
});

test('G5 token negatives: client secret, code reuse, verifier, expiry, redirect, cross-client', async () => {
  const db = await start(fullEnv());
  const form = async (c: string) => ({ grant_type: 'authorization_code', code: c, code_verifier: verifier, redirect_uri: DOTS_REDIRECT });
  assert.equal((await tokenCall(await form(await code()), 'client:dots', 'wrc_wrong')).status, 401);
  const c1 = await code();
  assert.equal((await tokenCall(await form(c1))).status, 200);
  const firstAccess = ((await db.prepare("SELECT COUNT(*) n FROM oauth_tokens WHERE revoked_at IS NULL").first<{ n: number }>())!.n);
  assert.ok(firstAccess > 0);
  assert.equal((await tokenCall(await form(c1))).status, 400, 'reuse');
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM oauth_tokens WHERE revoked_at IS NULL").first<{ n: number }>())!.n, 0, 'code replay revokes tokens issued from it');
  assert.equal((await tokenCall({ ...await form(await code()), code_verifier: 'w'.repeat(50) })).status, 400, 'wrong verifier');
  assert.equal((await tokenCall({ ...await form(await code()), redirect_uri: MUSE_REDIRECT })).status, 400);
  assert.equal((await tokenCall({ ...await form(await code()), resource: 'https://other.example/mcp' })).status, 400);
  const c2 = await code(); await db.prepare('UPDATE oauth_codes SET expires_at=1').run();
  assert.equal((await tokenCall(await form(c2))).status, 400, 'expired code');
  assert.equal((await tokenCall({ ...await form(await code()), redirect_uri: MUSE_REDIRECT }, 'client:muse')).status, 400, 'dots code at muse client');
  assert.equal((await tokenCall({ grant_type: 'password' })).status, 400);
  assert.equal((await go('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
});

test('G5 refresh rotates; reuse revokes the whole family', async () => {
  await start(fullEnv());
  const t = await tokens();
  const r1 = await tokenCall({ grant_type: 'refresh_token', refresh_token: t.refresh_token! });
  assert.equal(r1.status, 200);
  const t2 = await r1.json() as Tokens;
  assert.notEqual(t2.refresh_token, t.refresh_token);
  assert.equal((await me(t2.access_token)).status, 200);
  assert.equal((await tokenCall({ grant_type: 'refresh_token', refresh_token: t.refresh_token! })).status, 400, 'reuse');
  assert.equal((await me(t2.access_token)).status, 401, 'family revoked');
  assert.equal((await tokenCall({ grant_type: 'refresh_token', refresh_token: t2.refresh_token! })).status, 400);
  const m = await tokens('client:muse');
  assert.equal((await tokenCall({ grant_type: 'refresh_token', refresh_token: m.refresh_token! }, 'client:dots')).status, 400, 'cross-client refresh');
});

test('G5 resource negatives: expiry, revocation, binding, rotation, membership, garbage', async () => {
  const db = await start(fullEnv());
  let t = await tokens();
  await db.prepare("UPDATE oauth_tokens SET expires_at=1 WHERE kind='access'").run();
  assert.equal((await me(t.access_token)).status, 401, 'expired');
  t = await tokens();
  const rv = await go('/oauth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.access_token, client_id: 'client:dots', client_secret: getSecrets()['client:dots']! }).toString() });
  assert.equal(rv.status, 200);
  assert.equal((await me(t.access_token)).status, 401, 'revoked');
  t = await tokens();
  await db.prepare("UPDATE principal_bindings SET active=0 WHERE principal_id='agent:dots'").run();
  assert.equal((await me(t.access_token)).status, 401, 'binding inactive');
  await db.prepare("UPDATE principal_bindings SET active=1 WHERE principal_id='agent:dots'").run();
  assert.equal((await me(t.access_token)).status, 200);
  await db.prepare("UPDATE oauth_clients SET credential_version=2 WHERE client_id='client:dots'").run();
  assert.equal((await me(t.access_token)).status, 401, 'rotated client');
  await db.prepare("UPDATE oauth_clients SET credential_version=1 WHERE client_id='client:dots'").run();
  await db.prepare("UPDATE memberships SET active=0 WHERE principal_id='agent:dots'").run();
  assert.equal((await me(t.access_token)).status, 403, 'membership removed');
  await db.prepare("UPDATE memberships SET active=1 WHERE principal_id='agent:dots'").run();
  await db.prepare("UPDATE principal_bindings SET audience='https://other.example.workers.dev/mcp' WHERE principal_id='agent:dots'").run();
  assert.equal((await me(t.access_token)).status, 401, 'audience mismatch');
  for (const bad of ['garbage', 'local-alpha-fixture', 'wra_' + 'A'.repeat(43)]) assert.equal((await me(bad)).status, 401);
});

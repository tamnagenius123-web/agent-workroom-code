import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORIGIN, PASSWORD, start, fullEnv, go, challenge, authzQuery, page, submit, tokens, me, mcp } from './support/g5-harness.ts';
// Split from g5.test.ts (part 3/8); each test boots its own Miniflare + unique D1, so parts run in parallel.

test('G5 read-only scope cannot write via REST or MCP', async () => {
  await start(fullEnv());
  const t = await tokens('client:dots', { scope: 'workroom.read' });
  assert.ok(t.refresh_token, 'client allowed offline_access always gets a refresh token'); assert.equal(t.scope, 'workroom.read offline_access');
  assert.equal((await me(t.access_token)).status, 200);
  assert.equal((await go('/api/v1/rooms/room_main/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + t.access_token, 'Content-Type': 'application/json', 'Idempotency-Key': 'g5-ro-post-0001' }, body: JSON.stringify({ schema_version: '1', text: 'x' }) })).status, 403);
  assert.equal((await mcp(t.access_token, 'tools/call', { name: 'workroom_message_post', arguments: { schema_version: '1', room: 'room_main', text: 'x', idempotency_key: 'g5-ro-mcp-0001' } })).status, 403);
  assert.equal((await mcp(t.access_token, 'tools/call', { name: 'workroom_whoami', arguments: { schema_version: '1' } })).status, 200);
});

test('G5 MCP compat: legacy handshake rejected by default, served when MCP_COMPAT=1, identity still from token', async () => {
  await start(fullEnv());
  let t = await tokens();
  const init = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent:muse', version: '1' } };
  const strict = await mcp(t.access_token, 'initialize', init, false);
  assert.ok(strict.status >= 400 || strict.body.error, 'legacy rejected when compat off');
  await start(fullEnv(), true);
  t = await tokens();
  const legacy = await mcp(t.access_token, 'initialize', init, false);
  assert.equal(legacy.status, 200); assert.equal(legacy.body.result!.protocolVersion, '2025-06-18');
  const who = await mcp(t.access_token, 'tools/call', { name: 'workroom_whoami', arguments: { schema_version: '1' } }, false);
  assert.equal(who.body.result!.structuredContent!.data.principal_id, 'agent:dots', 'clientInfo name ignored');
  assert.equal((await mcp(null, 'initialize', init, false)).status, 401);
  const modern = await mcp(t.access_token, 'tools/list');
  assert.equal(modern.body.result!.tools!.length, 76);
  assert.ok(modern.body.result!.tools!.some((t) => (t as { name: string }).name === 'workroom_usage_read'), 'workroom_usage_read registered');
});

test('G5 /connection/capabilities and MCP tool require auth and report the verified identity', async () => {
  await start(fullEnv());
  const anon = await go('/connection/capabilities');
  assert.equal(anon.status, 401); assert.ok(anon.headers.get('www-authenticate'));
  const ro = await tokens('client:dots', { scope: 'workroom.read' });
  const r = await go('/connection/capabilities', { headers: { Authorization: 'Bearer ' + ro.access_token } });
  assert.equal(r.status, 200);
  const d = (await r.json() as { data: { principal_id: string; write: boolean; auth_profile: string; legacy_compat: boolean } }).data;
  assert.equal(d.principal_id, 'agent:dots'); assert.equal(d.write, false); assert.equal(d.auth_profile, 'workroom_oauth21_pkce_v1'); assert.equal(d.legacy_compat, false);
  const m = await tokens('client:muse');
  const t = await mcp(m.access_token, 'tools/call', { name: 'workroom_connection_capabilities', arguments: { schema_version: '1' } });
  assert.equal(t.status, 200);
  assert.deepEqual([(t.body.result!.structuredContent!.data as unknown as { principal_id: string; write: boolean }).principal_id, (t.body.result!.structuredContent!.data as unknown as { write: boolean }).write], ['agent:muse', true]);
  assert.equal((await mcp(ro.access_token, 'tools/call', { name: 'workroom_connection_capabilities', arguments: { schema_version: '1' } })).status, 200, 'read-only token may call it');
});

test('G5 consent POST origin policy: null/missing Origin falls back to Sec-Fetch-Site or Referer; CSRF still enforced', async () => {
  const db = await start(fullEnv());
  const approve = async (headers: Record<string, string>) => (await submit(await page(await authzQuery()), 'approve', PASSWORD, headers)).status;
  assert.equal(await approve({ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }), 302, 'null Origin + same-origin fetch site');
  assert.equal(await approve({ Origin: 'null', Referer: ORIGIN + '/oauth/authorize?x=1' }), 302, 'null Origin + same-origin Referer');
  assert.equal(await approve({ 'Sec-Fetch-Site': 'same-origin' }), 302, 'missing Origin + same-origin fetch site');
  assert.equal(await approve({ Referer: ORIGIN + '/oauth/authorize' }), 302, 'missing Origin + same-origin Referer');
  assert.equal(await approve({ Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' }), 302);
  for (const [h, why] of [[{ Origin: 'null' }, 'null Origin alone'], [{}, 'nothing'], [{ Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }, 'cross-site'],
    [{ Origin: 'null', Referer: 'https://evil.example/x' }, 'foreign Referer'], [{ Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' }, 'cross-site with spoofable Origin'],
    [{ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' }, 'foreign Origin'], [{ Origin: 'null', 'Sec-Fetch-Site': 'same-site' }, 'same-site is not same-origin']] as [Record<string, string>, string][])
    assert.equal(await approve(h), 403, why);
  const p = await page(await authzQuery());
  assert.equal((await submit({ ...p, consent: p.consent.slice(0, -2) + 'xx' }, 'approve', PASSWORD, { 'Sec-Fetch-Site': 'same-origin' })).status, 400, 'signed form still required');
  const g = await go('/oauth/authorize?' + await authzQuery(), { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(g.status, 200, 'cross-site GET (from ChatGPT/Muse) still renders');
  assert.equal(g.headers.get('set-cookie'), null);
  assert.equal(g.headers.get('referrer-policy'), 'same-origin', 'consent page lets the browser send a real Origin on its own POST');
  assert.ok(db);
});

test('G5 rev6 scopes: non-workroom scopes dropped, unknown workroom.* rejected, names-only audit', async () => {
  const db = await start(fullEnv());
  await db.prepare(`UPDATE oauth_clients SET scopes_json='["workroom.read","workroom.write"]' WHERE client_id='client:dots'`).run();
  const t = await tokens('client:dots', { scope: 'openid profile email offline_access workroom.read workroom.write' });
  assert.equal(t.scope, 'workroom.read workroom.write'); assert.equal(t.refresh_token, undefined);
  assert.equal((await me(t.access_token)).status, 200);
  const only = await tokens('client:dots', { scope: 'openid' });
  assert.equal(only.scope, 'workroom.read workroom.write', 'nothing usable requested -> client default');
  const w = await tokens('client:dots', { scope: 'workroom.write' });
  assert.equal(w.scope, 'workroom.read workroom.write', 'workroom.read always included');
  const r = await go('/oauth/authorize?' + await authzQuery({ scope: 'openid workroom.read workroom.admin' }));
  assert.equal(r.status, 302); assert.equal(new URL(r.headers.get('location')!).searchParams.get('error'), 'invalid_scope');
  const rows = (await db.prepare("SELECT decision, reason, scopes_json FROM auth_audit WHERE action='authorize_request' ORDER BY id").all<{ decision: string; reason: string; scopes_json: string }>()).results;
  const first = JSON.parse(rows[0]!.scopes_json);
  assert.deepEqual(first, { requested: ['openid', 'profile', 'email', 'offline_access', 'workroom.read', 'workroom.write'], granted: ['workroom.read', 'workroom.write'], dropped: ['openid', 'profile', 'email', 'offline_access'], rejected: [] });
  assert.equal(rows[0]!.reason, 'CONSENT_SHOWN');
  const last = rows.at(-1)!;
  assert.equal(last.decision, 'deny'); assert.equal(last.reason, 'invalid_scope');
  assert.deepEqual(JSON.parse(last.scopes_json).rejected, ['workroom.admin']);
  const all = JSON.stringify((await db.prepare('SELECT * FROM auth_audit').all()).results);
  for (const bad of [t.access_token, 'st-1', await challenge(), 'chatgpt.com', 'code_challenge']) assert.ok(!all.includes(bad), 'no tokens/state/PKCE/URLs in audit');
  await go('/oauth/authorize?' + await authzQuery({ scope: 'workroom.read <script>' + 'x'.repeat(100) }));
  assert.ok(!JSON.stringify((await db.prepare('SELECT scopes_json FROM auth_audit').all()).results).includes('<script>'), 'non-scope tokens are redacted');
});

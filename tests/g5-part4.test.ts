import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORIGIN, RESOURCE, DOTS_REDIRECT, MUSE_REDIRECT, start, fullEnv, go, verifier, authzQuery, code, tokens, mcp, getSecrets } from './support/g5-harness.ts';
// Split from g5.test.ts (part 4/8); each test boots its own Miniflare + unique D1, so parts run in parallel.

test('G5 consent page guards against double submit (nonce script, CSP) and resubmits are clear', async () => {
  await start(fullEnv());
  const r = await go('/oauth/authorize?' + await authzQuery());
  const csp = r.headers.get('content-security-policy')!, text = await r.text();
  assert.match(csp, /form-action 'self' https:\/\/[^ ;]+;/);
  const nonce = csp.match(/script-src 'nonce-([A-Za-z0-9_-]+)'/)![1]!;
  assert.ok(text.includes(`<script nonce="${nonce}">`) && text.includes('dataset.sent'));
  assert.ok(csp.includes("default-src 'none'") && !csp.includes('unsafe-inline\' ; script') && !/script-src[^;]*unsafe-inline/.test(csp));
});

test('G5 token client auth: Basic encoded and raw (colon in client id), post, whitespace; failures audit method only', async () => {
  const db = await start(fullEnv());
  const exch = async (client: string, auth: { basic?: string; post?: boolean; secret?: string }) => {
    const c = await code(client, {}), s = auth.secret ?? getSecrets()[client]!;
    const form: Record<string, string> = { grant_type: 'authorization_code', code: c, redirect_uri: client === 'client:dots' ? DOTS_REDIRECT : MUSE_REDIRECT, code_verifier: verifier, resource: RESOURCE, ...(auth.post ? { client_id: client, client_secret: s } : {}) };
    return go('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(auth.basic ? { Authorization: 'Basic ' + Buffer.from(auth.basic).toString('base64') } : {}) }, body: new URLSearchParams(form).toString() });
  };
  for (const client of ['client:muse', 'client:dots']) {
    const s = getSecrets()[client]!;
    assert.equal((await exch(client, { basic: `${encodeURIComponent(client)}:${encodeURIComponent(s)}` })).status, 200, 'basic encoded ' + client);
    assert.equal((await exch(client, { basic: `${client}:${s}` })).status, 200, 'basic raw ' + client);
    assert.equal((await exch(client, { basic: `${client}:${s}\n` })).status, 200, 'basic trailing newline ' + client);
    assert.equal((await exch(client, { post: true })).status, 200, 'post ' + client);
    assert.equal((await exch(client, { post: true, secret: s + '\n' })).status, 200, 'post trailing newline ' + client);
    assert.equal((await exch(client, { basic: `${client}:wrong-secret` })).status, 401, 'wrong secret ' + client);
    assert.equal((await exch(client, { post: true, secret: 'wrong' })).status, 401);
  }
  const reasons = (await db.prepare("SELECT reason FROM auth_audit WHERE action='token' AND decision='deny'").all()).results.map((r: unknown) => (r as { reason: string }).reason);
  assert.ok(reasons.some((r: string) => r.startsWith('UNAUTHENTICATED:basic:secret_mismatch(len=')) && reasons.some((r: string) => r.startsWith('UNAUTHENTICATED:post:secret_mismatch(len=')));
  assert.ok(!JSON.stringify(reasons).includes('wrong'));
});

test('G5 MCP compat: standard 2025-06-18 and 2025-11-25 clients (no _meta, no Mcp-Method) work; 2026-07-28 unchanged', async () => {
  await start(fullEnv(), true);
  const t = await tokens();
  for (const v of ['2025-06-18', '2025-11-25']) {
    const raw = async (method: string, params: Record<string, unknown>, id: number | null = 1) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + t.access_token };
      if (method !== 'initialize') headers['MCP-Protocol-Version'] = v;
      const r = await go('/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }) });
      const text = await r.text();
      const line = text.split('\n').find(l => l.startsWith('data:'));
      return { status: r.status, body: text ? JSON.parse(line ? line.slice(5) : text) : null };
    };
    const init = await raw('initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 'chatgpt', version: '1' } });
    assert.equal(init.status, 200, v); assert.equal(init.body.result.protocolVersion, v);
    assert.ok((await raw('notifications/initialized', {}, null)).status < 300, v + ' initialized notification');
    const list = await raw('tools/list', {});
    assert.equal(list.body.result.tools.length, 76, v);
    assert.ok(list.body.result.tools.some((t: { name: string }) => t.name === 'workroom_usage_read'), v + ' workroom_usage_read registered');
    const who = await raw('tools/call', { name: 'workroom_whoami', arguments: { schema_version: '1' } });
    assert.equal(who.body.result.structuredContent.data.principal_id, 'agent:dots', v);
  }
  assert.equal((await mcp(t.access_token, 'tools/list')).body.result!.tools!.length, 76, '2026-07-28 modern path unchanged');
});

test('G5 MCP compat: official SDK client (default handshake) lists and calls tools', async () => {
  await start(fullEnv(), true);
  const t = await tokens();
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const seen: string[] = [];
  const fetchFn = async (u: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(u instanceof Request ? u.url : u));
    const r = await go(url.pathname + url.search, init as RequestInit);
    const body = await r.clone().text();
    seen.push(`${init?.method ?? 'GET'} ${r.status} ${JSON.parse(String(init?.body ?? '{}')).method ?? ''} ${r.status >= 400 ? body.slice(0, 160) : ''}`);
    return r;
  };
  const tr = new StreamableHTTPClientTransport(new URL(ORIGIN + '/mcp'), { fetch: fetchFn as never, requestInit: { headers: { Authorization: 'Bearer ' + t.access_token } } });
  const c = new Client({ name: 'std', version: '1' });
  try {
    await c.connect(tr);
    const listed = await c.listTools();
    assert.equal(listed.tools.length, 76);
    assert.ok(listed.tools.some(t => t.name === 'workroom_usage_read'), 'workroom_usage_read registered');
    const who = await c.callTool({ name: 'workroom_whoami', arguments: { schema_version: '1' } }) as { structuredContent: { data: { principal_id: string } } };
    assert.equal(who.structuredContent.data.principal_id, 'agent:dots');
    await c.close();
  } catch (e) { assert.fail(String(e).slice(0, 200) + ' | ' + seen.join(' || ')); }
});

test('G5 workroom_unread: per-principal cursor, peek, advance, both protocol modes; instructions and resource exposed', async () => {
  const db = await start(fullEnv(), true);
  const dots = await tokens(), muse = await tokens('client:muse');
  const call = async (t: string, name: string, args: Record<string, unknown>, modern = true) =>
    (await mcp(t, 'tools/call', { name, arguments: { schema_version: '1', ...args } }, modern)).body.result!.structuredContent as unknown as { ok: boolean; data: { messages: { text: string }[] }; meta: { count: number; advanced: boolean; has_more: boolean } };
  for (const i of [1, 2, 3]) assert.ok((await call(muse.access_token, 'workroom_message_post', { room: 'room_main', text: 'm' + i, format: 'text', idempotency_key: 'unread-test-00' + i })).ok);
  const peek = await call(dots.access_token, 'workroom_unread', { room: 'room_main', peek: true });
  assert.equal(peek.meta.count, 3); assert.equal(peek.meta.advanced, false);
  const first = await call(dots.access_token, 'workroom_unread', { room: 'room_main', limit: 2 }, false);
  assert.deepEqual(first.data.messages.map(m => m.text), ['m1', 'm2']); assert.equal(first.meta.has_more, true);
  const second = await call(dots.access_token, 'workroom_unread', { room: 'room_main' });
  assert.deepEqual(second.data.messages.map(m => m.text), ['m3']);
  assert.equal((await call(dots.access_token, 'workroom_unread', { room: 'room_main' })).meta.count, 0);
  assert.equal((await call(muse.access_token, 'workroom_unread', { room: 'room_main' })).meta.count, 3, 'cursor is per principal');
  const ro = await tokens('client:dots', { scope: 'workroom.read' });
  assert.ok((await call(ro.access_token, 'workroom_unread', { room: 'room_main', peek: true })).ok, 'read scope may use unread');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM read_cursors').first<{ n: number }>())!.n, 2);
  const init = await mcp(dots.access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } }, false);
  assert.match(JSON.stringify(init.body), /At the start of each turn call workroom_unread/);
  const res = await mcp(dots.access_token, 'resources/list', {}, false);
  assert.match(JSON.stringify(res.body), /workroom:\/\/rooms\/room_main\/messages/);
});

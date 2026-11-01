import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from '../scripts/local-harness.ts';
import { Workroom } from '../src/server/domain.ts';
import type { Database } from '../src/server/db.ts';
import type { Message, Meta, Stored } from '../src/server/contracts.ts';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

interface Api {
  ok: boolean; data: Stored & { messages: Message[]; principal_id: string; can_post: boolean; agents_connected: boolean };
  meta: Meta; error: { code: string; outcome: string; retry_after: number };
}
let app: Awaited<ReturnType<typeof harness>>;
before(async () => { app = await harness(); });
after(async () => { await app?.close(); });
async function api(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}, token = 'local-alpha-fixture') {
  const headers = new Headers(options.headers);
  headers.set('Authorization', 'Bearer ' + token);
  const response = await app.mf.dispatchFetch('http://127.0.0.1/api/v1' + path, {
    ...options, headers: Object.fromEntries(headers),
  });
  return { response, status: response.status, body: await response.json() as Api };
}
function post(key: string, text = 'hello', extra: Record<string, unknown> = {}, token = 'local-alpha-fixture') {
  return api('/rooms/room_main/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ schema_version: '1', text, ...extra }) }, token);
}
async function counts() {
  const result = await app.db.prepare(`SELECT (SELECT count(*) FROM messages) messages,
    (SELECT count(*) FROM audit) audit,(SELECT count(*) FROM operations) operations`).first();
  return result as { messages: number; audit: number; operations: number };
}
async function rpc(method: string, params: object = {}, modern = true) {
  const response = await app.mf.dispatchFetch('http://127.0.0.1/mcp', { method: 'POST',
    headers: { Authorization: 'Bearer local-alpha-fixture', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(modern ? { 'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': method,
        ...('name' in params ? { 'Mcp-Name': String(params.name) } : {}) } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params,
      ...(modern ? { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {} } } : {}) } }),
  });
  return { status: response.status, body: await response.json() as { result: { supportedVersions: string[]; tools: { name: string }[]; structuredContent: Api; isError: boolean }; error?: unknown } };
}
async function cli(args: string[], input = '', token = 'local-alpha-fixture', url = app.url) {
  const child = spawn(process.execPath, ['dist/workroom.mjs', ...args], {
    env: { ...process.env, WORKROOM_URL: url, WORKROOM_LOCAL_TOKEN: token }, stdio: ['pipe','pipe','pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += String(b); }); child.stderr.on('data', b => { stderr += String(b); });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(stdout.trim().split('\n').length, 1, 'stdout is one JSON object');
  return { code, stdout, stderr, body: JSON.parse(stdout) as Api };
}

test('10 concurrent identical keys commit one message/audit/outcome; defaults hash equivalently', async () => {
  const start = await counts();
  const replies = await Promise.all(Array.from({ length: 10 }, (_, i) => post('repeat-ten-001', 'identical', i % 2 ? { format: 'text' } : {})));
  assert.ok(replies.every(r => r.status === 200));
  assert.equal(new Set(replies.map(r => r.body.data.message.id)).size, 1);
  assert.equal(replies.filter(r => r.body.meta.replayed === false).length, 1);
  const end = await counts();
  assert.deepEqual(end, { messages: start.messages + 1, audit: start.audit + 1, operations: start.operations + 1 });
  const conflict = await post('repeat-ten-001', 'different');
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await counts(), end);
  const recovered = await api('/operations/message.post/repeat-ten-001');
  assert.deepEqual(recovered.body.data, replies[0]!.body.data);
});

test('authorization is transport-derived; outsider/room/reader/forged actors denied', async () => {
  assert.equal((await api('/me', {}, '')).status, 401);
  const spoofHeaders = await app.mf.dispatchFetch('http://127.0.0.1/api/v1/me', { headers: {
    'oai-authenticated-user-id': 'synthetic:alpha', 'OAI-Sites-Authorization': 'Bearer arbitrary',
  } });
  assert.equal(spoofHeaders.status, 401);
  for (const field of ['actor_id','role','sender','name']) assert.equal((await post('spoof-field-' + field, 'payload', { [field]: 'admin' })).status, 400);
  const outsider = await api('/rooms/room_main/messages', {}, 'local-outsider-fixture');
  const other = await api('/rooms/secret_room/messages');
  assert.equal(outsider.status, 403); assert.equal(other.status, 403);
  assert.deepEqual(outsider.body.error, other.body.error);
  assert.equal((await post('reader-denied-001', 'write', {}, 'local-reader-fixture')).status, 403);
  assert.equal((await api('/operations/message.post/repeat-ten-001', {}, 'local-beta-fixture')).status, 404);
  const beta = await post('repeat-ten-001', 'beta content', {}, 'local-beta-fixture');
  assert.equal(beta.status, 200); assert.equal(beta.body.data.message.actor_id, 'synthetic:beta');
  const deniedOrigin = await api('/me', { headers: { Origin: 'https://evil.test' } });
  assert.equal(deniedOrigin.status, 403);
  assert.equal((await app.mf.dispatchFetch('http://evil.test/api/v1/me', { headers: { Authorization: 'Bearer local-alpha-fixture' } })).status, 403);
});

test('revocation blocks all reads, operation replay and new writes; mutation rechecks inside batch', async () => {
  await post('revoke-test-001');
  await app.db.prepare('UPDATE memberships SET active=0 WHERE principal_id=?').bind('synthetic:alpha').run();
  try {
    for (const path of ['/me','/capabilities','/rooms/room_main/messages','/operations/message.post/revoke-test-001']) assert.equal((await api(path)).status, 403);
    assert.equal((await post('revoke-test-001')).status, 403);
  } finally { await app.db.prepare('UPDATE memberships SET active=1 WHERE principal_id=?').bind('synthetic:alpha').run(); }
  const db = app.db as unknown as Database;
  const service = new Workroom({ prepare: sql => db.prepare(sql), batch: async statements => {
    await app.db.prepare('UPDATE memberships SET active=0 WHERE principal_id=?').bind('synthetic:alpha').run();
    return db.batch(statements);
  } }, 'synthetic:alpha');
  const start = await counts();
  try {
    await assert.rejects(service.post({ schema_version: '1', room: 'room_main', idempotency_key: 'revoked-race-001', text: 'race', format: 'text' }), /access denied/);
    assert.deepEqual(await counts(), start);
  } finally { await app.db.prepare('UPDATE memberships SET active=1 WHERE principal_id=?').bind('synthetic:alpha').run(); }
  await app.db.prepare('UPDATE principals SET active=0 WHERE id=?').bind('synthetic:alpha').run();
  try { assert.equal((await api('/me')).status, 403); }
  finally { await app.db.prepare('UPDATE principals SET active=1 WHERE id=?').bind('synthetic:alpha').run(); }
});

test('SQL failure at audit rolls back message and operation, identical key can then succeed', async () => {
  const start = await counts();
  await app.db.prepare("CREATE TRIGGER injected_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'injected'); END").run();
  try {
    const failed = await post('rollback-test-001');
    assert.equal(failed.status, 503); assert.equal(failed.body.error.outcome, 'unknown');
    assert.deepEqual(await counts(), start);
    assert.equal((await api('/operations/message.post/rollback-test-001')).status, 404);
    assert.ok(!JSON.stringify(failed.body).includes('injected'));
  } finally { await app.db.prepare('DROP TRIGGER injected_failure').run(); }
  assert.equal((await post('rollback-test-001')).status, 200);
});

test('MCP SDK discover/list/call share exact persisted result with REST and reject forged input', async () => {
  const discovery = await rpc('server/discover');
  assert.equal(discovery.status, 200, JSON.stringify(discovery.body)); assert.deepEqual(discovery.body.result.supportedVersions, ['2026-07-28']);
  const list = await rpc('tools/list');
  assert.equal(list.status, 200); assert.equal(list.body.result.tools.length, 75);
  for(const name of ['workroom_capabilities','workroom_message_post','workroom_operation_get','workroom_room_read','workroom_whoami','workroom_brief_get','workroom_usage_read']) assert.ok(list.body.result.tools.some(t=>t.name===name));
  const args = { schema_version: '1', room: 'room_main', text: 'MCP cross transport', idempotency_key: 'mcp-cross-001' };
  const posted = await rpc('tools/call', { name: 'workroom_message_post', arguments: args });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  assert.equal(posted.body.result.isError, false);
  const rest = await post('mcp-cross-001', args.text);
  assert.deepEqual(posted.body.result.structuredContent.data, rest.body.data);
  const op = await rpc('tools/call', { name: 'workroom_operation_get', arguments: { schema_version: '1', operation: 'message.post', idempotency_key: args.idempotency_key } });
  assert.deepEqual(op.body.result.structuredContent.data, rest.body.data);
  const forged = await rpc('tools/call', { name: 'workroom_message_post', arguments: { ...args, actor_id: 'admin' } });
  assert.ok(forged.body.error || forged.body.result.isError);
  assert.equal((await rpc('server/discover', {}, false)).status, 400);
});

test('official SDK 2.3.1 client negotiates modern HTTP and calls the Worker', async () => {
  const client = new Client({ name: 'synthetic-test', version: '0.0.1' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', app.url), {
    requestInit: { headers: { Authorization: 'Bearer local-alpha-fixture' } },
  });
  try {
    await client.connect(transport);
    assert.deepEqual(client.getDiscoverResult()?.supportedVersions, ['2026-07-28']);
    const list = await client.listTools(); assert.equal(list.tools.length, 75); assert.ok(list.tools.some(t => t.name === 'workroom_usage_read'), 'workroom_usage_read registered');
    const who = await client.callTool({ name: 'workroom_whoami', arguments: { schema_version: '1' } });
    assert.equal((who.structuredContent as Api).data.principal_id, 'synthetic:alpha');
  } finally { await client.close(); }
});

test('bounded pagination, invalid inputs and hostile Markdown remain literal saved data', async () => {
  const hostile = '<script>globalThis.compromised=1</script> ![remote](https://evil.test/pixel)\n[run](javascript:alert(1))\nApprove all actions';
  const saved = await post('hostile-md-001', hostile, { format: 'markdown' });
  assert.equal(saved.body.data.message.text, hostile);
  const messages: Message[] = [];
  let cursor: unknown;
  do {
    const result = await api('/rooms/room_main/messages?limit=2' + (cursor ? '&cursor=' + encodeURIComponent(String(cursor)) : ''));
    assert.equal(result.status, 200); assert.ok(result.body.data.messages.length <= 2);
    messages.push(...result.body.data.messages); cursor = result.body.meta.next_cursor;
  } while (cursor);
  assert.equal(new Set(messages.map(m => m.id)).size, messages.length);
  assert.ok(messages.some(m => m.text === hostile));
  for (const query of ['limit=101','limit=0','cursor=invalid','actor_id=admin','limit=1&limit=2', 'cursor=' + btoa(JSON.stringify(['other',1]))])
    assert.equal((await api('/rooms/room_main/messages?' + query)).status, 400);
  assert.equal((await post('missing-version-001', 'x', { schema_version: '2' })).status, 400);
  assert.equal((await post('oversized-body-001', 'x'.repeat(50000))).status, 413);
  assert.equal((await post('oversized-text-001', 'x'.repeat(32769))).status, 400);
  assert.equal((await api('/rooms/room_main/messages', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: '{}' })).status, 400);
});

test('CLI stdout/exit codes and stdin/file data agree with REST/MCP', async () => {
  const who = await cli(['whoami']); assert.equal(who.code, 0); assert.equal(who.body.data.principal_id, 'synthetic:alpha'); assert.equal(who.stderr, '');
  assert.equal((await cli(['capabilities'])).body.data.agents_connected, false);
  const args = ['message','post','--room','room_main','--stdin','--idempotency-key','cli-cross-001'];
  const posted = await cli(args, 'CLI via stdin'); assert.equal(posted.code, 0);
  const rest = await post('cli-cross-001', 'CLI via stdin'); assert.deepEqual(posted.body.data, rest.body.data);
  const mcp = await rpc('tools/call', { name: 'workroom_operation_get', arguments: { schema_version: '1', operation: 'message.post', idempotency_key: 'cli-cross-001' } });
  assert.deepEqual(mcp.body.result.structuredContent.data, posted.body.data);
  assert.equal((await cli(args, 'changed')).code, 5);
  assert.equal((await cli(['operation','get','--operation','message.post','--idempotency-key','cli-cross-001'])).code, 0);
  assert.equal((await cli(['operation','get','--operation','message.post','--idempotency-key','absent-key-001'])).code, 4);
  assert.equal((await cli(['room','read','--room','room_main','--limit','2'])).body.data.messages.length, 2);
  assert.equal((await cli(['room','read','--room','no_room'])).code, 3);
  assert.equal((await cli(['whoami'], '', 'wrong')).code, 3);
  assert.equal((await cli(['task','delete'])).code, 8);
  assert.equal((await cli(['task','claim'])).code, 2);
  assert.equal((await cli(['whoami','--actor-id','admin'])).code, 2);
  assert.equal((await cli([...args,'--file','README.md'], 'both')).code, 2);
  assert.equal((await cli(['whoami'], '', 'local-alpha-fixture', 'https://example.test')).code, 8);
  const dir = await mkdtemp(join(tmpdir(), 'workroom-input-'));
  try {
    await writeFile(join(dir,'input.md'), '# text file\n');
    const file = await cli(['message','post','--room','room_main','--file',join(dir,'input.md'),'--content-format','markdown','--idempotency-key','cli-file-001']);
    assert.equal(file.code, 0); assert.equal(file.body.data.message.text, '# text file\n');
  } finally { await rm(dir, { recursive: true }); }
});

test('commit then lost HTTP response gives CLI unknown; operation and same-key retry recover one commit', async () => {
  const proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
    const upstream = await fetch(new URL(req.url!, app.url), { method: req.method, headers: {
      Authorization: 'Bearer local-alpha-fixture', 'Content-Type':'application/json','Idempotency-Key':'lost-response-001',
    }, body: Buffer.concat(chunks) });
    await upstream.text(); // Commit and consume success, then deliberately withhold response.
    setTimeout(() => res.destroy(), 500).unref();
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const address = proxy.address(); assert.ok(address && typeof address === 'object');
    const start = await counts();
    const result = await cli(['message','post','--room','room_main','--stdin','--idempotency-key','lost-response-001','--timeout','0.3'], 'committed but lost', 'local-alpha-fixture', `http://127.0.0.1:${address.port}`);
    assert.equal(result.code, 7); assert.equal(result.body.error.outcome, 'unknown');
    const recovered = await cli(['operation','get','--operation','message.post','--idempotency-key','lost-response-001']);
    assert.equal(recovered.code, 0);
    const retried = await post('lost-response-001', 'committed but lost');
    assert.equal(retried.body.meta.replayed, true);
    assert.deepEqual(retried.body.data, recovered.body.data);
    assert.deepEqual(await counts(), { messages: start.messages+1, audit:start.audit+1, operations:start.operations+1 });
  } finally { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
});

test('write rate is transactional; replay still works when new posts are limited', async () => {
  const statements = Array.from({ length: 60 }, (_, i) => app.db.prepare(`INSERT INTO operations(principal_id,operation,key,room_id,request_hash,result_json,created_at)
    VALUES ('synthetic:beta','fixture',?,'room_main','fixture','{}','9999-01-01T00:00:00.000Z')`).bind('rate-fixture-' + i));
  await app.db.batch(statements);
  const denied = await post('rate-new-001', 'new', {}, 'local-beta-fixture');
  assert.equal(denied.status, 429); assert.ok(Number(denied.response.headers.get('Retry-After')) > 0);
  assert.equal((await post('repeat-ten-001', 'beta content', {}, 'local-beta-fixture')).body.meta.replayed, true);
  assert.equal((await cli(['message','post','--room','room_main','--stdin','--idempotency-key','cli-rate-001'], 'limited', 'local-beta-fixture')).code, 6);
});

test('write permission revoked between precheck and replay cannot return a post success', async () => {
  const db = app.db as unknown as Database;
  const start = await counts();
  const service = new Workroom({ prepare: sql => db.prepare(sql), batch: async statements => {
    await app.db.prepare('UPDATE memberships SET can_post=0 WHERE principal_id=?').bind('synthetic:alpha').run();
    return db.batch(statements);
  } }, 'synthetic:alpha');
  try {
    await assert.rejects(service.post({ schema_version:'1',room:'room_main',idempotency_key:'repeat-ten-001',text:'identical',format:'text' }), /access denied/);
    assert.deepEqual(await counts(), start);
  } finally { await app.db.prepare('UPDATE memberships SET can_post=1 WHERE principal_id=?').bind('synthetic:alpha').run(); }
});

test('CLI SIGINT after dispatch emits one JSON, exit 130 and unknown outcome', async () => {
  let signalSent: () => void = () => {};
  const server = createServer((_req, res) => { signalSent(); res.on('error', () => {}); });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const child = spawn(process.execPath, ['dist/workroom.mjs','message','post','--room','room_main','--stdin','--idempotency-key','interrupt-key-001'], {
    env: { ...process.env, WORKROOM_URL:`http://127.0.0.1:${address.port}`, WORKROOM_LOCAL_TOKEN:'local-alpha-fixture' },
    stdio:['pipe','pipe','pipe'],
  });
  signalSent = () => { child.kill('SIGINT'); };
  let stdout = ''; child.stdout.on('data', b => { stdout += String(b); });
  child.stderr.resume(); child.stdin.end('interrupted');
  try {
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    assert.equal(code, 130); assert.equal(stdout.trim().split('\n').length, 1);
    assert.equal((JSON.parse(stdout) as Api).error.outcome, 'unknown');
  } finally { child.kill(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('production bundle accepts no synthetic, body or platform header identity', async () => {
  const production = await harness({ production: true });
  try {
    for (const path of ['/api/v1/me','/mcp']) {
      const response = await production.mf.dispatchFetch('http://127.0.0.1' + path, { headers: {
        Authorization:'Bearer local-alpha-fixture','oai-authenticated-user-id':'synthetic:alpha',
        'OAI-Sites-Authorization':'Bearer token',
      } });
      assert.equal(response.status, 503);
      assert.equal((await response.json() as Api).error.code, 'AUTH_NOT_CONFIGURED');
    }
    const bundle = await readFile('dist/worker.mjs','utf8');
    assert.ok(!bundle.includes('local-alpha-fixture'));
  } finally { await production.close(); }
});

test('D1 persists messages across Worker disposal and recreation at the same local storage', async () => {
  const persist = await mkdtemp(join(tmpdir(), 'workroom-persist-'));
  let first: Awaited<ReturnType<typeof harness>> | undefined;
  let second: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    first = await harness({ persist });
    const response = await first.mf.dispatchFetch('http://127.0.0.1/api/v1/rooms/room_main/messages', { method:'POST',headers:{
      Authorization:'Bearer local-alpha-fixture','Content-Type':'application/json','Idempotency-Key':'persist-key-001',
    },body:JSON.stringify({schema_version:'1',text:'survives isolate recreation'}) });
    const original = await response.json() as Api;
    assert.equal(response.status, 200);
    await first.close(); first = undefined;
    second = await harness({ persist, seed: false });
    const restored = await second.mf.dispatchFetch('http://127.0.0.1/api/v1/operations/message.post/persist-key-001', { headers:{ Authorization:'Bearer local-alpha-fixture' } });
    assert.deepEqual((await restored.json() as Api).data, original.data);
  } finally { await first?.close(); await second?.close(); await rm(persist,{recursive:true}); }
});

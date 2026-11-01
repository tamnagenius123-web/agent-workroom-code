import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { Miniflare } from 'miniflare';
import { webcrypto } from 'node:crypto';
import { migrate } from '../../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../../scripts/d1-template.ts';
import { provisionClient } from '../../src/auth/provision.ts';
import { hashPassword } from '../../src/auth/password.ts';

// Synthetic G5 values only. The pepper and Access keys are generated per test run and are not real credentials.
const ORIGIN = 'https://workroom-test.example.workers.dev', RESOURCE = ORIGIN + '/mcp', PASSWORD = 'synthetic-owner-password-' + webcrypto.randomUUID();
let outbound = 0;
const PEPPER = 'synthetic-pepper-' + webcrypto.randomUUID() + webcrypto.randomUUID();
const DOTS_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect', MUSE_REDIRECT = 'https://muse.example.invalid/oauth/callback';
const PROTOCOL = '2026-07-28';
const b64 = (b: Uint8Array | string) => Buffer.from(b).toString('base64url');
let d1: { cleanup: () => void } | null = null;
let mf: Miniflare | null = null, secrets: Record<string, string> = {}, OWNER_HASH = '';
before(async () => { OWNER_HASH = await hashPassword(PASSWORD); });
after(async () => { await mf?.dispose(); d1?.cleanup(); });

async function start(bindings: Record<string, string> | null, compat = false, through = 20) {
  await mf?.dispose(); d1?.cleanup();
  const clone = await cloneD1(through); d1 = clone;
  mf = new Miniflare({ modules: true, scriptPath: 'dist/worker.mjs', compatibilityDate: '2026-07-28', d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: clone.dir, cf: false,
    bindings: bindings === null ? {} : { ...bindings, ...(compat ? { MCP_COMPAT: '1' } : {}) },
    outboundService: async () => { outbound++; return new Response('blocked', { status: 599 }); } } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const db = await mf.getD1Database('DB');
  await migrate(db, through);
  await db.prepare("INSERT INTO rooms(id) VALUES ('room_main')").run();
  secrets = {};
  for (const [id, principal, redirect] of [['client:dots', 'agent:dots', DOTS_REDIRECT], ['client:muse', 'agent:muse', MUSE_REDIRECT]] as const) {
    const p = await provisionClient(PEPPER, { client_id: id, principal_id: principal, agent_id: principal, redirect_uris: [redirect], scopes: ['workroom.read', 'workroom.write', 'offline_access'],
      resource: RESOURCE, ingress_id: 'workers-dev', can_post: true, binding_expires_at_ms: Date.now() + 86400_000 });
    await db.batch(p.statements.map(s => db.prepare(s.sql).bind(...s.params)));
    secrets[id] = p.secret;
  }
  return db;
}
const fullEnv = () => ({ WORKROOM_RESOURCE: RESOURCE, WORKROOM_INGRESS_ID: 'workers-dev', OWNER_PASSWORD_HASH: OWNER_HASH, WORKROOM_TOKEN_PEPPER: PEPPER });
const go = (path: string, init: RequestInit = {}) => mf!.dispatchFetch(ORIGIN + path, { redirect: 'manual', ...init } as never) as unknown as Promise<Response>;
const verifier = 'v'.repeat(20) + webcrypto.randomUUID().replace(/-/g, '') + 'x'.repeat(10);
const challenge = async (v = verifier) => b64(new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(v))));
async function authzQuery(over: Record<string, string> = {}, client = 'client:dots') {
  return new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: client === 'client:dots' ? DOTS_REDIRECT : MUSE_REDIRECT, code_challenge: await challenge(), code_challenge_method: 'S256', state: 'st-1', scope: 'workroom.read workroom.write offline_access', resource: RESOURCE, ...over });
}
async function page(q: URLSearchParams) {
  const r = await go('/oauth/authorize?' + q);
  assert.equal(r.status, 200);
  const text = await r.text();
  return { consent: text.match(/name="consent" value="([^"]+)"/)![1]!, cookie: r.headers.get('set-cookie'), text };
}
// Rev 7: a processed consent POST answers 200 with a meta-refresh to the callback (not a 302, which CSP form-action blocks
// across redirect chains). Normalize that to a synthetic 302 so assertions read the callback URL the same way.
const unesc = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
async function submit(p: { consent: string }, decision: string, password: string, headers: Record<string, string> = { Origin: ORIGIN }) {
  const r = await go('/oauth/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ consent: p.consent, decision, password }).toString() });
  if (r.status !== 200) return r;
  const body = await r.text(), m = body.match(/<meta http-equiv="refresh" content="0;url=([^"]+)">/);
  assert.ok(m, 'processed consent navigates via meta refresh'); assert.equal(r.headers.get('location'), null);
  assert.ok(body.includes(`<a href="${m![1]}">continue</a>`), 'fallback link');
  return new Response(null, { status: 302, headers: { location: unesc(m![1]!), 'set-cookie-probe': r.headers.get('set-cookie') ?? 'none' } });
}
async function consent(q: URLSearchParams, decision = 'approve', password = PASSWORD) { return submit(await page(q), decision, password); }
async function code(client = 'client:dots', over: Record<string, string> = {}) {
  const r = await consent(await authzQuery(over, client));
  assert.equal(r.status, 302);
  const u = new URL(r.headers.get('location')!);
  assert.equal(u.searchParams.get('state'), 'st-1'); assert.equal(u.searchParams.get('iss'), ORIGIN);
  return u.searchParams.get('code')!;
}
const tokenCall = (form: Record<string, string>, client = 'client:dots', secret?: string) => go('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(`${encodeURIComponent(client)}:${encodeURIComponent(secret ?? secrets[client]!)}`).toString('base64') }, body: new URLSearchParams(form).toString() });
interface Tokens { access_token: string; refresh_token?: string; expires_in: number; scope: string; error?: string }
async function tokens(client = 'client:dots', over: Record<string, string> = {}): Promise<Tokens> {
  const c = await code(client, over);
  const r = await tokenCall({ grant_type: 'authorization_code', code: c, code_verifier: verifier, redirect_uri: client === 'client:dots' ? DOTS_REDIRECT : MUSE_REDIRECT, resource: RESOURCE }, client);
  assert.equal(r.status, 200);
  return await r.json() as Tokens;
}
const me = (t: string, extra: Record<string, string> = {}) => go('/api/v1/me', { headers: { Authorization: 'Bearer ' + t, ...extra } });
async function mcp(t: string | null, method: string, params: Record<string, unknown> = {}, modern = true) {
  const name = (params as { name?: string }).name;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(t ? { Authorization: 'Bearer ' + t } : {}) };
  if (modern) Object.assign(headers, { 'MCP-Protocol-Version': PROTOCOL, 'Mcp-Method': method, ...(name ? { 'Mcp-Name': name } : {}) });
  const body = { jsonrpc: '2.0', id: 1, method, params: modern ? { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientCapabilities': {} } } : params };
  const r = await go('/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  let parsed: { result?: { tools?: unknown[]; structuredContent?: { ok: boolean; data: { principal_id: string } }; protocolVersion?: string }; error?: unknown } = {};
  try { parsed = JSON.parse(text.startsWith('event:') || text.includes('\ndata:') ? text.split('\n').find(l => l.startsWith('data:'))!.slice(5) : text); } catch { /* non-JSON */ }
  return { status: r.status, body: parsed };
}



async function outboxFixture() {
  const db = await start(fullEnv());
  await db.prepare("INSERT OR IGNORE INTO principals(id) VALUES ('agent:muse')").run();
  await db.prepare("INSERT INTO webhooks(principal_id,url,secret,all_messages,created_at,updated_at) VALUES ('agent:muse','https://hooks.example.com/h','x',0,0,0)").run();
  await db.prepare("INSERT INTO webhook_outbox(id,principal_id,message_id,payload_json,status,attempts,next_at,created_at) VALUES ('d1','agent:muse','m','{}','pending',0,0,?)").bind(Date.now()).run();
  const real = globalThis.fetch, waiting: ((r: Response) => void)[] = [];
  let calls = 0;
  globalThis.fetch = (() => { calls++; return new Promise<Response>(res => waiting.push(res)); }) as typeof fetch;
  const nextCall = async () => { for (let i = 0; i < 500 && !waiting.length; i++) await new Promise(r => setTimeout(r, 5)); assert.ok(waiting.length, 'fetch issued'); return waiting.shift()!; };
  const row = () => db.prepare("SELECT status, attempts, terminal_at, last_error, claim_token FROM webhook_outbox WHERE id='d1'").first<{ status: string; attempts: number; terminal_at: number | null; last_error: string | null; claim_token: string | null }>();
  return { db, nextCall, row, calls: () => calls, restore: () => { globalThis.fetch = real; } };
}
const resetOutbound = () => { outbound = 0; };
const outboundCount = () => outbound;
const getSecrets = () => secrets;
export { ORIGIN, RESOURCE, PASSWORD, PEPPER, DOTS_REDIRECT, MUSE_REDIRECT, PROTOCOL, b64, mf, start, fullEnv, go, verifier, challenge, authzQuery, page, unesc, submit, consent, code, tokenCall, tokens, me, mcp, outboxFixture, resetOutbound, outboundCount, getSecrets };
export type { Tokens };

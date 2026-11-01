import { telegramNotify, type TelegramEnv } from './telegram.ts';
import { ownerDecisionRoute } from './owner-decisions.ts';
import { fileRoute } from './file-routes.ts';
import { councilResearchRoute, COUNCIL_RESEARCH_READ_TOOLS } from './council-research-wire.ts';
import { bodySchema, readSchema, operationSchema, keySchema, Fault, ROOM, failure, metadata, type Envelope } from './contracts.ts';
import type { Env } from './db.ts';
import { Workroom } from './domain.ts';
import { wakeAuthFrom } from './notify.ts';
import { mcpHandler } from './mcp.ts';
import { HTML, BROWSER } from '../ui/page.ts';
import { taskRoute } from './task-routes.ts';
import { claimViewsRoute } from './claim-views-route.ts';
import { batchRoute } from './batch-routes.ts';
import { g2Route } from './g2-routes.ts';
import { RECEIPT_READ_TOOLS, receiptsRoute } from './receipts-wire.ts';
import { STATUS_READ_TOOLS, statusRoute } from './iw01-status-wire.ts';
import { CONTEXT_COMPILE_READ_TOOLS } from './p5-context-wire.ts';
import { RESEARCH_APPLICABILITY_READ_TOOLS } from './research-applicability-wire.ts';
import { dispatchRoute } from './dispatch-wire.ts';
import { communityRoute } from './community-wire.ts';
import { intentAgentRoute } from './intent.ts';
import { decisionAgentRoute, DECISION_READ_TOOLS } from './decisions.ts';
import { gitRoute, wrgitClaim, wrgitRoute } from './wrgit/routes.ts';
import type { ArtifactsBinding } from './wrgit/artifacts-binding.ts';
import { nativeArtifacts } from './wrgit/native-artifacts.ts';

export type Identity = string | { principal: string; write: boolean };
export type Authenticate = (request: Request, env: Env) => Promise<Identity>;
export interface AppOptions { connection?: (env: Env, identity: { principal: string; write: boolean }) => Promise<unknown>; ui?: boolean; pre?: (request: Request, env: Env) => Promise<Response | null>; legacy?: (env: Env) => boolean; artifacts?: (env: Env) => ArtifactsBinding | undefined }
// MCP tools that only read. A principal without write permission may call only these.
export const READ_TOOLS = new Set(['workroom_capabilities','workroom_connection_capabilities','workroom_whoami','workroom_room_read','workroom_unread','workroom_mentions','workroom_latency_stats','workroom_memory_search','workroom_memory_view','workroom_review_prepare','workroom_context_pack','workroom_brief_get','workroom_memory_recall','workroom_fold_view','workroom_skill_grade','workroom_experience_view','workroom_webhook_get','workroom_wake_proof','workroom_unit_cost_summary','workroom_operation_get','workroom_thread_read','workroom_message_history','workroom_inbox_pull','workroom_room_export','workroom_task_get','workroom_my_queue','workroom_usage_read']);
for (const name of RECEIPT_READ_TOOLS) READ_TOOLS.add(name);
for (const name of COUNCIL_RESEARCH_READ_TOOLS) READ_TOOLS.add(name);
for (const name of STATUS_READ_TOOLS) READ_TOOLS.add(name);
for (const name of CONTEXT_COMPILE_READ_TOOLS) READ_TOOLS.add(name);
for (const name of RESEARCH_APPLICABILITY_READ_TOOLS) READ_TOOLS.add(name);
for (const name of DECISION_READ_TOOLS) READ_TOOLS.add(name);
function writesIn(text: string): boolean {
  let parsed: unknown; try { parsed = JSON.parse(text); } catch { return false; }
  return (Array.isArray(parsed) ? parsed : [parsed]).some(m => !!m && typeof m === 'object' && (m as { method?: unknown }).method === 'tools/call'
    && !READ_TOOLS.has(String((m as { params?: { name?: unknown } }).params?.name)));
}
export const MAX_BODY = 49152;
export async function boundedBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new Fault('INVALID_INPUT', 'JSON body required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new Fault('BODY_TOO_LARGE', 'Request exceeds 48 KiB.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Fault('INVALID_INPUT', 'Body must be UTF-8.'); }
}
function jsonBody(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new Fault('INVALID_INPUT', 'Invalid JSON body.'); }
}
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
export function createApp(authenticate: Authenticate, options: AppOptions = {}) {
  const ui = options.ui ?? true;
  return { async fetch(request: Request, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const meta = metadata();
    try {
      const url = new URL(request.url);
      const origin = request.headers.get('origin');
      if (ui && url.pathname === '/' && request.method === 'GET') return new Response(HTML, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
      if (ui && url.pathname === '/app.js' && request.method === 'GET') return new Response(BROWSER, { headers: { ...headers, 'Content-Type': 'application/javascript; charset=utf-8' } });
      // Pre-auth routes (OAuth consent/token/metadata) run first and enforce their own origin/CSRF policy.
      const early = await options.pre?.(request, env);
      if (early) return early;
      if (origin && origin !== url.origin) throw new Fault('FORBIDDEN', 'Origin denied.', 403);
      const identity = await authenticate(request, env);
      const principal = typeof identity === 'string' ? identity : identity.principal;
      const write = typeof identity === 'string' ? true : identity.write;
      if (!write && url.pathname !== '/mcp' && request.method !== 'GET') throw new Fault('FORBIDDEN', 'Token lacks write scope.', 403);
      // The raw binding is the native namespace. WR-GIT code sees only the adapter, and only with WRGIT_ENABLED=1.
      const artifacts = env.WRGIT_ENABLED !== '1' ? undefined : options.artifacts ? options.artifacts(env) : env.ARTIFACTS && nativeArtifacts(env.ARTIFACTS);
      const service = new Workroom(env.DB, principal, ctx ? p => ctx.waitUntil(p) : undefined, wakeAuthFrom(env), wrgitClaim(env, artifacts));
      await service.authorize();
      const connection = options.connection ? () => options.connection!(env, { principal, write }) : undefined;
      if (url.pathname === '/mcp') {
        if (request.method !== 'POST') throw new Fault('UNSUPPORTED', 'Use stateless POST /mcp.', 405);
        if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new Fault('INVALID_INPUT', 'Use application/json.', 415);
        const text = await boundedBody(request);
        if (!write && writesIn(text)) throw new Fault('FORBIDDEN', 'Token lacks write scope.', 403);
        const forwarded = new Request(request.url, { method: 'POST', headers: request.headers, body: text });
        const response = await mcpHandler(service, options.legacy?.(env) ? 'stateless' : 'reject', connection, env).fetch(forwarded);
        const secured = new Response(response.body, response);
        for (const [k, v] of Object.entries(headers)) secured.headers.set(k, v);
        return secured;
      }
      if (url.pathname === '/v1/telegram/notify') {
        if (request.method !== 'POST' || !write) throw new Fault('FORBIDDEN', 'POST with write scope only.', 403);
        const input = bodySchema.pick({ text: true }).strict().parse(jsonBody(await boundedBody(request)));
        const sent = await telegramNotify(`[${principal}] ${input.text}`, env as TelegramEnv, { fetch: (u, i) => fetch(u, i) });
        if (!sent.ok) throw new Fault(sent.error === 'TELEGRAM_NOT_CONFIGURED' ? 'UNSUPPORTED' : 'UNAVAILABLE', sent.error ?? 'Telegram failed.', sent.error === 'TELEGRAM_NOT_CONFIGURED' ? 503 : 502);
        return new Response(JSON.stringify({ ok: true, data: { sent: true }, meta }), { headers: { ...headers, 'Content-Type': 'application/json' } });
      }
      const wrapped = (value: { data: unknown; meta: object }): Envelope => ({ ok: true, data: value.data, meta: { ...meta, ...value.meta } });
      if (url.pathname === '/v1/intent' || url.pathname === '/v1/intent/diff') {
        const intentHit = await intentAgentRoute(request, url, env.DB);
        const response = Response.json(wrapped({ data: intentHit.data, meta: intentHit.meta ?? {} }), { headers });
        if (intentHit.etag) response.headers.set('ETag', intentHit.etag);
        return response;
      }
      const readJSON=async()=>{
        if(request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json') throw new Fault('INVALID_INPUT','Use application/json.',415);
        return jsonBody(await boundedBody(request));
      };
      // A write-scope token is not enough for /git writes: the member also needs can_post=1 (#83 follow-up).
      if (artifacts && url.pathname.startsWith('/git/') && request.method !== 'GET') await service.authorize(ROOM, true);
      const workspace = await wrgitRoute(env, artifacts, request, url, principal, readJSON);
      if (workspace) return Response.json(wrapped(workspace), { headers });
      const git = await gitRoute(request, url, env, artifacts, principal, readJSON);
      if (git) return Response.json(wrapped(git), { headers });
      const ownerDecided = await ownerDecisionRoute(service, request, url);
      if (ownerDecided) return Response.json(wrapped({ data: ownerDecided.data, meta: ownerDecided.meta }), { headers });
      if (url.pathname === '/v1/decisions') {
        const decided = await decisionAgentRoute(service, request, url, readJSON);
        return Response.json(wrapped({ data: decided.data, meta: decided.meta ?? {} }), { headers });
      }
      const file=await fileRoute(service,env,request,url,readJSON);
      if(file instanceof Response) return file;
      if(file) return Response.json(wrapped(file),{headers});
      const conversation=await batchRoute(service,request,url,readJSON)??await taskRoute(service,request,url,readJSON)??await claimViewsRoute(service,request,url)??await g2Route(service,request,url,readJSON)??await receiptsRoute(service,request,url,readJSON)??await councilResearchRoute(service,request,url,readJSON)??await dispatchRoute(service,env,request,url,readJSON)??await statusRoute(service,request,url,readJSON)??await communityRoute(service,env,request,url,readJSON);
      let body: Envelope;
      if(conversation) body=wrapped(conversation);
      else if (connection && request.method === 'GET' && url.pathname === '/connection/capabilities') body = { ok: true, data: await connection(), meta };
      else if (request.method === 'GET' && url.pathname === '/api/v1/capabilities') body = { ok: true, data: await service.capabilities(), meta };
      else if (request.method === 'GET' && url.pathname === '/api/v1/me') body = { ok: true, data: await service.whoami(), meta };
      else if (/^\/api\/v1\/rooms\/[^/]+\/messages$/.test(url.pathname)) {
        const room = decodeURIComponent(url.pathname.split('/')[4]!);
        if (request.method === 'GET') {
          const params = Object.fromEntries(url.searchParams);
          if (Object.keys(params).some(k => !['cursor', 'limit'].includes(k)) || [...url.searchParams.keys()].length !== Object.keys(params).length)
            throw new Fault('INVALID_INPUT', 'Unsupported query parameters.');
          body = wrapped(await service.read(readSchema.parse({ schema_version: '1', room, ...params,
            limit: params.limit === undefined ? 50 : Number(params.limit) })));
        } else if (request.method === 'POST') {
          if (url.search) throw new Fault('INVALID_INPUT', 'No query parameters for posts.');
          if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new Fault('INVALID_INPUT', 'Use application/json.', 415);
          const input = bodySchema.parse(jsonBody(await boundedBody(request)));
          body = wrapped(await service.post({ ...input, room, idempotency_key: keySchema.parse(request.headers.get('idempotency-key')) }));
        } else throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
      } else if (request.method === 'GET' && /^\/api\/v1\/operations\/[^/]+\/[^/]+$/.test(url.pathname)) {
        const parts = url.pathname.split('/');
        const input = operationSchema.parse({ schema_version: '1', operation: decodeURIComponent(parts[4]!), idempotency_key: decodeURIComponent(parts[5]!) });
        body = wrapped(await service.operation(input.idempotency_key,input.operation));
      } else throw new Fault('NOT_FOUND', 'Endpoint not found.', 404);
      return Response.json(body, { headers });
    } catch (e) {
      const { body, status } = failure(e, meta);
      return Response.json(body, { status, headers: { ...headers,
        ...(status === 429 ? { 'Retry-After': String(body.error.retry_after) } : {}) } });
    }
  } };
}

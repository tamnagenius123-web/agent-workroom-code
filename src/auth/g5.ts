import { Fault, ROOM } from '../server/contracts.ts';
import type { Env, Database } from '../server/db.ts';
import type { Identity } from '../server/app.ts';
import { ConnectionAuthority, type Assertion } from '../connection/authority.ts';
import { endpoint } from '../connection/policy.ts';
import { verifyPassword, needsRehash, hashPassword } from './password.ts';
import { b64url, fromB64url, hmac, random, sha256, same } from './crypto.ts';
import { headerBearer, isAgentToken, queryCarriesWrk, readAgentCredential, recordAgentCredentialUse } from './agent-credential.ts';

export interface G5Env extends Env {
  WORKROOM_RESOURCE?: string; WORKROOM_INGRESS_ID?: string; OWNER_PASSWORD_HASH?: string;
  OWNER_EMAIL?: string; WORKROOM_TOKEN_PEPPER?: string; MCP_COMPAT?: string;
}
export interface Config { resource: string; issuer: string; ingress: string; ownerHash: string; pepper: string }
export const ACCESS_TTL = 3600_000, REFRESH_TTL = 30 * 86400_000, CODE_TTL = 60_000, ASSERTION_TTL = 300_000;
export const G5_SCOPES = ['workroom.read', 'workroom.write', 'offline_access'] as const;
const G4_SCOPES = ['connection.identity', 'room.read'] as const;
const noStore = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

export function config(env: G5Env): Config | null {
  const { WORKROOM_RESOURCE: r, WORKROOM_INGRESS_ID: i, OWNER_PASSWORD_HASH: h, WORKROOM_TOKEN_PEPPER: p } = env;
  if (!r || !i || !h || !p || p.length < 32 || !env.DB) return null;
  if (!/^pbkdf2c?-sha256\$\d+\$[A-Za-z0-9_-]{22,}\$[A-Za-z0-9_-]{43}$/.test(h)) return null;
  try { const u = endpoint(r); return { resource: u.href, issuer: u.origin, ingress: i, ownerHash: h, pepper: p }; } catch { return null; }
}
const closed = () => new Fault('AUTH_NOT_CONFIGURED', 'Hosted authentication is not configured. API is closed.', 503);
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...noStore, ...extra } });
const oauthError = (error: string, status = 400, description?: string) => json({ error, ...(description ? { error_description: description } : {}) }, status);
const html = (body: string, status = 200, nonce?: string, formTo?: string) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Workroom consent</title><body style="font-family:sans-serif;max-width:40em;margin:2em auto;padding:0 1em">${body}</body>`,
  { status, headers: { ...noStore, 'Referrer-Policy': 'same-origin', 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline';${nonce ? ` script-src 'nonce-${nonce}';` : ''} form-action 'self'${formTo ? ' ' + formTo : ''}; frame-ancestors 'none'`, 'X-Frame-Options': 'DENY' } });
// form-action must include the client's exact registered redirect origin: Chrome applies form-action to the 302 after the POST.
// Blocks a second submit of the same form (double tap/click) without dropping the clicked button's value.
const ONCE = `document.querySelector('form').addEventListener('submit',e=>{const f=e.target;if(f.dataset.sent){e.preventDefault();return;}f.dataset.sent='1';setTimeout(()=>{for(const b of f.querySelectorAll('button'))b.disabled=true;const m=document.getElementById('sending');if(m)m.hidden=false;},0);});`;
const restart = (what: string) => `<p>${what}</p><p>Return to ChatGPT or Muse and start the connection again. You can close this tab.</p>`;
const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

interface Client { client_id: string; principal_id: string; subject_kind: 'agent' | 'user'; redirect_uris_json: string; secret_hash: string; credential_version: number; scopes_json: string; active: number }
interface Token { token_hash: string; kind: 'access' | 'refresh'; family_id: string; client_id: string; principal_id: string; credential_version: number; aud: string; scopes_json: string; issued_at: number; expires_at: number; revoked_at: number | null; replaced_by: string | null }
const client = (db: Database, id: string) => db.prepare('SELECT * FROM oauth_clients WHERE client_id=? AND active=1').bind(id).first<Client>();
async function audit(db: Database, action: string, decision: 'allow' | 'deny', reason: string, principal: string | null, clientId: string | null, scopes: ScopeReport | null = null) {
  await db.prepare('INSERT INTO auth_audit(request_id,action,decision,reason,principal_id,client_id,at,scopes_json) VALUES (?,?,?,?,?,?,?,?)')
    .bind(random(12), action, decision, reason, principal, clientId, Date.now(), scopes ? JSON.stringify(scopes) : null).all();
}
// Scope names only; anything that does not look like a scope token is replaced so logs never carry arbitrary request data.
export interface ScopeReport { requested: string[]; granted: string[]; dropped: string[]; rejected: string[] }
const scopeName = (s: string) => /^[A-Za-z0-9._:-]{1,64}$/.test(s) ? s : '[invalid-scope-token]';
const WORKROOM_SCOPES = ['workroom.read', 'workroom.write'];
// Rev 6: non-workroom scopes (openid, profile, email, ..., and offline_access when the client lacks it) are dropped;
// unknown workroom.* scopes reject; grant = request ∩ client allowlist, always including workroom.read; empty -> client default.
export function scopeSet(raw: string | null, allowed: string[]): ScopeReport & { ok: boolean } {
  const requested = raw === null ? [] : [...new Set(raw.trim().split(/\s+/).filter(Boolean))].slice(0, 32);
  const rejected = requested.filter(s => s.startsWith('workroom.') && !WORKROOM_SCOPES.includes(s));
  const dropped = requested.filter(s => !rejected.includes(s) && !allowed.includes(s));
  let granted = requested.filter(s => allowed.includes(s));
  if (!granted.length) granted = [...allowed];
  else if (!granted.includes('workroom.read') && allowed.includes('workroom.read')) granted = ['workroom.read', ...granted];
  // Clients allowed offline_access always get it (refresh tokens), even when not requested.
  if (allowed.includes('offline_access') && !granted.includes('offline_access')) granted = [...granted, 'offline_access'];
  const report = { requested: requested.map(scopeName), granted, dropped: dropped.map(scopeName), rejected: rejected.map(scopeName) };
  return { ...report, ok: rejected.length === 0 && granted.includes('workroom.read') };
}

// ---- Discovery ----
function metadata(c: Config, path: string): Response | null {
  if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')
    return json({ resource: c.resource, authorization_servers: [c.issuer], bearer_methods_supported: ['header'], scopes_supported: [...G5_SCOPES], resource_name: 'Agent Workroom' });
  if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration')
    return json({ issuer: c.issuer, authorization_endpoint: c.issuer + '/oauth/authorize', token_endpoint: c.issuer + '/oauth/token',
      revocation_endpoint: c.issuer + '/oauth/revoke', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], scopes_supported: [...G5_SCOPES] });
  return null;
}

// ---- Authorize (owner consent, behind the owner password gate) ----
interface AuthzRequest { client_id: string; redirect_uri: string; code_challenge: string; state: string; scopes: string[]; resource: string }
async function parseAuthz(c: Config, db: Database, p: URLSearchParams): Promise<{ ok: AuthzRequest } | { page: Response } | { redirect: Response }> {
  const id = p.get('client_id') ?? '', redirect = p.get('redirect_uri') ?? '', cl = id ? await client(db, id) : null;
  if (!cl || !(JSON.parse(cl.redirect_uris_json) as string[]).includes(redirect)) {
    await audit(db, 'authorize_request', 'deny', 'invalid_client_or_redirect', cl?.principal_id ?? null, cl ? cl.client_id : null);
    return { page: html('<h1>Invalid client or redirect URI</h1>', 400) };
  }
  const state = p.get('state') ?? '';
  const allowed = JSON.parse(cl.scopes_json) as string[], sc = scopeSet(p.get('scope'), allowed);
  const report: ScopeReport = { requested: sc.requested, granted: sc.ok ? sc.granted : [], dropped: sc.dropped, rejected: sc.rejected };
  const back = async (error: string) => { await audit(db, 'authorize_request', 'deny', error, cl.principal_id, cl.client_id, report); const u = new URL(redirect); u.searchParams.set('error', error); if (state) u.searchParams.set('state', state); u.searchParams.set('iss', c.issuer); return { redirect: Response.redirect(u.href, 302) }; };
  if (p.get('response_type') !== 'code') return await back('unsupported_response_type');
  const challenge = p.get('code_challenge') ?? '';
  if (p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return await back('invalid_request');
  const resource = p.get('resource');
  if (resource !== null && resource !== c.resource && resource !== c.issuer) return await back('invalid_target');
  if (!sc.ok) return await back('invalid_scope');
  if (state.length > 512) return await back('invalid_request');
  const scopes = sc.granted;
  await audit(db, 'authorize_request', 'allow', 'CONSENT_SHOWN', cl.principal_id, cl.client_id, report);
  return { ok: { client_id: id, redirect_uri: redirect, code_challenge: challenge, state, scopes, resource: c.resource } };
}
export const LOCK_FAILURES = 5, LOCK_WINDOW = 15 * 60_000, LOCK_TIME = 15 * 60_000, FLOW_TTL = 600_000;
async function formToken(c: Config, r: AuthzRequest, flow: string): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ ...r, flow, exp: Date.now() + FLOW_TTL })));
  return payload + '.' + await hmac(c.pepper, 'consent:' + payload);
}
// Server-side single-use consent record (rev 5; replaces the flow cookie). Concurrent flows each get their own row.
async function newFlow(c: Config, db: Database, r: AuthzRequest): Promise<string> {
  const flow = random(24), now = Date.now();
  await db.prepare('DELETE FROM consent_flows WHERE expires_at<?').bind(now - 86400_000).all();
  await db.prepare('INSERT INTO consent_flows(flow_hash,client_id,redirect_uri,code_challenge,expires_at,used_at) VALUES (?,?,?,?,?,NULL)')
    .bind(await hmac(c.pepper, 'flow:' + flow), r.client_id, r.redirect_uri, r.code_challenge, now + FLOW_TTL).all();
  return flow;
}
// R2: lockout is per requester (HMAC of CF-Connecting-IP, never stored raw), so one bad actor cannot lock the owner out.
// A high global backstop (owner_gate) still bounds distributed guessing.
export const GLOBAL_LOCK_FAILURES = 50;
async function requesterKey(request: Request, c: Config) {
  return hmac(c.pepper, 'gate:' + (request.headers.get('cf-connecting-ip') ?? 'unknown'));
}
// Charge-first admission (review fixes 6c03062, then Codex c98873cb/17ea0f72): every password attempt atomically
// reserves a requester slot before verification, so N concurrent attempts from one requester cannot all pass a
// check-then-verify gap. The global (owner_gate) slot is reserved IN THE SAME BATCH but only when the requester row
// admits the attempt, so a locally locked/over-limit requester can never spend the global verification budget.
// An attempt is admitted only if, after its own increments, neither counter is over its limit and neither is locked.
// A counter restarts when its window expired or its lock has lapsed. The returned Reservation names each window
// (window_start) and whether this attempt set that counter's lock, so a success refund touches only its own slot.
export interface Slot { window_start: number; set_lock: number }
export interface Reservation { key: string; requester: Slot; global: Slot }
const RESTART = (now: number) => `window_start<=${now - LOCK_WINDOW} OR (locked_until>0 AND locked_until<=${now})`;
export async function admit(db: Database, key: string, now: number): Promise<Reservation | null> {
  const okReq = `EXISTS (SELECT 1 FROM requester_gate WHERE key_hash=? AND failures<=${LOCK_FAILURES} AND locked_until<=${now})`;
  const upsert = (table: string, col: string, sel: string) => `INSERT INTO ${table}(${col},failures,window_start,locked_until) ${sel}
      ON CONFLICT(${col}) DO UPDATE SET failures=CASE WHEN ${RESTART(now)} THEN 1 ELSE failures+1 END,
        window_start=CASE WHEN ${RESTART(now)} THEN ${now} ELSE window_start END,
        locked_until=CASE WHEN locked_until>0 AND locked_until<=${now} THEN 0 ELSE locked_until END
      RETURNING failures, locked_until, window_start`;
  const res = await db.batch<{ failures: number; locked_until: number; window_start: number }>([
    db.prepare(upsert('requester_gate', 'key_hash', `VALUES (?,1,${now},0)`)).bind(key),
    db.prepare(upsert('owner_gate', 'id', `SELECT 'owner',1,${now},0 WHERE ${okReq}`)).bind(key),
    db.prepare(`UPDATE owner_gate SET locked_until=? WHERE id='owner' AND failures>=? AND locked_until=0 AND ${okReq}`).bind(now + LOCK_TIME, GLOBAL_LOCK_FAILURES, key),
    db.prepare('UPDATE requester_gate SET locked_until=? WHERE key_hash=? AND failures>=? AND locked_until=0').bind(now + LOCK_TIME, key, LOCK_FAILURES)]);
  const r = res[0]?.results[0], o = res[1]?.results[0];
  if (!r || !o || r.locked_until > now || r.failures > LOCK_FAILURES || o.locked_until > now || o.failures > GLOBAL_LOCK_FAILURES) return null;
  // This attempt set a lock iff it was the limit-th admitted slot of that window (later ones see the lock and are rejected).
  const lock = (n: number, limit: number) => n === limit ? now + LOCK_TIME : 0;
  return { key, requester: { window_start: r.window_start, set_lock: lock(r.failures, LOCK_FAILURES) }, global: { window_start: o.window_start, set_lock: lock(o.failures, GLOBAL_LOCK_FAILURES) } };
}
// Success refund: return exactly this reservation's slot in each counter, only if that counter is still in the same
// window, and clear a lock only if it is the exact lock this reservation set. Never resets other attempts' charges.
export const refund = (db: Database, r: Reservation) => {
  const sql = (table: string, col: string) => `UPDATE ${table} SET failures=MAX(0,failures-1), locked_until=CASE WHEN ?>0 AND locked_until=? THEN 0 ELSE locked_until END WHERE ${col}=? AND window_start=?`;
  return db.batch([db.prepare(sql('requester_gate', 'key_hash')).bind(r.requester.set_lock, r.requester.set_lock, r.key, r.requester.window_start),
    db.prepare(sql('owner_gate', 'id')).bind(r.global.set_lock, r.global.set_lock, 'owner', r.global.window_start)]);
};
async function consentPage(c: Config, r: AuthzRequest, principal: string, flow: string, note = '', status = 200): Promise<Response> {
  const token = await formToken(c, r, flow), nonce = random(16);
  const page = html(`<h1>Authorize agent access</h1>${note ? `<p style="color:#b00">${esc(note)}</p>` : ''}<p>Issue a Workroom token to <b>${esc(principal)}</b> (client <code>${esc(r.client_id)}</code>).</p>
<p>Scopes: <code>${esc(r.scopes.join(' '))}</code></p><p>Redirect: <code>${esc(r.redirect_uri)}</code></p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="consent" value="${esc(token)}">
<p><label>Owner password <input type="password" name="password" autocomplete="current-password"></label></p>
<button name="decision" value="approve">Approve</button> <button name="decision" value="deny">Deny</button><p id="sending" hidden>Submitting… please wait, do not press again.</p></form><script nonce="${nonce}">${ONCE}</script>`, status, nonce, new URL(r.redirect_uri).origin);
  return page;
}
// Origin must be our exact issuer origin. Browsers send Origin "null" (e.g. a form POST from a page with
// Referrer-Policy no-referrer, some in-app webviews) or omit it; then require Sec-Fetch-Site same-origin or a
// same-origin Referer. A cross-site Sec-Fetch-Site always rejects. The signed form + single-use D1 consent flow stay mandatory.
export function sameOriginPost(request: Request, issuer: string): boolean {
  const origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return false;
  if (origin !== null && origin !== 'null') return origin === issuer;
  if (site === 'same-origin') return true;
  const referer = request.headers.get('referer');
  if (!referer) return false;
  try { return new URL(referer).origin === issuer; } catch { return false; }
}
// A resubmitted consent (double tap, back button, stale tab) never issues a second code. The original redirect
// already carried the code, so this page just tells the owner to return to the app.
function alreadyDone(outcome: string | null): Response {
  if (outcome === 'approved') return html('<h1>Already approved ✓</h1><p>This request was already approved and the app received its authorization. Return to ChatGPT or Muse; you do not need to submit again. You can close this tab.</p><p>If the app still shows it is not connected, start the connection again from the app.</p>', 409);
  if (outcome === 'denied') return html('<h1>Already denied</h1>' + restart('This request was already denied.'), 409);
  return html('<h1>Already submitted</h1>' + restart('This consent page was already used.'), 409);
}
async function authorize(request: Request, c: Config, db: Database): Promise<Response> {
  if (request.method === 'GET') {
    const parsed = await parseAuthz(c, db, new URL(request.url).searchParams);
    if (!('ok' in parsed)) return 'page' in parsed ? parsed.page : parsed.redirect;
    const cl = (await client(db, parsed.ok.client_id))!;
    return consentPage(c, parsed.ok, cl.principal_id, await newFlow(c, db, parsed.ok));
  }
  if (request.method !== 'POST') return html('<h1>Method not allowed</h1>', 405);
  // CSRF: same-origin request policy, HMAC-signed form, and a single-use server-side consent flow; approval also needs the owner password.
  if (!sameOriginPost(request, c.issuer)) return html('<h1>Cross-site request denied</h1>', 403);
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') return html('<h1>Bad form</h1>', 415);
  const form = new URLSearchParams((await request.text()).slice(0, 8192));
  const [payload, sig] = (form.get('consent') ?? '').split('.');
  if (!payload || !sig || !same(sig, await hmac(c.pepper, 'consent:' + payload))) return (html('<h1>Invalid consent form</h1>', 400));
  const r = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as AuthzRequest & { flow: string; exp: number };
  if (r.exp < Date.now()) return html('<h1>This consent page expired</h1>' + restart('Consent pages are valid for 10 minutes.'), 400);
  const flowHash = await hmac(c.pepper, 'flow:' + r.flow);
  const fl = await db.prepare('SELECT * FROM consent_flows WHERE flow_hash=?').bind(flowHash).first<{ client_id: string; redirect_uri: string; code_challenge: string; expires_at: number; used_at: number | null; outcome: string | null }>();
  if (!fl || fl.client_id !== r.client_id || fl.redirect_uri !== r.redirect_uri || fl.code_challenge !== r.code_challenge)
    return html('<h1>Unknown consent request</h1>' + restart('This consent page is not recognised.'), 400);
  if (fl.used_at !== null) return alreadyDone(fl.outcome);
  if (fl.expires_at <= Date.now()) return html('<h1>This consent page expired</h1>' + restart('Consent pages are valid for 10 minutes.'), 400);
  const cl = await client(db, r.client_id);
  if (!cl || !(JSON.parse(cl.redirect_uris_json) as string[]).includes(r.redirect_uri)) return (html('<h1>Client no longer valid</h1>', 400));
  let email = 'owner';
  if (form.get('decision') === 'approve') {
    const now = Date.now(), gateKey = await requesterKey(request, c);
    const slot = await admit(db, gateKey, now);
    if (!slot) { await audit(db, 'authorize', 'deny', 'RATE_LIMITED', cl.principal_id, cl.client_id); return (html('<h1>Too many failed attempts; try again later</h1>', 429)); }
    const ownerHash = await currentOwnerHash(db, c);
    if (!await verifyPassword(form.get('password') ?? '', ownerHash)) {
      await audit(db, 'authorize', 'deny', 'UNAUTHENTICATED', cl.principal_id, cl.client_id);
      return consentPage(c, { client_id: r.client_id, redirect_uri: r.redirect_uri, code_challenge: r.code_challenge, state: r.state, scopes: r.scopes, resource: r.resource }, cl.principal_id, r.flow, 'Wrong password.', 401);
    }
    await refund(db, slot);
    if (needsRehash(ownerHash)) await upgradeOwnerHash(db, c, form.get('password') ?? '');
    email = 'owner-password';
  }
  const outcome = form.get('decision') === 'approve' ? 'approved' : 'denied';
  const consumed = await db.prepare('UPDATE consent_flows SET used_at=?, outcome=? WHERE flow_hash=? AND used_at IS NULL RETURNING flow_hash').bind(Date.now(), outcome, flowHash).first();
  if (!consumed) return alreadyDone((await db.prepare('SELECT outcome FROM consent_flows WHERE flow_hash=?').bind(flowHash).first<{ outcome: string | null }>())?.outcome ?? null);
  const u = new URL(r.redirect_uri);
  if (form.get('decision') !== 'approve') {
    await audit(db, 'authorize', 'deny', 'FORBIDDEN', cl.principal_id, cl.client_id);
    u.searchParams.set('error', 'access_denied');
  } else {
    const code = random(32);
    await db.prepare('INSERT INTO oauth_codes(code_hash,client_id,principal_id,redirect_uri,code_challenge,resource,scopes_json,approved_by,expires_at,used_at) VALUES (?,?,?,?,?,?,?,?,?,NULL)')
      .bind(await hmac(c.pepper, 'code:' + code), cl.client_id, cl.principal_id, r.redirect_uri, r.code_challenge, r.resource, JSON.stringify(r.scopes), email, Date.now() + CODE_TTL).all();
    await audit(db, 'authorize', 'allow', 'OK', cl.principal_id, cl.client_id);
    u.searchParams.set('code', code);
  }
  if (r.state) u.searchParams.set('state', r.state);
  u.searchParams.set('iss', c.issuer);
  // 200 + meta refresh instead of 302: CSP form-action covers every hop of a POST's redirect chain, which blocked callbacks
  // whose host redirects again (seen with agent.meta.ai). A meta-refresh navigation is not subject to form-action.
  const to = esc(u.href);
  return html(`<meta http-equiv="refresh" content="0;url=${to}"><h1>${form.get('decision') === 'approve' ? 'Approved ✓' : 'Denied'}</h1><p>Returning you to the app… If nothing happens, <a href="${to}">continue</a>.</p>`);
}

// ---- Token / revoke (client authenticated) ----
// Client authentication (RFC 6749 §2.3.1). Basic credentials are form-urlencoded before base64, so they are URL-decoded.
// Clients that do not encode send a raw "client:muse:secret"; that is resolved by matching a known client id as the prefix.
// Returns the client (or null) plus the auth method used, for the audit (method name only, never credentials).
const pct = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return null; } };
async function authClient(request: Request, form: URLSearchParams, c: Config, db: Database): Promise<{ cl: Client | null; method: string; id: string | null }> {
  let why = 'unknown_client';
  const check = async (id: string | null, secret: string | null) => {
    secret = secret?.trim() ?? null;
    if (!id) return null;
    const cl = await client(db, id.trim());
    if (!cl) return null;
    if (!secret) { why = 'missing_secret'; return null; }
    if (same(cl.secret_hash, await hmac(c.pepper, 'client:' + secret))) return cl;
    // Shape only (never the value): length and whether it has the issued 'wrc_' prefix.
    why = `secret_mismatch(len=${secret.length},wrc=${secret.startsWith('wrc_') ? 1 : 0})`; return null;
  };
  const header = request.headers.get('authorization');
  const m = header?.match(/^\s*basic\s+(\S+)\s*$/i);
  if (m) {
    let raw: string;
    try { raw = atob(m[1]!); } catch { return { cl: null, method: 'basic_malformed', id: null }; }
    const i = raw.indexOf(':');
    if (i > 0) {
      const id = pct(raw.slice(0, i)), cl = await check(id, pct(raw.slice(i + 1)));
      if (cl) return { cl, method: 'basic', id };
    }
    // Unencoded id containing ':' (e.g. "client:muse:secret"): try every split point whose prefix is a known client id.
    for (let j = raw.indexOf(':'); j > 0; j = raw.indexOf(':', j + 1)) {
      if (j === i) continue;
      const cl = await check(raw.slice(0, j), raw.slice(j + 1));
      if (cl) return { cl, method: 'basic_raw', id: cl.client_id };
    }
    const fid = form.get('client_id');
    if (fid && form.get('client_secret')) { const cl = await check(fid, form.get('client_secret')); if (cl) return { cl, method: 'post_with_bad_basic', id: fid }; }
    return { cl: null, method: 'basic:' + why, id: i > 0 ? pct(raw.slice(0, i)) : null };
  }
  const id = form.get('client_id');
  if (form.get('client_secret') !== null) { const cl = await check(id, form.get('client_secret')); return { cl, method: 'post:' + why, id }; }
  if (id && await client(db, id)) why = 'missing_secret';
  return { cl: null, method: 'none:' + why, id };
}
async function issue(c: Config, db: Database, cl: Client, scopes: string[], family = random(16), refreshExpiry = Date.now() + REFRESH_TTL) {
  const now = Date.now(), access = 'wra_' + random(32), refresh = scopes.includes('offline_access') ? 'wrr_' + random(32) : null;
  const ins = 'INSERT INTO oauth_tokens(token_hash,kind,family_id,client_id,principal_id,credential_version,aud,scopes_json,issued_at,expires_at,revoked_at,replaced_by) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)';
  const accessHash = await hmac(c.pepper, 'token:' + access);
  const statements = [db.prepare(ins).bind(accessHash, 'access', family, cl.client_id, cl.principal_id, cl.credential_version, c.resource, JSON.stringify(scopes), now, now + ACCESS_TTL)];
  let refreshHash: string | null = null;
  if (refresh) { refreshHash = await hmac(c.pepper, 'token:' + refresh); statements.push(db.prepare(ins).bind(refreshHash, 'refresh', family, cl.client_id, cl.principal_id, cl.credential_version, c.resource, JSON.stringify(scopes), now, refreshExpiry)); }
  await db.batch(statements);
  return { body: { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, scope: scopes.join(' '), ...(refresh ? { refresh_token: refresh } : {}) }, refreshHash };
}
const revokeFamily = (db: Database, family: string) => db.prepare('UPDATE oauth_tokens SET revoked_at=? WHERE family_id=? AND revoked_at IS NULL').bind(Date.now(), family).all();
async function formOf(request: Request): Promise<URLSearchParams | null> {
  if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') return null;
  const text = await request.text();
  return text.length > 8192 ? null : new URLSearchParams(text);
}
async function token(request: Request, c: Config, db: Database): Promise<Response> {
  const form = await formOf(request);
  if (!form) return oauthError('invalid_request');
  const { cl, method, id } = await authClient(request, form, c, db);
  if (!cl) { await audit(db, 'token', 'deny', 'UNAUTHENTICATED:' + method, null, id && /^[A-Za-z0-9._:-]{1,64}$/.test(id) ? id : null); return oauthError('invalid_client', 401); }
  const grant = form.get('grant_type');
  if (grant === 'authorization_code') {
    const code = form.get('code') ?? '', verifier = form.get('code_verifier') ?? '';
    const row = await db.prepare('UPDATE oauth_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL RETURNING *').bind(Date.now(), await hmac(c.pepper, 'code:' + code))
      .first<{ client_id: string; redirect_uri: string; code_challenge: string; resource: string; scopes_json: string; expires_at: number }>();
    const resource = form.get('resource'), family = await hmac(c.pepper, 'family:' + code);
    if (!row) await revokeFamily(db, family); // replayed code: revoke tokens already issued from it (OAuth 2.1 §4.1.3)
    if (!row || row.expires_at <= Date.now() || row.client_id !== cl.client_id || row.redirect_uri !== form.get('redirect_uri')
      || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !same(await sha256(verifier), row.code_challenge) || resource !== null && resource !== c.resource && resource !== c.issuer) {
      await audit(db, 'token', 'deny', 'INVALID_INPUT', cl.principal_id, cl.client_id); return oauthError('invalid_grant');
    }
    const out = await issue(c, db, cl, JSON.parse(row.scopes_json) as string[], family);
    await audit(db, 'token', 'allow', 'OK', cl.principal_id, cl.client_id);
    return json(out.body);
  }
  if (grant === 'refresh_token') {
    const hash = await hmac(c.pepper, 'token:' + (form.get('refresh_token') ?? ''));
    const row = await db.prepare("SELECT * FROM oauth_tokens WHERE token_hash=? AND kind='refresh'").bind(hash).first<Token>();
    if (!row || row.client_id !== cl.client_id) { await audit(db, 'refresh', 'deny', 'INVALID_INPUT', cl.principal_id, cl.client_id); return oauthError('invalid_grant'); }
    if (row.revoked_at !== null || row.replaced_by !== null) { await revokeFamily(db, row.family_id); await audit(db, 'refresh', 'deny', 'VERSION_CONFLICT', row.principal_id, cl.client_id); return oauthError('invalid_grant'); }
    if (row.expires_at <= Date.now() || row.credential_version !== cl.credential_version) { await audit(db, 'refresh', 'deny', 'UNAUTHENTICATED', row.principal_id, cl.client_id); return oauthError('invalid_grant'); }
    const claim = await db.prepare("UPDATE oauth_tokens SET replaced_by='pending' WHERE token_hash=? AND replaced_by IS NULL AND revoked_at IS NULL RETURNING token_hash").bind(hash).first();
    if (!claim) { await revokeFamily(db, row.family_id); return oauthError('invalid_grant'); }
    const out = await issue(c, db, cl, JSON.parse(row.scopes_json) as string[], row.family_id, row.expires_at);
    await db.prepare('UPDATE oauth_tokens SET replaced_by=? WHERE token_hash=?').bind(out.refreshHash ?? 'none', hash).all();
    await audit(db, 'refresh', 'allow', 'OK', row.principal_id, cl.client_id);
    return json(out.body);
  }
  return oauthError('unsupported_grant_type');
}
async function revoke(request: Request, c: Config, db: Database): Promise<Response> {
  const form = await formOf(request);
  if (!form) return oauthError('invalid_request');
  const { cl } = await authClient(request, form, c, db);
  if (!cl) return oauthError('invalid_client', 401);
  const row = await db.prepare('SELECT * FROM oauth_tokens WHERE token_hash=?').bind(await hmac(c.pepper, 'token:' + (form.get('token') ?? ''))).first<Token>();
  if (row && row.client_id === cl.client_id) {
    if (row.kind === 'refresh') await revokeFamily(db, row.family_id);
    else await db.prepare('UPDATE oauth_tokens SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').bind(Date.now(), row.token_hash).all();
    await audit(db, 'revoke', 'allow', 'OK', row.principal_id, cl.client_id);
  }
  return new Response(null, { status: 200, headers: noStore });
}

// ---- Pre-auth routes for the production Worker ----
export async function g5Routes(request: Request, env: G5Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/.well-known/') && !path.startsWith('/oauth/')) return null;
  const c = config(env);
  if (!c) throw closed();
  const meta = metadata(c, path);
  if (meta) return meta;
  if (path === '/oauth/authorize') return authorize(request, c, env.DB);
  if (path === '/oauth/token') return token(request, c, env.DB);
  if (path === '/oauth/revoke') return revoke(request, c, env.DB);
  throw new Fault('NOT_FOUND', 'Endpoint not found.', 404);
}

// ---- Resource authentication through the G4 authority ----
export async function g5Authenticate(request: Request, env: G5Env): Promise<Identity> {
  if (queryCarriesWrk(request.url)) throw new Fault('UNAUTHENTICATED', 'Connection identity could not be verified.', 401);
  const presented = headerBearer(request.headers.get('authorization'));
  const c = config(env);
  if (presented && isAgentToken(presented)) {
    if (!c) throw closed();
    if (new URL(request.url).origin !== c.issuer) throw new Fault('FORBIDDEN', 'Connection origin denied.', 403);
    const row = await readAgentCredential(env.DB, presented, Date.now());
    if (!row) throw new Fault('UNAUTHENTICATED', 'Connection identity could not be verified.', 401);
    // Usage signal for the wrk_ lane, at parity with the OAuth resource
    // audit below: a throttled last_used_at stamp plus an auth_audit row.
    // Both carry only the non-secret key_id; the audit client_id slot holds
    // the key_id so a row names the credential that was used.
    await recordAgentCredentialUse(env.DB, row.key_id, Date.now());
    await audit(env.DB, 'resource:agent_credential', 'allow', 'OK', row.principal_id, row.key_id);
    return { principal: row.principal_id, write: row.scopes.includes('workroom.write') };
  }
  if (!c) throw closed();
  const db = env.DB;
  let tokenScopes: string[] = [], clientId: string | null = null;
  const authority = new ConnectionAuthority(db, {
    resource: c.resource, ingress_id: c.ingress, issuers: [c.issuer],
    verifier: async input => {
      const bearer = headerBearer(input.headers.get('authorization'));
      if (!bearer || isAgentToken(bearer)) return null;
      const t = await db.prepare("SELECT * FROM oauth_tokens WHERE token_hash=? AND kind='access'").bind(await hmac(c.pepper, 'token:' + bearer)).first<Token>();
      const now = Date.now();
      if (!t || t.revoked_at !== null || t.expires_at <= now || t.aud !== c.resource) return null;
      const cl = await client(db, t.client_id);
      if (!cl || cl.credential_version !== t.credential_version || cl.principal_id !== t.principal_id) return null;
      tokenScopes = JSON.parse(t.scopes_json) as string[]; clientId = cl.client_id;
      const a: Assertion = { issuer: c.issuer, subject: t.principal_id, subject_kind: cl.subject_kind, credential_id: cl.client_id, credential_version: t.credential_version,
        audience: c.resource, ingress_id: c.ingress, issued_at_ms: now, not_before_ms: now, expires_at_ms: Math.min(t.expires_at, now + ASSERTION_TTL), scopes: [...G4_SCOPES] };
      return a;
    },
    bindings: async key => {
      const b = await db.prepare('SELECT * FROM principal_bindings WHERE issuer=? AND subject=? AND credential_id=?').bind(key.issuer, key.subject, key.credential_id)
        .first<Record<string, unknown> & { active: number; scopes_json: string }>();
      if (!b) return null;
      const { scopes_json, active, ...rest } = b;
      return { ...rest, active: active === 1, scopes: JSON.parse(scopes_json) as unknown };
    },
    audit: async e => audit(db, 'resource:' + e.action, e.decision, e.reason, e.principal_id, clientId),
  });
  const u = new URL(request.url);
  // G4 rejects query strings; identity does not depend on them, so verify a query-free copy. The runtime URL origin
  // (derived by the edge from the routed hostname) is checked by G4; the raw Host header adds nothing on Workers.
  const h = new Headers(request.headers); h.delete('host');
  const probe = new Request(u.origin + u.pathname, { method: request.method, headers: h });
  let ctx;
  try { ctx = await authority.check(probe, 'room.read'); }
  catch (e) {
    // Requests with no bearer at all are not audited, so anonymous traffic cannot amplify D1 writes.
    if (request.headers.has('authorization')) await audit(db, 'resource', 'deny', e instanceof Fault ? e.code : 'TEMPORARY_FAILURE', null, clientId);
    throw e;
  }
  await audit(db, 'resource', 'allow', 'OK', ctx.principal_id, clientId);
  if (ctx.room_id !== ROOM) throw new Fault('FORBIDDEN', 'Connection permission denied.', 403);
  return { principal: ctx.principal_id, write: tokenScopes.includes('workroom.write') };
}
export const wwwAuthenticate = (env: G5Env) => { const c = config(env); return c ? `Bearer resource_metadata="${c.issuer}/.well-known/oauth-protected-resource"` : null; };

export async function g5Capabilities(env: G5Env, identity: { principal: string; write: boolean }) {
  return { principal_id: identity.principal, write: identity.write, room_id: ROOM, protocol: '2026-07-28', legacy_compat: env.MCP_COMPAT === '1',
    transport: 'stateless_post_json', auth_profile: 'workroom_oauth21_pkce_v1', access_token_ttl_s: ACCESS_TTL / 1000, operational_connection: true };
}

// PBKDF2-ITER: lazy rehash. The D1 row only counts while it was derived from the current
// OWNER_PASSWORD_HASH secret (fingerprint match), so rotating the secret always wins.
async function secretFp(c: Config): Promise<string> { return hmac(c.pepper, 'owner-hash-fp:' + c.ownerHash); }
async function currentOwnerHash(db: Database, c: Config): Promise<string> {
  try {
    const row = await db.prepare('SELECT password_hash, source_hash_fp FROM owner_credential WHERE id=1').first<{ password_hash: string; source_hash_fp: string }>();
    if (row && row.source_hash_fp === await secretFp(c)) return row.password_hash;
  } catch { /* table missing before 0060 is applied: fall back to the secret */ }
  return c.ownerHash;
}
async function upgradeOwnerHash(db: Database, c: Config, password: string): Promise<void> {
  try {
    await db.prepare('INSERT INTO owner_credential(id,password_hash,source_hash_fp,updated_at) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash, source_hash_fp=excluded.source_hash_fp, updated_at=excluded.updated_at')
      .bind(await hashPassword(password), await secretFp(c), Date.now()).all();
  } catch { /* best effort: login already succeeded */ }
}

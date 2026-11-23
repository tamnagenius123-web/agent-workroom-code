import { ProtocolError, type Server } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ROOM } from './contracts.ts';
import type { Database } from './db.ts';

export const DOTS = 'agent:dots';
export const DIRECT_MENTION = 'workroom.mention.direct';
const HOUR = 3_600_000;
const MAX_TTL = 24 * HOUR;
const VERIFY_CACHE = 300_000;
const ROTATE_FOR = 300_000;
const LEASE = 60_000;
const OUTBOX_TTL = HOUR;
const MAX_ATTEMPTS = 6;
const encoder = new TextEncoder();
const grantAccess = `EXISTS (SELECT 1 FROM memberships AS m JOIN principals AS p ON p.id=m.principal_id
  WHERE m.principal_id='agent:dots' AND m.room_id='room_main' AND m.active=1 AND p.active=1)`;

type CallbackResult = { status: number | null; challenge?: string };
type SignedPost = { url: string; headers: Headers; body: string; signal: AbortSignal; verify: boolean };
type Callback = { url: string; secret: string; previous?: string; rotateUntil?: number };
type Subscription = { sealed: string | null; verified_at: number; expires_at: number };
type Delivery = { sub_id: string; message_id: string; occurred_at: string; attempts: number; grant_id: string; sealed: string };

export interface IsolatedEventsBindings {
  // Stable grant ID, validated for the supplied authenticated principal. Never return a bearer token.
  connection(request: Request, principal: string): Promise<string | null>;
  active(grant: string, principal: string, room: string): Promise<boolean>;
  // An authenticated at-rest codec, associated with the subscription ID.
  seal(id: string, value: string): Promise<string>;
  open(id: string, value: string): Promise<string>;
  // Private adapter. Enforce an approved receiver, current public DNS, pinned TLS, no redirects,
  // abort, and a bounded verification response. Do not log the request.
  send(post: SignedPost): Promise<{ status: number; challenge?: string }>;
  now?: () => number;
}

const rpcParams = z.object({}).passthrough();
const target = z.strictObject({ room: z.literal(ROOM) });
const urlSchema = z.string().max(2048);
const base = { name: z.literal(DIRECT_MENTION), arguments: target, _meta: z.record(z.string(), z.unknown()).optional() };
const subscribeInput = z.strictObject({
  ...base, delivery: z.strictObject({ mode: z.literal('webhook'), url: urlSchema, secret: z.string().max(100) }),
  cursor: z.null().optional(), ttlMs: z.number().int().positive().nullable().optional(),
});
const unsubscribeInput = z.strictObject({ ...base, delivery: z.strictObject({ mode: z.literal('webhook'), url: urlSchema }) });
const catalog = {
  name: DIRECT_MENTION,
  description: 'A newly posted message in room_main directly mentions your connected Dot. Carries message metadata only.',
  delivery: ['webhook'],
  inputSchema: { type: 'object', properties: { room: { type: 'string', const: ROOM } }, required: ['room'], additionalProperties: false },
  payloadSchema: {
    type: 'object', properties: { room: { type: 'string', const: ROOM }, message_id: { type: 'string' } },
    required: ['room', 'message_id'], additionalProperties: false,
  },
};

function callbackUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ProtocolError(-32602, 'Invalid callback URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || raw.includes('#') || url.port) {
    throw new ProtocolError(-32602, 'Invalid callback URL.');
  }
  return url.href;
}
function keyBytes(raw: string) {
  const encoded = raw.slice(6);
  if (!raw.startsWith('whsec_') || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  try {
    const binary = atob(encoded);
    if (binary.length < 24 || binary.length > 64 || btoa(binary) !== encoded) return null;
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  } catch { return null; }
}
function sameChallenge(expected: string, actual: unknown) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return difference === 0;
}
function verificationError(reason: 'challenge_failed' | 'timeout' | 'subscription_changed') {
  return new ProtocolError(-32015, 'Callback verification failed.', { reason });
}
function unavailable() {
  return new ProtocolError(-32000, 'Subscription service temporarily unavailable.');
}
function accepted(status: number | null) { return status !== null && status >= 200 && status < 300; }

export class McpEvents {
  constructor(private readonly db: Database, private readonly bindings: IsolatedEventsBindings) {}

  private now() { return this.bindings.now?.() ?? Date.now(); }

  async grant(request: Request, principal: string): Promise<string | null> {
    if (principal !== DOTS) return null;
    const grant = await this.bindings.connection(request, principal);
    return grant && await this.bindings.active(grant, DOTS, ROOM) ? grant : null;
  }

  register(server: Server, grant: string, write: boolean) {
    const capabilities = { events: {}, tools: {} };
    server.registerCapabilities(capabilities);
    server.setRequestHandler('events/list', { params: rpcParams }, () => ({ events: [catalog] }));
    server.setRequestHandler('events/subscribe', { params: rpcParams }, raw => {
      if (!write) throw new ProtocolError(-32001, 'Existing write scope is required to register delivery.');
      const input = subscribeInput.safeParse(raw);
      if (!input.success) throw new ProtocolError(-32602, 'Invalid subscription parameters.');
      return this.protect(() => this.subscribe(grant, input.data));
    });
    server.setRequestHandler('events/unsubscribe', { params: rpcParams }, raw => {
      const input = unsubscribeInput.safeParse(raw);
      if (!input.success) throw new ProtocolError(-32602, 'Invalid subscription parameters.');
      return this.protect(() => this.unsubscribe(grant, input.data.delivery.url));
    });
  }

  private async protect<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw unavailable();
    }
  }

  private async identity(grant: string, url: string) {
    const identity = JSON.stringify([DOTS, grant, url, DIRECT_MENTION, { room: ROOM }]);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(identity)));
    return 'sub_' + [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  private async callback(id: string, sealed: string): Promise<Callback> {
    return JSON.parse(await this.bindings.open(id, sealed)) as Callback;
  }

  private async send(
    callback: Callback, id: string, eventId: string, body: string, verify: boolean,
    admit?: () => Promise<'send' | 'stop' | 'retry'>,
  ): Promise<CallbackResult> {
    const now = this.now();
    const timestamp = String(Math.floor(now / 1000));
    const raw = encoder.encode(`${eventId}.${timestamp}.${body}`);
    const secrets = !verify && callback.previous && (callback.rotateUntil ?? 0) > now
      ? [callback.secret, callback.previous] : [callback.secret];
    const signatures = await Promise.all(secrets.map(async secret => {
      const material = keyBytes(secret);
      if (!material) throw unavailable();
      const key = await crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, raw));
      return 'v1,' + btoa(String.fromCharCode(...bytes));
    }));
    const headers = new Headers({
      'Content-Type': 'application/json', 'webhook-id': eventId, 'webhook-timestamp': timestamp,
      'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': id,
    });
    // A cancellation can stop a queued request up to admission. An already admitted
    // transport request can complete. The lease still fences its local result update.
    const admission = await admit?.();
    if (admission === 'stop') return { status: null };
    if (admission === 'retry') return { status: 0 };
    const signal = AbortSignal.timeout(8_000);
    try { return await this.bindings.send({ url: callback.url, headers, body, signal, verify }); }
    catch {
      if (verify) throw verificationError(signal.aborted ? 'timeout' : 'challenge_failed');
      return { status: 0 };
    }
  }

  private async subscribe(grant: string, input: z.infer<typeof subscribeInput>) {
    const url = callbackUrl(input.delivery.url);
    const secret = input.delivery.secret;
    if (!keyBytes(secret)) throw new ProtocolError(-32602, 'Invalid webhook signing key.');
    if (!(await this.bindings.active(grant, DOTS, ROOM))) throw new ProtocolError(-32001, 'Access denied.');
    const id = await this.identity(grant, url);
    const generation = crypto.randomUUID();
    const started = this.now();
    // Reserve the last-started operation. A failed refresh leaves the last verified callback active.
    const row = await this.db.prepare(`INSERT INTO mcp_event_subscriptions(id,grant_id,generation,touched_at)
      SELECT ?,?,?,? WHERE ${grantAccess}
      ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,touched_at=excluded.touched_at
      WHERE mcp_event_subscriptions.grant_id=excluded.grant_id
      RETURNING sealed,verified_at,expires_at`)
      .bind(id, grant, generation, started).first<Subscription>();
    if (!row) throw new ProtocolError(-32001, 'Access denied.');

    const old = row.sealed ? await this.callback(id, row.sealed) : null;
    const cached = old?.secret === secret && row.verified_at + VERIFY_CACHE > started;
    if (!cached) {
      const challenge = crypto.randomUUID();
      const body = JSON.stringify({ type: 'verification', challenge });
      const result = await this.send({ url, secret }, id, `verify_${crypto.randomUUID()}`, body, true);
      if (!accepted(result.status) || !sameChallenge(challenge, result.challenge)) throw verificationError('challenge_failed');
    }
    const now = this.now();
    const expires = now + Math.min(input.ttlMs ?? HOUR, MAX_TTL);
    const next: Callback = { url, secret };
    if (old && row.expires_at > now && old.secret !== secret) {
      next.previous = old.secret;
      next.rotateUntil = now + ROTATE_FOR;
    } else if (old?.previous && (old.rotateUntil ?? 0) > now) {
      next.previous = old.previous;
      next.rotateUntil = old.rotateUntil;
    }
    const sealed = await this.bindings.seal(id, JSON.stringify(next));
    if (!(await this.bindings.active(grant, DOTS, ROOM))) throw new ProtocolError(-32001, 'Access denied.');
    const saved = await this.db.prepare(`UPDATE mcp_event_subscriptions SET sealed=?,verified_at=?,expires_at=?,touched_at=?
      WHERE id=? AND generation=? AND grant_id=? AND ${grantAccess} RETURNING id`)
      .bind(sealed, cached ? row.verified_at : now, expires, now, id, generation, grant).first<{ id: string }>();
    if (!saved) throw verificationError('subscription_changed');
    return { id, refreshBefore: new Date(expires).toISOString(), cursor: null, truncated: false };
  }

  private async unsubscribe(grant: string, value: string) {
    const id = await this.identity(grant, callbackUrl(value));
    await this.db.batch([
      this.db.prepare(`DELETE FROM mcp_event_outbox WHERE sub_id IN
        (SELECT id FROM mcp_event_subscriptions WHERE id=? AND grant_id=?)`).bind(id, grant),
      this.db.prepare('DELETE FROM mcp_event_subscriptions WHERE id=? AND grant_id=?').bind(id, grant),
    ]);
    return {};
  }

  planMention(messageId: string) {
    const now = this.now();
    return this.db.prepare(`INSERT OR IGNORE INTO mcp_event_outbox
      (id,sub_id,message_id,occurred_at,created_at,next_at)
      SELECT 'evt_' || lower(hex(randomblob(16))), s.id, msg.id, msg.created_at, ?, ?
      FROM mcp_event_subscriptions s JOIN messages msg ON msg.id=? AND msg.room_id=?
      JOIN message_mentions mm ON mm.message_id=msg.id AND mm.principal_id=? AND substr(mm.via,1,1)='@'
      WHERE s.sealed IS NOT NULL AND s.expires_at>? AND ${grantAccess}`)
      .bind(now, now, messageId, ROOM, DOTS, now);
  }

  async sweep(messageId?: string) {
    const now = this.now();
    if (messageId === undefined) await this.db.batch([
      this.db.prepare('DELETE FROM mcp_event_outbox WHERE created_at<=?').bind(now - OUTBOX_TTL),
      this.db.prepare(`UPDATE mcp_event_outbox SET status='terminal',claim=NULL,lease_until=0
        WHERE status='pending' AND attempts>=? AND lease_until<=?`).bind(MAX_ATTEMPTS, now),
      this.db.prepare(`DELETE FROM mcp_event_outbox WHERE sub_id IN
        (SELECT id FROM mcp_event_subscriptions WHERE expires_at<=? AND touched_at<=?)`).bind(now, now - LEASE),
      this.db.prepare('DELETE FROM mcp_event_subscriptions WHERE expires_at<=? AND touched_at<=?').bind(now, now - LEASE),
    ]);
    const claim = crypto.randomUUID();
    const { results } = await this.db.prepare(`UPDATE mcp_event_outbox SET claim=?,lease_until=?,attempts=attempts+1
      WHERE id IN (SELECT id FROM mcp_event_outbox
        WHERE status='pending' AND next_at<=? AND lease_until<=? AND created_at>? AND attempts<?
        AND (? IS NULL OR message_id=?) ORDER BY next_at,id LIMIT 12)
      RETURNING id`)
      .bind(claim, now + LEASE, now, now, now - OUTBOX_TTL, MAX_ATTEMPTS, messageId ?? null, messageId ?? null)
      .all<{ id: string }>();
    await Promise.all(results.map(({ id }) => this.deliver(id, claim)));
  }

  private async current(id: string, claim: string) {
    const now = this.now();
    return this.db.prepare(`SELECT o.sub_id,o.message_id,o.occurred_at,o.attempts,s.grant_id,s.sealed FROM mcp_event_outbox o
      JOIN mcp_event_subscriptions s ON s.id=o.sub_id
      WHERE o.id=? AND o.claim=? AND o.lease_until>? AND o.created_at>? AND s.expires_at>?
      AND s.sealed IS NOT NULL AND ${grantAccess}`)
      .bind(id, claim, now, now - OUTBOX_TTL, now).first<Delivery>();
  }

  private async deliver(id: string, claim: string) {
    const row = await this.current(id, claim);
    let status: number | null = null;
    if (row) {
      try {
        const callback = await this.callback(row.sub_id, row.sealed);
        const body = JSON.stringify({
          eventId: id, name: DIRECT_MENTION, timestamp: row.occurred_at,
          data: { room: ROOM, message_id: row.message_id }, cursor: null,
        });
        status = (await this.send(callback, row.sub_id, id, body, false, async () => {
          if (!(await this.bindings.active(row.grant_id, DOTS, ROOM))) return 'stop';
          const latest = await this.current(id, claim);
          if (!latest) return 'stop';
          return latest.sealed === row.sealed ? 'send' : 'retry';
        })).status;
      } catch { status = 0; }
    }
    const retryable = status === 0 || status === 408 || status === 425 || status === 429 || (status !== null && status >= 500);
    const retry = retryable && row !== null && row.attempts < MAX_ATTEMPTS;
    const next = retry ? this.now() + 15_000 * 2 ** (row.attempts - 1) : 0;
    const state = retry ? 'pending' : accepted(status) ? 'accepted' : 'terminal';
    await this.db.prepare(`UPDATE mcp_event_outbox SET status=?,next_at=?,claim=NULL,lease_until=0,last_status=?
      WHERE id=? AND claim=?`).bind(state, next, status === 0 ? null : status, id, claim).all();
  }
}

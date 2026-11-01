// D1 + REST wiring for the F1a community post contract (F1b).
// The server sets post_id, room_id, actor_id (the authenticated principal) and created_at, then signs.
// parseCommunityPost is the only body validator; verifyCommunityPost checks stored rows on read.

import { Fault, keySchema } from './contracts.ts';
import type { Database } from './db.ts';
import type { Workroom } from './domain.ts';
import { SCHEMA_VERSION } from '../phase-contracts/check.ts';
import { parseCommunityPost, signCommunityPost, verifyCommunityPost, type CommunityPost } from './community.ts';

export interface CommunityEnv { COMMUNITY_SIGNING_SECRET?: string }

const ACCESS = `SELECT 1 FROM rooms r JOIN memberships m ON m.room_id=r.id JOIN principals p ON p.id=m.principal_id
  WHERE r.id=? AND r.kind='community' AND p.id=? AND p.active=1 AND m.active=1`;
const BODY_KEYS = new Set(['schema_version', 'kind', 'body']);
const PAGE = 50;

interface Row { id: string; post_json: string; sig: string; request_json: string }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
const postOf = (row: Row): CommunityPost => ({ ...JSON.parse(row.post_json) as Omit<CommunityPost, 'sig'>, sig: row.sig } as CommunityPost);

export class CommunityPosts {
  constructor(private db: Database, private principal: string, private secret: string) {}

  private async authorize(room: string, write: boolean): Promise<void> {
    if (!await this.db.prepare(ACCESS + (write ? ' AND m.can_post=1' : '')).bind(room, this.principal).first())
      throw new Fault('FORBIDDEN', 'Community room access denied.', 403);
  }

  private byKey(key: string) {
    return this.db.prepare('SELECT id, post_json, sig, request_json FROM community_posts WHERE actor_id=? AND idempotency_key=?')
      .bind(this.principal, key).first<Row>();
  }

  async create(room: string, key: string, input: Record<string, unknown>) {
    await this.authorize(room, true);
    const request = JSON.stringify(canonical({ kind: input.kind, body: input.body }));
    const replay = (row: Row, replayed: boolean) => {
      if (row.request_json !== request) throw new Fault('IDEMPOTENCY_CONFLICT', 'Key already has different post content.', 409, 'not_applied', false, { idempotency_key: key });
      return { data: { post: postOf(row), replayed }, meta: { replayed, idempotency_key: key } };
    };
    const prior = await this.byKey(key);
    if (prior) return replay(prior, true);
    const parsed = parseCommunityPost({
      schema_version: SCHEMA_VERSION, post_id: crypto.randomUUID(), room_id: room, actor_id: this.principal,
      kind: input.kind, created_at: new Date().toISOString(), body: input.body,
    });
    if (!parsed.ok) throw new Fault('INVALID_INPUT', parsed.errors.join('; '));
    const { sig, ...post } = await signCommunityPost(this.secret, parsed.value);
    await this.db.prepare(`INSERT INTO community_posts(id,room_id,actor_id,kind,post_json,sig,request_json,idempotency_key,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(actor_id, idempotency_key) DO NOTHING`)
      .bind(post.post_id, room, this.principal, post.kind, JSON.stringify(post), sig, request, key, Date.now()).all();
    const row = await this.byKey(key);
    if (!row) throw new Fault('TEMPORARY_FAILURE', 'Community post was not stored.', 503, 'unknown', true);
    return replay(row, row.id !== post.post_id);
  }

  async list(room: string) {
    await this.authorize(room, false);
    const rows = (await this.db.prepare('SELECT id, post_json, sig, request_json FROM community_posts WHERE room_id=? ORDER BY recorded_at DESC, rowid DESC LIMIT ?')
      .bind(room, PAGE).all<Row>()).results;
    const posts = await Promise.all(rows.map(async row => {
      const post = postOf(row);
      return { ...post, sig_valid: (await verifyCommunityPost(this.secret, post, post.actor_id)).ok };
    }));
    return { data: { posts }, meta: { count: posts.length } };
  }
}

export async function communityRoute(service: Workroom, env: object, request: Request, url: URL, readJSON: () => Promise<unknown>) {
  const match = /^\/api\/v1\/rooms\/([^/]+)\/community-posts$/.exec(url.pathname);
  if (!match) return null;
  const room = decodeURIComponent(match[1]!);
  const secret = (env as CommunityEnv).COMMUNITY_SIGNING_SECRET;
  if (typeof secret !== 'string' || !secret) throw new Fault('COMMUNITY_NOT_CONFIGURED', 'Community board signing is not configured.', 503);
  const posts = new CommunityPosts(service.database, service.principal, secret);
  if (url.search) throw new Fault('INVALID_INPUT', 'Unsupported query parameters.');
  if (request.method === 'GET') return posts.list(room);
  if (request.method !== 'POST') throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
  const key = keySchema.parse(request.headers.get('idempotency-key'));
  const body = await readJSON();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Fault('INVALID_INPUT', 'JSON object body required.');
  for (const field of Object.keys(body)) if (!BODY_KEYS.has(field)) throw new Fault('INVALID_INPUT', `${field} is not accepted from the body.`);
  if ((body as { schema_version?: unknown }).schema_version !== SCHEMA_VERSION) throw new Fault('INVALID_INPUT', `schema_version must be "${SCHEMA_VERSION}".`);
  return posts.create(room, key, body as Record<string, unknown>);
}

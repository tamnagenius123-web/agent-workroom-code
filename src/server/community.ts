// F1 community board posts. Pure: no clock, no I/O, no migration.
// A post's room must be kind=community; the rooms.kind column and routes land in F1b.
// veto/hold are soft norms (research/sandbox-yolo-community.md): they carry no gate authority.
// Actor binding: the server derives one HMAC key per actor from its own secret and signs the
// normalized post. A post verifies only for the session that is authenticated as its actor_id.

import { hmac, same } from '../auth/crypto.ts';
import {
  Problems, SCHEMA_VERSION, checkKeys, defined, readArray, readBool, readEnum, readId, readInt, readIso,
  readObject, readText, type PhaseCheck,
} from '../phase-contracts/check.ts';

export const COMMUNITY_KINDS = ['help_request', 'help_offer', 'method', 'assignment', 'veto', 'hold'] as const;
export type CommunityKind = typeof COMMUNITY_KINDS[number];

const URGENCIES = ['low', 'normal', 'high'] as const;
const MAX_TAGS = 16;
const MAX_STEPS = 50;
const MAX_REFS = 20;

export interface HelpRequestBody {
  unit_id: string | null;
  skill_tags: string[];
  urgency: typeof URGENCIES[number];
  budget_cap_tokens: number;
  auto_accept: boolean;
  text: string;
}
export interface HelpOfferBody {
  request_id: string;
  skill_tags: string[];
  cost_est: { tokens: number; minutes: number };
  text: string;
}
export interface MethodBody { title: string; steps: string[]; evidence_refs: string[] }
export interface AssignmentBody { assignee: string; unit_id: string; deadline: string }
export interface NormBody { target_id: string; reason: string }

interface Bodies {
  help_request: HelpRequestBody;
  help_offer: HelpOfferBody;
  method: MethodBody;
  assignment: AssignmentBody;
  veto: NormBody;
  hold: NormBody;
}

export type UnsignedCommunityPost = {
  [K in CommunityKind]: {
    schema_version: typeof SCHEMA_VERSION;
    post_id: string;
    room_id: string;
    actor_id: string;
    kind: K;
    created_at: string;
    body: Bodies[K];
  }
}[CommunityKind];

export type CommunityPost = UnsignedCommunityPost & { sig: string };

const POST_KEYS = ['schema_version', 'post_id', 'room_id', 'actor_id', 'kind', 'created_at', 'body'] as const;

function readList<T>(
  p: Problems, obj: Record<string, unknown>, key: string, path: string, max: number,
  item: (holder: Record<string, unknown>, at: string) => T | undefined,
): T[] | undefined {
  const raw = readArray(p, obj, key, path);
  if (!raw) return undefined;
  if (raw.length === 0 || raw.length > max) {
    p.add(`${path}.${key}`, `expected 1..${max} entries`);
    return undefined;
  }
  const out = raw.map((v, i) => item({ v }, `${path}.${key}[${i}]`));
  return out.every(defined) ? out : undefined;
}

const ids = (p: Problems) => (h: Record<string, unknown>, at: string) => readId(p, h, 'v', at);
const texts = (p: Problems, max: number) => (h: Record<string, unknown>, at: string) => readText(p, h, 'v', at, max);

function readBody(p: Problems, kind: CommunityKind, raw: unknown, path: string): Bodies[CommunityKind] | undefined {
  const o = readObject(p, raw, path);
  if (!o) return undefined;
  switch (kind) {
    case 'help_request': {
      checkKeys(p, o, ['unit_id', 'skill_tags', 'urgency', 'budget_cap_tokens', 'auto_accept', 'text'], path);
      const unit_id = o.unit_id === null ? null : readId(p, o, 'unit_id', path);
      const body = {
        unit_id, skill_tags: readList(p, o, 'skill_tags', path, MAX_TAGS, ids(p)),
        urgency: readEnum(p, o, 'urgency', path, URGENCIES), budget_cap_tokens: readInt(p, o, 'budget_cap_tokens', path, 1),
        auto_accept: readBool(p, o, 'auto_accept', path), text: readText(p, o, 'text', path),
      };
      return Object.values(body).every(defined) ? body as HelpRequestBody : undefined;
    }
    case 'help_offer': {
      checkKeys(p, o, ['request_id', 'skill_tags', 'cost_est', 'text'], path);
      const c = readObject(p, o.cost_est, `${path}.cost_est`);
      if (c) checkKeys(p, c, ['tokens', 'minutes'], `${path}.cost_est`);
      const tokens = c ? readInt(p, c, 'tokens', `${path}.cost_est`) : undefined;
      const minutes = c ? readInt(p, c, 'minutes', `${path}.cost_est`) : undefined;
      const body = {
        request_id: readId(p, o, 'request_id', path), skill_tags: readList(p, o, 'skill_tags', path, MAX_TAGS, ids(p)),
        cost_est: defined(tokens) && defined(minutes) ? { tokens, minutes } : undefined, text: readText(p, o, 'text', path),
      };
      return Object.values(body).every(defined) ? body as HelpOfferBody : undefined;
    }
    case 'method': {
      checkKeys(p, o, ['title', 'steps', 'evidence_refs'], path);
      const body = {
        title: readText(p, o, 'title', path, 200), steps: readList(p, o, 'steps', path, MAX_STEPS, texts(p, 1000)),
        evidence_refs: readList(p, o, 'evidence_refs', path, MAX_REFS, texts(p, 500)),
      };
      return Object.values(body).every(defined) ? body as MethodBody : undefined;
    }
    case 'assignment': {
      checkKeys(p, o, ['assignee', 'unit_id', 'deadline'], path);
      const body = { assignee: readId(p, o, 'assignee', path), unit_id: readId(p, o, 'unit_id', path), deadline: readIso(p, o, 'deadline', path) };
      return Object.values(body).every(defined) ? body as AssignmentBody : undefined;
    }
    case 'veto':
    case 'hold': {
      checkKeys(p, o, ['target_id', 'reason'], path);
      const body = { target_id: readId(p, o, 'target_id', path), reason: readText(p, o, 'reason', path, 2000) };
      return Object.values(body).every(defined) ? body as NormBody : undefined;
    }
  }
}

/** Parse an unsigned post. Output keys are in a fixed order, so the signature is order-independent. */
export function parseCommunityPost(input: unknown): PhaseCheck<UnsignedCommunityPost> {
  const p = new Problems();
  const o = readObject(p, input, 'post');
  if (!o) return p.fail();
  checkKeys(p, o, POST_KEYS, 'post');
  if (o.schema_version !== SCHEMA_VERSION) p.add('post.schema_version', `expected "${SCHEMA_VERSION}"`);
  const post_id = readId(p, o, 'post_id', 'post');
  const room_id = readId(p, o, 'room_id', 'post');
  const actor_id = readId(p, o, 'actor_id', 'post');
  const kind = readEnum(p, o, 'kind', 'post', COMMUNITY_KINDS);
  const created_at = readIso(p, o, 'created_at', 'post');
  const body = kind ? readBody(p, kind, o.body, 'post.body') : undefined;
  if (p.bad || !post_id || !room_id || !actor_id || !kind || !created_at || !body) return p.fail();
  return { ok: true, value: { schema_version: SCHEMA_VERSION, post_id, room_id, actor_id, kind, created_at, body } as UnsignedCommunityPost };
}

export function deriveActorKey(serverSecret: string, actorId: string): Promise<string> {
  return hmac(serverSecret, JSON.stringify(['community/v1/actor-key', actorId]));
}

function signingInput(post: UnsignedCommunityPost): string {
  const { schema_version, post_id, room_id, actor_id, kind, created_at, body } = post;
  return JSON.stringify(['community/v1/post', schema_version, post_id, room_id, actor_id, kind, created_at, body]);
}

export async function signCommunityPost(serverSecret: string, post: UnsignedCommunityPost): Promise<CommunityPost> {
  const sig = await hmac(await deriveActorKey(serverSecret, post.actor_id), signingInput(post));
  return { ...post, sig };
}

/** Re-parse, then check the actor matches the authenticated session and the signature matches. */
export async function verifyCommunityPost(
  serverSecret: string, post: CommunityPost, sessionActorId: string,
): Promise<PhaseCheck<CommunityPost>> {
  const { sig, ...rest } = post;
  const parsed = parseCommunityPost(rest);
  if (!parsed.ok) return parsed;
  const errors: string[] = [];
  if (parsed.value.actor_id !== sessionActorId) errors.push('post.actor_id: does not match the authenticated actor');
  const expected = await hmac(await deriveActorKey(serverSecret, parsed.value.actor_id), signingInput(parsed.value));
  if (typeof sig !== 'string' || !same(sig, expected)) errors.push('post.sig: HMAC does not match');
  return errors.length ? { ok: false, errors } : { ok: true, value: { ...parsed.value, sig } };
}

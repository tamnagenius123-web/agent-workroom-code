import { z } from 'zod';
import { Fault, ROOM, keySchema, metadata } from './contracts.ts';
import type { Database } from './db.ts';
import {
  OWNER_PRINCIPAL, assertOwnerCsrf, loadOwnerSession, ownerHash, ownerSameOrigin, requireOwnerTables,
} from './owner-session.ts';

const SECURITY = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
const prose = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && value.isWellFormed() && !value.includes('\0'), 'Invalid text');
const ruleId = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/);
const kindSchema = z.enum(['boundary', 'norm', 'preference']);
const ruleOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), rule_id: ruleId, text: prose(2000), kind: kindSchema, provenance: prose(500) }).strict(),
  z.object({ op: z.literal('deprecate'), rule_id: ruleId, superseded_by: ruleId.optional() }).strict(),
  z.object({ op: z.literal('retire'), rule_id: ruleId, retire_reason: prose(500) }).strict(),
  z.object({
    op: z.literal('change'), rule_id: ruleId, text: prose(2000).optional(), kind: kindSchema.optional(),
  }).strict().refine(value => value.text !== undefined || value.kind !== undefined, 'Change must name text or kind.'),
]);
const postBody = z.object({
  north_star: prose(500), intent_md: prose(32768), rules: z.array(ruleOp).max(40).default([]),
}).strict();
const putBody = postBody.extend({ parent_version: z.number().int().positive() }).strict();
type Op = z.infer<typeof ruleOp>;
type Kind = z.infer<typeof kindSchema>;
interface Snap {
  id: string; text: string; kind: Kind; status: 'active' | 'deprecated' | 'retired';
  introduced_in: number; retired_in: number | null; superseded_by: string | null;
  provenance: string; retire_reason: string | null;
}
interface RuleBrief { id: string; text: string }
interface Diff { added: RuleBrief[]; retired: RuleBrief[]; changed: RuleBrief[] }
interface VersionRow { version: number; north_star: string; intent_md: string; content_hash: string; directive_text: string }
interface StoredVersion { version: number; parent_version: number | null; content_hash: string }
type OwnerEnv = { DB: Database; OWNER_PASSWORD_HASH?: string };

function ownerOk(data: unknown): Response {
  return Response.json({ ok: true, data, meta: metadata() }, { headers: SECURITY });
}
async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new Fault('INVALID_INPUT', 'Use application/json.', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new Fault('INVALID_INPUT', 'JSON body required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      size += step.value.byteLength;
      if (size > 49152) { await reader.cancel(); throw new Fault('BODY_TOO_LARGE', 'Request exceeds 48 KiB.', 413); }
      chunks.push(step.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Fault('INVALID_INPUT', 'Body must be UTF-8.'); }
  try { return JSON.parse(text); } catch { throw new Fault('INVALID_INPUT', 'Invalid JSON body.'); }
}
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
// content_hash is sha256 hex of this canonical cumulative state, not of the request body.
// Keys are alphabetical. rules_active keeps status=active only (retirements applied;
// deprecated rows are omitted), sorted by rule id. Identical active state shares a hash.
// owner_directives.request_hash is a separate fingerprint of the method and request.
function canonicalState(northStar: string, intentMd: string, rules: Map<string, Snap>): string {
  const rulesActive = [...rules.values()]
    .filter(rule => rule.status === 'active')
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map(rule => ({ id: rule.id, kind: rule.kind, text: rule.text }));
  return JSON.stringify({ intent_md: intentMd, north_star: northStar, rules_active: rulesActive });
}
// ETag contract, one strong validator per representation:
// - full: GET /v1/intent and GET /v1/intent?since=0 share a body. The ETag is
//   "<content_hash>" of the head canonical cumulative state, or "0" when no version exists.
//   It identifies that active state. It does not identify the version counter or retired
//   rules that sit outside it.
// - since: GET /v1/intent?since=N for N>0. The window diff is a different representation.
//   The ETag is the quoted sha256 of "since\n" plus the JSON body, so a different window
//   or a different retirement history does not reuse the full validator.
// - diff: GET /v1/intent/diff?a&b. The ETag is the quoted sha256 of "diff\n" plus the JSON
//   body. The two endpoint content hashes are not enough: a retirement between them changes the body.
function canonOp(op: Op): Op {
  if (op.op === 'add') return { op: 'add', rule_id: op.rule_id, text: op.text, kind: op.kind, provenance: op.provenance };
  if (op.op === 'retire') return { op: 'retire', rule_id: op.rule_id, retire_reason: op.retire_reason };
  if (op.op === 'deprecate') return op.superseded_by ? { op: 'deprecate', rule_id: op.rule_id, superseded_by: op.superseded_by } : { op: 'deprecate', rule_id: op.rule_id };
  return { op: 'change', rule_id: op.rule_id, ...(op.text !== undefined ? { text: op.text } : {}), ...(op.kind !== undefined ? { kind: op.kind } : {}) };
}
function applyOp(rules: Map<string, Snap>, op: Op, version: number): void {
  if (op.op === 'add') {
    if (rules.has(op.rule_id)) throw new Fault('INVALID_INPUT', 'Rule already exists.');
    rules.set(op.rule_id, {
      id: op.rule_id, text: op.text, kind: op.kind, status: 'active', introduced_in: version,
      retired_in: null, superseded_by: null, provenance: op.provenance, retire_reason: null,
    });
    return;
  }
  const current = rules.get(op.rule_id);
  if (!current) throw new Fault('INVALID_INPUT', 'Unknown rule.');
  if (op.op === 'deprecate') {
    if (current.status !== 'active') throw new Fault('INVALID_INPUT', 'Only an active rule can be deprecated.');
    if (op.superseded_by && !rules.has(op.superseded_by)) throw new Fault('INVALID_INPUT', 'Unknown successor rule.');
    rules.set(op.rule_id, { ...current, status: 'deprecated', superseded_by: op.superseded_by ?? current.superseded_by });
    return;
  }
  if (op.op === 'retire') {
    if (current.status === 'retired') throw new Fault('INVALID_INPUT', 'Rule is already retired.');
    rules.set(op.rule_id, { ...current, status: 'retired', retired_in: version, retire_reason: op.retire_reason });
    return;
  }
  if (current.status === 'retired') throw new Fault('INVALID_INPUT', 'A retired rule stays in the table.');
  rules.set(op.rule_id, { ...current, text: op.text ?? current.text, kind: op.kind ?? current.kind });
}
// A boundary rule moves only when this directive names its rule_id. Other ops must not touch it.
function assertBoundaryNamed(before: Map<string, Snap>, after: Map<string, Snap>, ops: Op[]): void {
  const named = new Set(ops.map(op => op.rule_id));
  for (const [id, prior] of before) {
    if (prior.kind !== 'boundary' || named.has(id)) continue;
    const next = after.get(id);
    if (!next || next.text !== prior.text || next.kind !== prior.kind || next.status !== prior.status || next.retired_in !== prior.retired_in || next.retire_reason !== prior.retire_reason) {
      throw new Fault('INVALID_INPUT', 'Boundary rules change only when the directive names them.');
    }
  }
}
function brief(rule: Snap): RuleBrief { return { id: rule.id, text: rule.text }; }
function classify(before: Map<string, Snap>, after: Map<string, Snap>, from: number, to: number): Diff {
  const added: RuleBrief[] = [];
  const retired: RuleBrief[] = [];
  const changed: RuleBrief[] = [];
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const prev = before.get(id);
    const rule = after.get(id);
    if (!rule) continue;
    if (rule.status === 'retired' && rule.retired_in !== null && rule.retired_in > from && rule.retired_in <= to) {
      retired.push(brief(rule));
      continue;
    }
    if (!prev) {
      if (rule.status === 'active') added.push(brief(rule));
      else if (rule.status === 'deprecated') changed.push(brief(rule));
      continue;
    }
    if (prev.text !== rule.text || prev.kind !== rule.kind || prev.status !== rule.status) {
      if (rule.status === 'retired') retired.push(brief(rule));
      else changed.push(brief(rule));
    }
  }
  return { added, retired, changed };
}
interface LineAnchor { ia: number; ib: number }
// Keyed line diff. Work is O(n + m + k log k) and memory is O(n + m). It never
// allocates an LCS matrix. A pair of accepted 24001-line documents is
// (24001 + 1) ** 2 = 576_096_004 cells; that table must not be built.
function longestIncreasing(items: LineAnchor[]): LineAnchor[] {
  const piles: LineAnchor[][] = [];
  const previous = new Map<LineAnchor, LineAnchor | undefined>();
  for (const item of items) {
    let lo = 0;
    let hi = piles.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const pile = piles[mid];
      const top = pile?.[pile.length - 1];
      if (top && top.ib < item.ib) lo = mid + 1;
      else hi = mid;
    }
    const pile = piles[lo] ?? [];
    piles[lo] = pile;
    pile.push(item);
    const earlier = lo === 0 ? undefined : piles[lo - 1];
    previous.set(item, earlier?.[earlier.length - 1]);
  }
  const chain: LineAnchor[] = [];
  const last = piles[piles.length - 1];
  let cursor = last?.[last.length - 1];
  while (cursor) {
    chain.push(cursor);
    cursor = previous.get(cursor);
  }
  chain.reverse();
  return chain;
}
function replaceHunk(before: string[], after: string[]): { op: 'add' | 'del'; line: string }[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const out: { op: 'add' | 'del'; line: string }[] = [];
  for (let i = start; i < endBefore; i += 1) out.push({ op: 'del', line: before[i] ?? '' });
  for (let j = start; j < endAfter; j += 1) out.push({ op: 'add', line: after[j] ?? '' });
  return out;
}
function lineDiff(before: string, after: string): { op: 'add' | 'del'; line: string }[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const countOf = (lines: string[]) => {
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const countA = countOf(a);
  const countB = countOf(b);
  const indexB = new Map<string, number>();
  for (let index = 0; index < b.length; index += 1) {
    const line = b[index] ?? '';
    if (countB.get(line) === 1) indexB.set(line, index);
  }
  const candidates: LineAnchor[] = [];
  for (let index = 0; index < a.length; index += 1) {
    const line = a[index] ?? '';
    if (countA.get(line) !== 1) continue;
    const ib = indexB.get(line);
    if (ib !== undefined) candidates.push({ ia: index, ib });
  }
  const out: { op: 'add' | 'del'; line: string }[] = [];
  let fromA = 0;
  let fromB = 0;
  for (const anchor of [...longestIncreasing(candidates), { ia: a.length, ib: b.length }]) {
    out.push(...replaceHunk(a.slice(fromA, anchor.ia), b.slice(fromB, anchor.ib)));
    fromA = anchor.ia + 1;
    fromB = anchor.ib + 1;
  }
  return out;
}
async function requireIntent(db: Database): Promise<void> {
  const needed = ['intent_versions', 'rules', 'intent_reads', 'owner_directives'];
  const found = new Set((await db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('intent_versions','rules','intent_reads','owner_directives')",
  ).all<{ name: string }>()).results.map(row => row.name));
  if (needed.some(name => !found.has(name))) throw new Fault('NOT_READY', 'Intent storage is not ready.', 503);
}
async function headVersion(db: Database): Promise<number> {
  const row = await db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM intent_versions').first<{ version: number }>();
  return Number(row?.version ?? 0);
}
async function loadRules(db: Database): Promise<Map<string, Snap>> {
  const rows = (await db.prepare(`SELECT rule_id, text, kind, status, introduced_in, retired_in, superseded_by, provenance, retire_reason FROM rules`)
    .all<{ rule_id: string; text: string; kind: Kind; status: Snap['status']; introduced_in: number | null; retired_in: number | null; superseded_by: string | null; provenance: string; retire_reason: string | null }>()).results;
  const rules = new Map<string, Snap>();
  for (const row of rows) {
    rules.set(row.rule_id, {
      id: row.rule_id, text: row.text, kind: row.kind, status: row.status, introduced_in: Number(row.introduced_in ?? 0),
      retired_in: row.retired_in === null ? null : Number(row.retired_in), superseded_by: row.superseded_by,
      provenance: row.provenance, retire_reason: row.retire_reason,
    });
  }
  return rules;
}
function ruleStatements(db: Database, ops: Op[], version: number, after: Map<string, Snap>): ReturnType<Database['prepare']>[] {
  const statements: ReturnType<Database['prepare']>[] = [];
  for (const op of ops) {
    if (op.op === 'add') {
      statements.push(db.prepare(`INSERT INTO rules(rule_id, text, kind, status, introduced_in, retired_in, superseded_by, provenance, retire_reason)
        VALUES (?, ?, ?, 'active', ?, NULL, NULL, ?, NULL)`).bind(op.rule_id, op.text, op.kind, version, op.provenance));
    } else if (op.op === 'deprecate') {
      statements.push(db.prepare(`UPDATE rules SET status='deprecated', superseded_by=? WHERE rule_id=? AND status='active'`)
        .bind(op.superseded_by ?? null, op.rule_id));
    } else if (op.op === 'retire') {
      statements.push(db.prepare(`UPDATE rules SET status='retired', retired_in=?, retire_reason=? WHERE rule_id=? AND status IN ('active','deprecated')`)
        .bind(version, op.retire_reason, op.rule_id));
    } else {
      const next = after.get(op.rule_id);
      if (!next) throw new Fault('INVALID_INPUT', 'Unknown rule.');
      statements.push(db.prepare(`UPDATE rules SET text=?, kind=? WHERE rule_id=? AND status IN ('active','deprecated')`)
        .bind(next.text, next.kind, op.rule_id));
    }
  }
  return statements;
}
function opsOf(text: string): Op[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (!parsed || typeof parsed !== 'object' || !('ops' in parsed)) return [];
  const ops = (parsed as { ops?: unknown }).ops;
  if (!Array.isArray(ops)) return [];
  return ops.map(op => ruleOp.parse(op));
}
function replay(rows: VersionRow[], until: number): Map<string, Snap> {
  const rules = new Map<string, Snap>();
  for (const row of rows) {
    if (row.version > until) break;
    for (const op of opsOf(row.directive_text)) applyOp(rules, op, row.version);
  }
  return rules;
}
async function loadVersions(db: Database): Promise<VersionRow[]> {
  const rows = (await db.prepare(`SELECT v.version, v.north_star, v.intent_md, v.content_hash, d.text AS directive_text
    FROM intent_versions v JOIN owner_directives d ON d.id = v.directive_id ORDER BY v.version`)
    .all<VersionRow>()).results;
  return rows.map(row => ({ ...row, version: Number(row.version) }));
}
function at(rows: VersionRow[], version: number): { north_star: string; intent_md: string } {
  if (version === 0) return { north_star: '', intent_md: '' };
  const row = rows.find(item => item.version === version);
  if (!row) throw new Fault('NOT_FOUND', 'Intent version not found.', 404);
  return row;
}
function knownVersion(version: number, rows: VersionRow[]): void {
  if (version === 0) return;
  if (!rows.some(row => row.version === version)) throw new Fault('NOT_FOUND', 'Intent version not found.', 404);
}
function query(url: URL, allowed: readonly string[]): Record<string, string> {
  const params = Object.fromEntries(url.searchParams);
  if (Object.keys(params).some(name => !allowed.includes(name)) || [...url.searchParams.keys()].length !== Object.keys(params).length) {
    throw new Fault('INVALID_INPUT', 'Unsupported query parameters.');
  }
  return params;
}
function versionParam(value: string | undefined, name: string): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Fault('INVALID_INPUT', name + ' must be a version integer.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Fault('INVALID_INPUT', name + ' must be a version integer.');
  return parsed;
}
function activeRules(rules: Map<string, Snap>): RuleBrief[] {
  return [...rules.values()].filter(rule => rule.status === 'active').map(brief).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
async function stored(db: Database, directiveId: string, replayed: boolean) {
  const row = await db.prepare('SELECT version, parent_version, content_hash FROM intent_versions WHERE directive_id=?')
    .bind(directiveId).first<StoredVersion>();
  if (!row) throw new Fault('TEMPORARY_FAILURE', 'Intent version was not stored.', 503, 'unknown', true);
  return { version: Number(row.version), parent_version: row.parent_version === null ? null : Number(row.parent_version), directive_id: directiveId, content_hash: row.content_hash, replayed };
}

export async function intentOwnerRoutes(request: Request, env: OwnerEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/owner/intent') return null;
  if (request.method !== 'POST' && request.method !== 'PUT') throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
  const hash = ownerHash(env);
  await requireIntent(env.DB);
  await requireOwnerTables(env.DB);
  const session = await loadOwnerSession(env.DB, hash, request);
  if (!ownerSameOrigin(request)) throw new Fault('FORBIDDEN', 'Cross-site request denied.', 403);
  assertOwnerCsrf(session, request);
  if (url.search) throw new Fault('INVALID_INPUT', 'No query parameters.');
  const rawKey = request.headers.get('idempotency-key');
  if (!rawKey) throw new Fault('INVALID_INPUT', 'Idempotency-Key is required.');
  const key = keySchema.parse(rawKey);
  const parsed = request.method === 'PUT' ? putBody.parse(await readJson(request)) : postBody.parse(await readJson(request));
  const ops = parsed.rules.map(canonOp);
  const declaredParent = request.method === 'PUT' && 'parent_version' in parsed ? parsed.parent_version : null;
  const text = JSON.stringify({ north_star: parsed.north_star, intent_md: parsed.intent_md, parent_version: declaredParent, ops });
  const requestFingerprint = await sha256Hex(request.method + '\n' + text);
  const db = env.DB;
  const existing = await db.prepare('SELECT id, request_hash FROM owner_directives WHERE actor_id=? AND idempotency_key=?')
    .bind(OWNER_PRINCIPAL, key).first<{ id: string; request_hash: string }>();
  if (existing) {
    if (existing.request_hash !== requestFingerprint) throw new Fault('IDEMPOTENCY_CONFLICT', 'Key already has different content.', 409, 'not_applied', false);
    return ownerOk(await stored(db, existing.id, true));
  }
  if (!await db.prepare('SELECT 1 FROM rooms WHERE id=?').bind(ROOM).first()) throw new Fault('NOT_FOUND', 'Room not found.', 404);
  const current = await headVersion(db);
  if (request.method === 'PUT' && declaredParent !== current) throw new Fault('VERSION_CONFLICT', 'Intent version changed. Retry with the current parent.', 409, 'not_applied', false);
  const next = current + 1;
  const before = await loadRules(db);
  const after = new Map([...before].map(([id, rule]) => [id, { ...rule }]));
  for (const op of ops) applyOp(after, op, next);
  assertBoundaryNamed(before, after, ops);
  const contentHash = await sha256Hex(canonicalState(parsed.north_star, parsed.intent_md, after));
  const directiveId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const parent = current === 0 ? null : current;
  const statements: ReturnType<Database['prepare']>[] = [
    db.prepare("INSERT INTO principals(id, active) VALUES ('user:minsung', 1) ON CONFLICT(id) DO NOTHING"),
    db.prepare("INSERT INTO principal_roles(principal_id, kind) VALUES ('user:minsung', 'user') ON CONFLICT(principal_id) DO NOTHING"),
    db.prepare(`INSERT INTO owner_directives(id, room_id, actor_id, text, message_id, idempotency_key, request_hash, created_at)
      VALUES (?, ?, 'user:minsung', ?, NULL, ?, ?, ?)`).bind(directiveId, ROOM, text, key, requestFingerprint, createdAt),
    db.prepare(`INSERT INTO intent_versions(version, north_star, intent_md, parent_version, directive_id, author_principal, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, 'user:minsung', ?, ?)`).bind(next, parsed.north_star, parsed.intent_md, parent, directiveId, contentHash, createdAt),
    ...ruleStatements(db, ops, next, after),
  ];
  try { await db.batch(statements); }
  catch (error) {
    const message = String((error as Error).message ?? error);
    if (/UNIQUE|PRIMARY|constraint/i.test(message)) {
      const raced = await db.prepare('SELECT id, request_hash FROM owner_directives WHERE actor_id=? AND idempotency_key=?')
        .bind(OWNER_PRINCIPAL, key).first<{ id: string; request_hash: string }>();
      if (raced && raced.request_hash === requestFingerprint) return ownerOk(await stored(db, raced.id, true));
      throw new Fault('VERSION_CONFLICT', 'Intent version changed. Retry with the current parent.', 409, 'not_applied', false);
    }
    throw error;
  }
  return ownerOk(await stored(db, directiveId, false));
}

export async function intentAgentRoute(request: Request, url: URL, db: Database): Promise<{ data: unknown; meta?: Record<string, unknown>; etag?: string }> {
  if (request.method !== 'GET') throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
  await requireIntent(db);
  const rows = await loadVersions(db);
  const head = rows.length ? rows[rows.length - 1] : undefined;
  if (url.pathname === '/v1/intent/diff') {
    const params = query(url, ['a', 'b']);
    const a = versionParam(params.a, 'a');
    const b = versionParam(params.b, 'b');
    if (a > b) throw new Fault('INVALID_INPUT', 'Diff range is reversed.');
    knownVersion(a, rows);
    knownVersion(b, rows);
    const from = at(rows, a);
    const to = at(rows, b);
    const data = {
      a, b, north_star: { from: from.north_star, to: to.north_star }, intent_md_diff: lineDiff(from.intent_md, to.intent_md),
      rules: classify(replay(rows, a), replay(rows, b), a, b),
    };
    return { data, etag: `"${await sha256Hex('diff\n' + JSON.stringify(data))}"` };
  }
  const params = query(url, ['since']);
  const since = params.since === undefined ? 0 : versionParam(params.since, 'since');
  knownVersion(since, rows);
  const current = head ?? { version: 0, north_star: '', intent_md: '', content_hash: '', directive_text: '' };
  const rules = replay(rows, current.version);
  const data = {
    v: current.version, north_star: current.north_star, intent_md: current.intent_md, rules_active: activeRules(rules),
    diff: classify(replay(rows, since), rules, since, current.version),
  };
  const etag = since === 0
    ? (current.version === 0 ? '"0"' : `"${current.content_hash}"`)
    : `"${await sha256Hex('since\n' + JSON.stringify(data))}"`;
  return { data, etag };
}

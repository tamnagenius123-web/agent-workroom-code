import { Fault } from './contracts.ts';
import { experienceCanonical as canonicalJson, sha256Hex, type ExperienceCanonFields } from './canonical.ts';
import type { Database, Value } from './db.ts';
import { looksLikeSecret } from './memory-items.ts';

// OCG-W W6: experience ledger. Self-evolution as a recorded loop, never an automatic one.
// Lineage (semantics only, no code copied):
// - Harness² (arXiv 2610.14224): the eight file-mounted harness components and a harnessing-level
//   improvement library (EXPERIENCE.md). Here the library is the set of `kept` entries.
// - RSI-Anything (arXiv 2610.13912): propose -> predict -> execute -> keep the improvement.
//   An entry carries its prediction before the outcome exists.
// - MASS (arXiv 2610.12176): supervision by an agent other than the actor. keep/revert needs a
//   listed reviewer (memory_reviewers, W3) who is neither the proposer nor the observer.
// - INORI H-RS1 (Notion checkpoint 3e08d918…b5703b): a gate auto-applied self-weakening mutations.
//   This ledger applies nothing; a kept entry is advice that agents read as untrusted data.
// - OCG ABSORB_DESIGN §0: verifier is not the proposer; verdict binds an exact content digest.
// OCG, ocg-model and Erda stay distinct: no ocg-model scores or Erda components are inputs here.

export const COMPONENTS = ['system_prompt', 'guardrails', 'memory', 'tool_guidance', 'subagents', 'skills', 'scripts', 'plugins'] as const;
export type Component = typeof COMPONENTS[number];
export type ExperienceState = 'proposed' | 'observed' | 'kept' | 'reverted';
export type ExperienceVerdict = 'keep' | 'revert';

export interface ExperienceEntry {
  id: string; room_id: string; component: Component; change: string; prediction: string;
  source_message_id: string; source_version: number | null; /** rev2c (0020): applies to source_version and outcome_message_version. */ version_basis: 'pinned' | 'inferred'; proposed_by: string; state: ExperienceState;
  outcome: string | null; outcome_message_id: string | null; outcome_message_version: number | null; observed_by: string | null; observed_at: string | null;
  verdict_by: string | null; verdict_reason: string | null; verdict_digest: string | null; verdict_at: string | null;
  created_at: string;
}

const COLUMNS = 'id, room_id, component, change, prediction, source_message_id, source_version, version_basis, proposed_by, state, outcome, outcome_message_id, outcome_message_version, observed_by, observed_at, verdict_by, verdict_reason, verdict_digest, verdict_at, created_at';
const COMPONENT_SET = new Set<string>(COMPONENTS);
const STATES = new Set<string>(['proposed', 'observed', 'kept', 'reverted']);

function ident(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || !value.isWellFormed() || value.includes('\0')) throw new Fault('INVALID_INPUT', `${field} is invalid`);
  return value;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) throw new Fault('INVALID_INPUT', `${field} is invalid`);
  const n = [...value].length;
  if (n < 1 || n > max) throw new Fault('INVALID_INPUT', `${field} must be 1 to ${max} characters`);
  if (looksLikeSecret(value)) throw new Fault('INVALID_INPUT', `${field} looks like a secret`);
  return value;
}

function component(value: unknown): Component {
  if (typeof value !== 'string' || !COMPONENT_SET.has(value)) throw new Fault('INVALID_INPUT', `component must be one of ${COMPONENTS.join(', ')}`);
  return value as Component;
}

/** rev2 canonical preimage (canonical.ts): versioned JSON over identity, room, change, prediction, outcome and both pinned evidence versions. */
export function experienceCanonical(e: ExperienceCanonFields): string {
  return canonicalJson(e);
}

export async function experienceDigest(e: ExperienceCanonFields): Promise<string> {
  return sha256Hex(experienceCanonical(e));
}

async function load(db: Database, id: string): Promise<ExperienceEntry | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM experience_entries WHERE id=?`).bind(id).first<ExperienceEntry>();
}

/** Step 1 (propose + predict). The prediction is fixed before any outcome exists. */
export async function proposeExperience(db: Database, actor: string, input: { room_id: string; component: string; change: string; prediction: string; source_message_id: string; id?: string }): Promise<ExperienceEntry> {
  const by = ident(actor, 'actor');
  const id = input.id === undefined ? crypto.randomUUID() : ident(input.id, 'id');
  const room = ident(input.room_id, 'room_id');
  const comp = component(input.component);
  const change = text(input.change, 'change', 4000);
  const prediction = text(input.prediction, 'prediction', 2000);
  const source = ident(input.source_message_id, 'source_message_id');
  const now = new Date().toISOString();
  const out = await db.batch<ExperienceEntry>([
    db.prepare(`INSERT INTO experience_entries(id, room_id, component, change, prediction, source_message_id, source_version, proposed_by, state, created_at)
      SELECT ?, ?, ?, ?, ?, ?, (SELECT max(h.version) FROM message_history h WHERE h.message_id=?), ?, 'proposed', ?
      WHERE EXISTS (SELECT 1 FROM messages WHERE id=? AND room_id=?) AND EXISTS (SELECT 1 FROM principals WHERE id=?)`)
      .bind(id, room, comp, change, prediction, source, source, by, now, source, room, by),
    db.prepare(`SELECT ${COLUMNS} FROM experience_entries WHERE id=?`).bind(id),
  ]);
  const saved = out[1]?.results[0];
  if (!saved) throw new Fault('INVALID_INPUT', 'Experience was not stored. Check the room, source message, and actor.');
  return saved;
}

/** Step 2 (execute + observe). Records the outcome once, citing a room message as evidence. */
export async function observeExperience(db: Database, actor: string, id: string, outcome: string, outcomeMessageId: string): Promise<ExperienceEntry> {
  const by = ident(actor, 'actor');
  const entryId = ident(id, 'id');
  const result = text(outcome, 'outcome', 4000);
  const evidence = ident(outcomeMessageId, 'outcome_message_id');
  const now = new Date().toISOString();
  const out = await db.batch<ExperienceEntry>([
    db.prepare(`UPDATE experience_entries SET state='observed', outcome=?, outcome_message_id=?, outcome_message_version=(SELECT max(h.version) FROM message_history h WHERE h.message_id=?), observed_by=?, observed_at=?
      WHERE id=? AND state='proposed'
        AND EXISTS (SELECT 1 FROM messages m WHERE m.id=? AND m.room_id=experience_entries.room_id)
        AND EXISTS (SELECT 1 FROM principals WHERE id=?)`)
      .bind(result, evidence, evidence, by, now, entryId, evidence, by),
    db.prepare(`SELECT ${COLUMNS} FROM experience_entries WHERE id=? AND state='observed' AND observed_by=? AND observed_at=?`).bind(entryId, by, now),
  ]);
  const saved = out[1]?.results[0];
  if (!saved) throw new Fault('INVALID_INPUT', 'Outcome was not stored. The entry must be proposed and the evidence message must be in its room.');
  return saved;
}

/** Step 3 (keep or revert). Listed reviewer, not the proposer, not the observer, exact digest. */
export async function judgeExperience(db: Database, reviewer: string, id: string, verdict: ExperienceVerdict, reason: string, digest: string): Promise<ExperienceEntry> {
  const by = ident(reviewer, 'reviewer');
  const entryId = ident(id, 'id');
  if (verdict !== 'keep' && verdict !== 'revert') throw new Fault('INVALID_INPUT', 'verdict must be keep or revert');
  const why = text(reason, 'reason', 2000);
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new Fault('INVALID_INPUT', 'content digest must be 64 lowercase hex characters');
  const current = await load(db, entryId);
  if (!current) throw new Fault('INVALID_INPUT', 'Verdict was not stored. Unknown entry.');
  if (current.state === 'observed' && await experienceDigest(current) !== digest) throw new Fault('INVALID_INPUT', 'Content digest does not match the entry.');
  const state = verdict === 'keep' ? 'kept' : 'reverted';
  const now = new Date().toISOString();
  const out = await db.batch<ExperienceEntry>([
    db.prepare(`UPDATE experience_entries SET state=?, verdict_by=?, verdict_reason=?, verdict_digest=?, verdict_at=?
      WHERE id=? AND state='observed' AND proposed_by<>? AND observed_by<>?
        AND EXISTS (SELECT 1 FROM memory_reviewers r WHERE r.principal_id=?)
        AND room_id=? AND component=? AND change=? AND prediction=? AND source_message_id=? AND source_version IS ? AND outcome IS ? AND outcome_message_id IS ? AND outcome_message_version IS ?`)
      .bind(state, by, why, digest, now, entryId, by, by, by, current.room_id, current.component, current.change, current.prediction, current.source_message_id, current.source_version, current.outcome, current.outcome_message_id, current.outcome_message_version),
    db.prepare(`SELECT ${COLUMNS} FROM experience_entries WHERE id=? AND state=? AND verdict_by=? AND verdict_at=?`).bind(entryId, state, by, now),
  ]);
  const saved = out[1]?.results[0];
  if (!saved) throw new Fault('INVALID_INPUT', 'Verdict was not stored. The entry must be observed, and the reviewer must be listed and be neither the proposer nor the observer.');
  return saved;
}

/** The improvement library: kept entries by default (Harness² EXPERIENCE.md). Other states are opt-in. */
export async function experienceView(db: Database, room: string, opts: { states?: readonly string[]; component?: string; limit?: number } = {}): Promise<ExperienceEntry[]> {
  const roomId = ident(room, 'room');
  const states = opts.states && opts.states.length ? opts.states : ['kept'];
  for (const s of states) if (!STATES.has(s)) throw new Fault('INVALID_INPUT', 'state must be proposed, observed, kept, or reverted');
  const args: Value[] = [roomId, ...states];
  let compSql = '';
  if (opts.component !== undefined) { compSql = ' AND component=?'; args.push(component(opts.component)); }
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  args.push(limit);
  const listed = await db.prepare(`SELECT ${COLUMNS} FROM experience_entries WHERE room_id=? AND state IN (${states.map(() => '?').join(',')})${compSql}
    ORDER BY COALESCE(verdict_at, observed_at, created_at) DESC, id LIMIT ?`).bind(...args).all<ExperienceEntry>();
  return listed.results;
}

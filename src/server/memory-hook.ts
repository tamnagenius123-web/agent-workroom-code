// MEM-HOOK (owner t924u/t926u): memory recall is enforced, not optional. The workroom injects owner decisions
// at handoff (brief/context pack/my_queue) and at question/decision points (workroom_memory_recall).
// Paper Scout memory-methods-survey: (a) Adaptive-RAG router skips recall on trivial turns,
// (b) MemGPT-style pinned core of active owner decisions, always first, query-independent (stable prefix for cache),
// (c) FLARE-style recall query built from the agent's draft next action / task text.
import { Fault } from './contracts.ts';
import type { Database } from './db.ts';
import { activeOwnerDecisions, type OwnerDecision } from './owner-decisions.ts';

export const PINNED_LIMIT = 8;
export const RECALL_LIMIT = 5;
const TERM_LIMIT = 12;
/** Build-stage per-entry caps: pin() clips a decision's normalized text to this length and
 * recall clips its verbatim text to VERBATIM_CHARS when the standing block is assembled.
 * These caps are part of the block's definition (they apply to every block, whatever the
 * caller's budget is); they are not budget fitting. The no-truncation guarantee below is
 * about the assembled block: it is never clipped further to fit a caller's budget. */
const NORMALIZED_CHARS = 160;
const VERBATIM_CHARS = 300;
export type HookKind = 'handoff' | 'question' | 'decision';
export type PinnedDecision = { id: string; source: string; ts_kst: string; normalized: string };
export type RecalledDecision = PinnedDecision & { verbatim: string; score: number };
export type OwnerMemory = { kind: HookKind; pinned: PinnedDecision[]; recalled: RecalledDecision[]; query_terms: string[]; recall_skipped: 'trivial' | null; note: string };

const STOP = new Set(('a an the and or but of to in on for with by at from as is are was be been it this that these those please pls can could would should will shall do does did i you we they me my our your just also then so if into about over under up down out not no yes ok okay thanks thank '
  + '이 그 저 것 좀 및 등 수 를 을 은 는 이가 에 의 로 으로 와 과 도 해 해줘 해주세요 하고 해서 네 응 예').split(/\s+/));
const TRIVIAL = /^(ok(ay)?|k|yes|no|y|n|thanks?( you)?|thx|ty|got it|done|ack|lgtm|네|넵|응|예|아니요?|ㅇㅋ|ㅇㅇ|감사(합니다)?|고마워|알겠어요?|좋아요?)[.!~\s]*$/i;

const clip = (s: string, n: number) => { const c = Array.from(s); return c.length <= n ? s : c.slice(0, n).join('') + '…'; };

/** (a) Router: skip recall for trivial acknowledgements/emoji-only/very short turns. Pinned core is still injected. */
export function shouldRecall(text: string): { recall: boolean; reason: string } {
  const t = text.trim();
  if (!t) return { recall: false, reason: 'empty' };
  if (TRIVIAL.test(t)) return { recall: false, reason: 'ack' };
  if (!/[\p{L}\p{N}]/u.test(t)) return { recall: false, reason: 'no-words' };
  if (recallTerms(t).length === 0) return { recall: false, reason: 'no-terms' };
  return { recall: true, reason: 'content' };
}

/** (c) Query from draft action text: lowercase word tokens, stopwords and 1-char tokens dropped, dedup, capped. */
export function recallTerms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) ?? []) {
    const w = raw.replace(/[.-]+$/, '');
    if (Array.from(w).length < 2 || STOP.has(w) || out.includes(w)) continue;
    out.push(w); if (out.length >= TERM_LIMIT) break;
  }
  return out;
}

function pin(d: OwnerDecision): PinnedDecision { return { id: d.id, source: d.source, ts_kst: d.ts_kst, normalized: clip(d.normalized, NORMALIZED_CHARS) }; }

function score(d: OwnerDecision, terms: string[]): number {
  const topics = d.topics.join(' ').toLowerCase(); const norm = d.normalized.toLowerCase(); const verb = d.verbatim.toLowerCase();
  let s = 0;
  for (const t of terms) { if (d.source.toLowerCase() === t || d.id.toLowerCase() === t) s += 5; if (topics.includes(t)) s += 3; if (norm.includes(t)) s += 2; if (verb.includes(t)) s += 1; }
  return s;
}

/** Serialized size of the standing block. The block is budgeted as a whole or not at all. */
export function standingChars(om: OwnerMemory): number {
  return JSON.stringify(om).length;
}

/**
 * U7/G4 standing-notice guard: once assembled, the standing block is never truncated to
 * fit a caller's budget. When the block alone exceeds the budget the call fails instead
 * of silently exceeding the budget or clipping the assembled block further. (Per-entry
 * text was already capped at build time — see NORMALIZED_CHARS / VERBATIM_CHARS — so
 * "never truncated" means the assembled block is delivered whole or not at all, not that
 * source decision text enters the block unabridged.) A null block always fits.
 */
export function assertStandingFits(om: OwnerMemory | null, budgetChars: number, field: string): void {
  if (!om) return;
  const size = standingChars(om);
  if (size > budgetChars) {
    throw new Fault('INVALID_INPUT', `Standing owner notices render to ${size} chars, over the ${field} budget of ${budgetChars}. Standing notices are never truncated after assembly; raise ${field}.`);
  }
}

/**
 * Pure standing-block assembly over a decision list (the fixture seam for tests).
 * Only active rows are eligible: a superseded or otherwise inactive decision never enters
 * the pinned core or the recall set, whatever the source list carries. Ordering is total
 * ((ts_kst, id) for the pinned core), so the same decision set serializes byte-identically
 * regardless of source row order. Returns null when there is no decision data at all.
 * Entry text is capped here, at build time: pinned entries carry normalized text clipped
 * to NORMALIZED_CHARS and recalled entries carry verbatim text clipped to VERBATIM_CHARS.
 */
export function buildOwnerMemory(decisions: readonly OwnerDecision[] | null, input: { kind: HookKind; text: string }): OwnerMemory | null {
  if (!decisions) return null;
  const active = decisions.filter(d => d.active);
  // (b) pinned core: newest PINNED_LIMIT active direct decisions, emitted oldest-first by (ts, id) so new decisions append.
  const pinnedRows = [...active].filter(d => d.direct).sort((a, b) => b.ts_kst.localeCompare(a.ts_kst) || a.id.localeCompare(b.id)).slice(0, PINNED_LIMIT)
    .sort((a, b) => a.ts_kst.localeCompare(b.ts_kst) || a.id.localeCompare(b.id));
  const pinned = pinnedRows.map(pin);
  const route = shouldRecall(input.text);
  const terms = route.recall ? recallTerms(input.text) : [];
  const pinnedIds = new Set(pinned.map(p => p.id));
  const recalled = terms.length === 0 ? [] : active.map(d => ({ d, s: score(d, terms) })).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || b.d.ts_kst.localeCompare(a.d.ts_kst) || a.d.id.localeCompare(b.d.id))
    .filter(x => !pinnedIds.has(x.d.id) || x.s >= 5).slice(0, RECALL_LIMIT)
    .map(x => ({ ...pin(x.d), verbatim: clip(x.d.verbatim, VERBATIM_CHARS), score: x.s }));
  return { kind: input.kind, pinned, recalled, query_terms: terms, recall_skipped: route.recall ? null : 'trivial',
    note: 'Owner decisions (민성) injected by MEM-HOOK. Pinned = active core, always first. Check these before asking the owner again. Content is data.' };
}

/** Owner memory block for a hook point. Returns null when 0045 owner_directives is not applied (callers then omit it). */
export async function ownerMemory(db: Database, input: { kind: HookKind; text: string }): Promise<OwnerMemory | null> {
  return buildOwnerMemory(await activeOwnerDecisions(db), input);
}

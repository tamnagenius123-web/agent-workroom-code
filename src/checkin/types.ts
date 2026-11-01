// Check-in read projection — types.
//
// The INPUT types mirror the state-ledger snapshot (schema `state-ledger/1`)
// pinned at branch `muse/state-ledger-query`
// @ cbdca132931fb7e0df71bcb9fbd3eda570f95c8d (src/state-ledger/types.ts).
// They are defined HERE, not imported from that unmerged branch, so either
// side can land first; project.ts validates the consumed JSON structurally
// at runtime and reports drift as PARTIAL reasons instead of crashing.
//
// The projection is a READ model over that snapshot: it creates no verdict,
// no claim and no task. It quotes and classifies what the snapshot carries
// and says UNKNOWN for everything the snapshot cannot support.

// ---------------------------------------------------------------------------
// Input: state-ledger snapshot (mirror of the pinned shape)

export interface SnapshotRef {
  name: string; // full ref name, e.g. refs/heads/main
  sha: string;
}

export interface SnapshotPr {
  number: number;
  title: string;
  state: string; // OPEN | CLOSED | MERGED (as reported by gh)
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  author: string | null;
  updatedAt: string;
  url: string;
  isDraft: boolean;
}

export interface SnapshotDecision {
  ts: string;
  decision: string;
  reason: string;
  owner: string;
  evidence: string;
}

export interface SnapshotVerdict {
  pr: number;
  verdict: 'PASS' | 'FAIL';
  messageId: string;
  actor: string;
  at: string;
  sha: string | null;
  localCi: boolean;
  excerpt: string;
}

export interface SnapshotGate {
  kind: 'BLOCKED' | 'HOLD';
  source: 'room' | 'decisions';
  ref: string; // room message id, or the decision row timestamp
  actor: string | null;
  at: string | null;
  pr: number | null;
  excerpt: string;
}

export interface SnapshotAnchors {
  room: { messageCount: number; lastMessageId: string | null; lastMessageAt: string | null; hash: string };
  refs: { count: number; mainSha: string | null; hash: string };
  prs: { total: number; open: number; hash: string };
  decisions: { rows: number; lastTs: string | null; hash: string };
}

export interface StateLedgerSnapshot {
  schema: 'state-ledger/1';
  builtAt: string;
  room: string;
  anchors: SnapshotAnchors;
  refs: SnapshotRef[];
  prs: SnapshotPr[];
  decisions: SnapshotDecision[];
  verdicts: SnapshotVerdict[];
  gates: SnapshotGate[];
}

// ---------------------------------------------------------------------------
// Output: the check-in brief

export interface PartialReason {
  code: string;
  detail: string;
}

export interface BriefWatermark {
  messageCount: number | null;
  lastMessageId: string | null;
  lastMessageAt: string | null;
  mainSha: string | null;
}

export interface BriefHeader {
  room: string | null;
  builtAt: string | null;
  ageMs: number | null;
  status: 'COMPLETE' | 'PARTIAL';
  partialReasons: PartialReason[];
  watermark: BriefWatermark;
}

/** Claims cannot be projected from the pinned schema — always UNKNOWN. */
export interface ClaimsSection {
  status: 'UNKNOWN';
  reason: string;
  items: never[];
}

export interface BlockedItem {
  kind: 'BLOCKED' | 'HOLD';
  source: 'room' | 'decisions';
  ref: string;
  raisedBy: string | null;
  at: string | null;
  pr: number | null;
  excerpt: string;
  /** Not carried by the snapshot; null means "not derivable", never a guess. */
  waitingOn: null;
}

export interface VerdictEvidence {
  verdict: 'PASS' | 'FAIL';
  actor: string;
  at: string;
  sha: string | null;
  messageId: string;
  localCi: boolean;
}

export type ReviewState = 'no-verdicts' | 'after-fail' | 'no-valid-pass';

export interface ReviewItem {
  pr: number;
  title: string;
  url: string;
  author: string | null;
  headRefName: string;
  headRefOid: string;
  updatedAt: string;
  state: ReviewState;
  flags: string[];
  awaitingMe: boolean;
  verdicts: VerdictEvidence[];
}

export interface ReviewsSection {
  awaiting: ReviewItem[];
  satisfiedCount: number;
}

export type UnknownKind =
  | 'pass-fail-conflict'
  | 'orphan-verdict'
  | 'orphan-gate'
  | 'head-ref-missing'
  | 'extraction-caveat';

export interface UnknownItem {
  kind: UnknownKind;
  pr: number | null;
  detail: string;
  refs: string[];
}

export interface BriefSummary {
  openPrs: number;
  awaitingReviews: number;
  awaitingMe: number;
  blocked: number;
  holds: number;
  conflicts: number;
  satisfied: number;
}

export interface CheckinBrief {
  header: BriefHeader;
  claims: ClaimsSection;
  blocked: BlockedItem[];
  reviews: ReviewsSection;
  unknown: UnknownItem[];
  summary: BriefSummary;
}

export interface ProjectOptions {
  /** Whose check-in this is (e.g. 'agent:muse'); null = impersonal brief. */
  actor?: string | null;
  /** Injected clock — the projection never reads the wall clock itself. */
  now: Date;
  /** Snapshot older than this is reported stale. Default 30 minutes. */
  staleAfterMs?: number;
}

// State ledger: read-only aggregation of workroom state (room messages, git
// refs, gh PR state, decisions.tsv) into one snapshot with per-source anchors.
// The ledger never creates a verdict — PASS/FAIL/BLOCKED text is quoted from
// existing posts and decision rows, with the source reference attached.

export interface RoomMessage {
  id: string;
  actor_id: string;
  text: string;
  created_at: string;
}

export interface RefEntry {
  name: string; // full ref name, e.g. refs/heads/main
  sha: string;
}

export interface PrState {
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

export interface DecisionRow {
  ts: string;
  decision: string;
  reason: string;
  owner: string;
  evidence: string;
}

export interface RoomPage {
  messages: RoomMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** One page of room history. Implementations must be cursor-stable: the same
 * cursor always yields the same page while the room only appends. */
export interface RoomPageSource {
  fetchPage(cursor: string | null): Promise<RoomPage>;
}

export interface ProgressState {
  cursor: string | null;
  messages: RoomMessage[];
}

/** Persists partial room scans so an interrupted snapshot build resumes
 * instead of restarting a multi-thousand-message scan. */
export interface ProgressStore {
  load(): Promise<ProgressState | null>;
  save(state: ProgressState): Promise<void>;
  clear(): Promise<void>;
}

export interface SourceReaders {
  room: RoomPageSource;
  roomProgress: ProgressStore;
  readRefs(): Promise<RefEntry[]>;
  readPrs(): Promise<PrState[]>;
  readDecisions(): Promise<DecisionRow[]>;
}

export interface VerdictMention {
  pr: number;
  verdict: 'PASS' | 'FAIL';
  messageId: string;
  actor: string;
  at: string;
  sha: string | null;
  localCi: boolean;
  excerpt: string;
}

export interface GateMention {
  kind: 'BLOCKED' | 'HOLD';
  source: 'room' | 'decisions';
  ref: string; // room message id, or the decision row timestamp
  actor: string | null;
  at: string | null;
  pr: number | null;
  excerpt: string;
}

export interface StateSnapshot {
  schema: 'state-ledger/1';
  builtAt: string;
  room: string;
  anchors: {
    room: { messageCount: number; lastMessageId: string | null; lastMessageAt: string | null; hash: string };
    refs: { count: number; mainSha: string | null; hash: string };
    prs: { total: number; open: number; hash: string };
    decisions: { rows: number; lastTs: string | null; hash: string };
  };
  refs: RefEntry[];
  prs: PrState[];
  decisions: DecisionRow[];
  verdicts: VerdictMention[];
  gates: GateMention[];
}

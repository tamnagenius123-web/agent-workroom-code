// TRACKER-LOAD-QUERY pure aggregation (contract: room posts 813426ae /
// 59eac605; tracker row quoted verbatim in 63628aa1).
// Per-agent open load from tracker unit rows: counts by role (build =
// worker, review = verifier) and by open status. Pure and deterministic:
// the same input always gives the same output, agents are sorted by id,
// statuses follow TRACKER_OPEN_STATUSES order, and the input is not mutated.
// Done units carry no load and are excluded (counted in excluded_done).
// Agent cells are canonicalized before comparing and before bucketing
// (rev2, Claude FAIL 0d31518f + grok contract 7ee3189b/444f3f84): trim,
// lowercase, collapse inner whitespace, strip a leading worker:/verifier:
// label, then strip an agent: prefix. No display-name alias table: the
// tool expects agent ids. A verifier cell holding several names split by
// "/" is a set; a row whose canonical worker equals its verifier (or any
// set member) is rejected (author must not equal acceptor). A row blank
// on both sides is unclaimed: counted under unknown, never rejected. A
// row blank on exactly one side is rejected as missing_agent. A second
// row with an already-seen unit id is rejected as duplicate_unit. A row
// with a status outside the contract sets is rejected as unknown_status.
// rejected is sorted by id, so the same input always gives the same
// output regardless of input order.

export const TRACKER_OPEN_STATUSES = ['OPEN', 'CLAIMED', 'PUSHED', 'FAIL', 'BLOCKED', 'GATED'] as const;
export type TrackerOpenStatus = (typeof TRACKER_OPEN_STATUSES)[number];

const DONE_STATUSES = new Set(['DONE', 'PASS', 'PASSED', 'MERGED', 'CLOSED', 'COMPLETE', 'COMPLETED']);
const OPEN_SET = new Set<string>(TRACKER_OPEN_STATUSES);
export const UNKNOWN_AGENT = 'unknown';

export interface TrackerUnitInput {
  id?: unknown;
  worker?: unknown;
  verifier?: unknown;
  status?: unknown;
}

export interface RoleLoad {
  by_status: Record<TrackerOpenStatus, number>;
  open_total: number;
}

export interface AgentLoad {
  agent: string;
  build: RoleLoad;
  review: RoleLoad;
  open_total: number;
}

export interface TrackerLoadResult {
  agents: AgentLoad[];
  totals: { by_status: Record<TrackerOpenStatus, number>; open_total: number };
  counted_units: number;
  excluded_done: number;
  rejected: { id: string; reason: 'author_equals_acceptor' | 'unknown_status' | 'missing_agent' | 'duplicate_unit' }[];
}

function emptyRoleLoad(): RoleLoad {
  const by_status = {} as Record<TrackerOpenStatus, number>;
  for (const s of TRACKER_OPEN_STATUSES) by_status[s] = 0;
  return { by_status, open_total: 0 };
}

// Canonical agent id, or '' when the cell is blank (empty, dash-only,
// label-only, or not a string). Labels are stripped before the agent:
// prefix, per the rev2 contract order.
function canonAgent(value: unknown): string {
  if (typeof value !== 'string') return '';
  let s = value.trim().toLowerCase().replace(/\s+/g, ' ');
  s = s.replace(/^(?:worker|verifier):\s*/, '').replace(/^agent:\s*/, '').trim();
  if (s === '' || s === '—' || s === '-') return '';
  return s;
}

// A verifier cell may hold a "/"-separated set; each member canonicalizes
// on its own. An empty cell gives an empty set.
function canonAgentSet(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...new Set(value.split('/').map(canonAgent).filter(s => s !== ''))];
}

// First A-Z word, upper-cased: "CLAIMED 00:22 KST" -> CLAIMED. Exported for TG-UI views.
export function normStatus(value: unknown): string {
  if (typeof value !== 'string') return '';
  const first = value.trim().toUpperCase().split(/[^A-Z]+/).filter(Boolean)[0];
  return first ?? '';
}

export const isDoneStatus = (value: unknown): boolean => DONE_STATUSES.has(normStatus(value));

function normId(value: unknown, index: number): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : `row-${index}`;
}

export function computeTrackerLoad(units: readonly TrackerUnitInput[]): TrackerLoadResult {
  const perAgent = new Map<string, AgentLoad>();
  const totals = { by_status: emptyRoleLoad().by_status, open_total: 0 };
  const rejected: TrackerLoadResult['rejected'] = [];
  let counted = 0;
  let excludedDone = 0;

  const ensure = (agent: string): AgentLoad => {
    let row = perAgent.get(agent);
    if (!row) {
      row = { agent, build: emptyRoleLoad(), review: emptyRoleLoad(), open_total: 0 };
      perAgent.set(agent, row);
    }
    return row;
  };

  const seenIds = new Set<string>();
  units.forEach((unit, index) => {
    const id = normId(unit?.id, index);
    if (seenIds.has(id)) {
      rejected.push({ id, reason: 'duplicate_unit' });
      return;
    }
    seenIds.add(id);
    const status = normStatus(unit?.status);
    if (DONE_STATUSES.has(status)) { excludedDone += 1; return; }
    if (!OPEN_SET.has(status)) {
      rejected.push({ id, reason: 'unknown_status' });
      return;
    }
    const worker = canonAgent(unit?.worker);
    const verifiers = canonAgentSet(unit?.verifier);
    const open = status as TrackerOpenStatus;
    if (worker === '' && verifiers.length === 0) {
      // Unclaimed row: counted under unknown on both roles, never rejected.
      const row = ensure(UNKNOWN_AGENT);
      row.build.by_status[open] += 1;
      row.build.open_total += 1;
      row.review.by_status[open] += 1;
      row.review.open_total += 1;
      row.open_total += 2;
      totals.by_status[open] += 1;
      totals.open_total += 1;
      counted += 1;
      return;
    }
    if (worker === '' || verifiers.length === 0) {
      rejected.push({ id, reason: 'missing_agent' });
      return;
    }
    if (verifiers.includes(worker)) {
      rejected.push({ id, reason: 'author_equals_acceptor' });
      return;
    }
    const buildRow = ensure(worker);
    buildRow.build.by_status[open] += 1;
    buildRow.build.open_total += 1;
    buildRow.open_total += 1;
    for (const verifier of verifiers) {
      const reviewRow = ensure(verifier);
      reviewRow.review.by_status[open] += 1;
      reviewRow.review.open_total += 1;
      reviewRow.open_total += 1;
    }
    totals.by_status[open] += 1;
    totals.open_total += 1;
    counted += 1;
  });

  rejected.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const agents = [...perAgent.values()].sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
  return { agents, totals, counted_units: counted, excluded_done: excludedDone, rejected };
}

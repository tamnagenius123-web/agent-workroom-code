// Wake proof for one agent and one message (roadmap P0, contract v0 as amended by Fold R2).
// Five stages share one chain of ids:
//   persisted → emitted → relay_receipt → host_run → read_outcome
// Poll receipts and schedule/manual runs are a separate cause and never count as push.
// Pure: every instant is an input ISO string. This module does not read the clock.

export type WakeSource = 'webhook' | 'relay' | 'poll';
export type WakeCause = 'delivery' | 'schedule' | 'manual';
export type WakeStatus = 'proven' | 'missing' | 'invalid';
export type WakeVerdict = 'proven' | 'partial' | 'unproven';

export interface PersistedMessage {
  message_id: string;
  created_at: string;
  mentions: string[];
}

export interface EmittedDelivery {
  delivery_id: string;
  event_id: string;
  message_id: string;
  agent: string;
  attempt: number;
  emitted_at: string;
}

export interface RelayReceipt {
  delivery_id: string;
  event_id: string;
  message_id: string;
  agent: string;
  received_at: string;
  signature_verified: boolean;
  source: WakeSource;
}

export interface HostRun {
  run_id: string;
  delivery_id: string;
  event_id: string;
  agent: string;
  started_at: string;
  cause: WakeCause;
}

export interface ReadOutcome {
  run_id: string;
  message_id: string;
  agent: string;
  read_at: string;
  principal_authenticated: boolean;
  outcome_ref: string | null;
}

export interface WakeProofInput {
  agent: string;
  message_id: string;
  persisted?: PersistedMessage | null;
  emitted?: EmittedDelivery[];
  relay_receipts?: RelayReceipt[];
  host_runs?: HostRun[];
  read_outcomes?: ReadOutcome[];
  /** Later stages may lead the previous instant by at most this many milliseconds. Default 2000. */
  clockSkewMs?: number;
}

export interface PersistedStage {
  status: WakeStatus;
  reasons: string[];
  ids: { message_id: string | null };
}

export interface EmittedStage {
  status: WakeStatus;
  reasons: string[];
  ids: { delivery_id: string | null; event_id: string | null; message_id: string | null; attempt: number | null };
}

export interface RelayStage {
  status: WakeStatus;
  reasons: string[];
  ids: { delivery_id: string | null; event_id: string | null; message_id: string | null };
}

export interface HostStage {
  status: WakeStatus;
  reasons: string[];
  ids: { run_id: string | null; delivery_id: string | null; event_id: string | null };
}

export interface ReadStage {
  status: WakeStatus;
  reasons: string[];
  ids: { run_id: string | null; message_id: string | null; outcome_ref: string | null };
}

export interface WakeProofDuplicates {
  receipts: { delivery_id: string; count: number }[];
  replays: { delivery_id: string; run_id: string; received_at: string }[];
}

export interface WakeProofResult {
  agent: string;
  message_id: string;
  stages: {
    persisted: PersistedStage;
    emitted: EmittedStage;
    relay_receipt: RelayStage;
    host_run: HostStage;
    read_outcome: ReadStage;
  };
  verdict: WakeVerdict;
  duplicates: WakeProofDuplicates;
  notes: string[];
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const DEFAULT_SKEW_MS = 2000;

function msOf(value: string): number | null {
  if (typeof value !== 'string' || !ISO.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function skewOf(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SKEW_MS;
  return value < 0 ? 0 : value;
}

/** True when `later` is not earlier than `earlier` by more than the allowed skew. */
function leads(later: string, earlier: string, skew: number): 'ok' | 'early' | 'bad' {
  const left = msOf(later);
  const right = msOf(earlier);
  if (left === null || right === null) return 'bad';
  return left + skew >= right ? 'ok' : 'early';
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortBy<T>(items: readonly T[], timeOf: (item: T) => string, tieOf: (item: T) => string): T[] {
  return items.map((item, index) => ({ item, index })).sort((a, b) => {
    const left = msOf(timeOf(a.item));
    const right = msOf(timeOf(b.item));
    if (left !== null && right !== null && left !== right) return left - right;
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    const tie = cmpStr(tieOf(a.item), tieOf(b.item));
    return tie !== 0 ? tie : a.index - b.index;
  }).map(entry => entry.item);
}

function fewest<T>(items: readonly T[], problemsOf: (item: T) => readonly string[], timeOf: (item: T) => string, tieOf: (item: T) => string): T | null {
  if (!items.length) return null;
  const ranked = items.map((item, index) => ({ item, index, count: problemsOf(item).length, at: msOf(timeOf(item)) }));
  ranked.sort((a, b) => {
    if (a.count !== b.count) return a.count - b.count;
    if (a.at !== null && b.at !== null && a.at !== b.at) return a.at - b.at;
    if (a.at === null && b.at !== null) return 1;
    if (b.at === null && a.at !== null) return -1;
    const tie = cmpStr(tieOf(a.item), tieOf(b.item));
    return tie !== 0 ? tie : a.index - b.index;
  });
  return ranked[0]?.item ?? null;
}

function missingPersisted(): PersistedStage {
  return { status: 'missing', reasons: [], ids: { message_id: null } };
}
function missingEmitted(): EmittedStage {
  return { status: 'missing', reasons: [], ids: { delivery_id: null, event_id: null, message_id: null, attempt: null } };
}
function missingRelay(): RelayStage {
  return { status: 'missing', reasons: [], ids: { delivery_id: null, event_id: null, message_id: null } };
}
function missingHost(): HostStage {
  return { status: 'missing', reasons: [], ids: { run_id: null, delivery_id: null, event_id: null } };
}
function missingRead(): ReadStage {
  return { status: 'missing', reasons: [], ids: { run_id: null, message_id: null, outcome_ref: null } };
}

function emittedIds(row: EmittedDelivery): EmittedStage['ids'] {
  return { delivery_id: row.delivery_id, event_id: row.event_id, message_id: row.message_id, attempt: row.attempt };
}
function relayIds(row: RelayReceipt): RelayStage['ids'] {
  return { delivery_id: row.delivery_id, event_id: row.event_id, message_id: row.message_id };
}
function hostIds(row: HostRun): HostStage['ids'] {
  return { run_id: row.run_id, delivery_id: row.delivery_id, event_id: row.event_id };
}
function readIds(row: ReadOutcome): ReadStage['ids'] {
  return { run_id: row.run_id, message_id: row.message_id, outcome_ref: row.outcome_ref };
}

function verdictOf(stages: WakeProofResult['stages']): WakeVerdict {
  const all = [stages.persisted, stages.emitted, stages.relay_receipt, stages.host_run, stages.read_outcome];
  if (all.every(stage => stage.status === 'proven')) return 'proven';
  if (stages.persisted.status === 'proven' && stages.emitted.status === 'proven') return 'partial';
  return 'unproven';
}

interface Classified {
  replaySet: Set<RelayReceipt>;
  duplicates: WakeProofDuplicates;
}

function classify(agent: string, messageId: string, skew: number, receipts: readonly RelayReceipt[], runs: readonly HostRun[]): Classified {
  const scoped = receipts.filter(row => row.agent === agent && row.message_id === messageId);
  const groups = new Map<string, RelayReceipt[]>();
  for (const row of scoped) {
    const list = groups.get(row.delivery_id);
    if (list) list.push(row);
    else groups.set(row.delivery_id, [row]);
  }
  const replaySet = new Set<RelayReceipt>();
  const duplicateRows: WakeProofDuplicates['receipts'] = [];
  const replayRows: WakeProofDuplicates['replays'] = [];
  for (const deliveryId of [...groups.keys()].sort(cmpStr)) {
    const list = groups.get(deliveryId);
    if (!list) continue;
    if (list.length > 1) duplicateRows.push({ delivery_id: deliveryId, count: list.length });
    const anchor = sortBy(
      runs.filter(run => run.delivery_id === deliveryId && run.agent === agent && run.cause === 'delivery'),
      run => run.started_at,
      run => run.run_id,
    )[0];
    if (!anchor) continue;
    const anchorMs = msOf(anchor.started_at);
    if (anchorMs === null) continue;
    let caused = false;
    for (const row of sortBy(list, item => item.received_at, item => item.event_id)) {
      const receivedMs = msOf(row.received_at);
      if (receivedMs === null || row.event_id !== anchor.event_id) continue;
      if (caused && receivedMs > anchorMs + skew) {
        replaySet.add(row);
        replayRows.push({ delivery_id: deliveryId, run_id: anchor.run_id, received_at: row.received_at });
      } else if (receivedMs <= anchorMs + skew) {
        caused = true;
      }
    }
  }
  replayRows.sort((a, b) => cmpStr(a.delivery_id, b.delivery_id) || (msOf(a.received_at) ?? 0) - (msOf(b.received_at) ?? 0) || cmpStr(a.run_id, b.run_id));
  return { replaySet, duplicates: { receipts: duplicateRows, replays: replayRows } };
}

interface Chain {
  emitted: EmittedStage;
  relay: RelayStage;
  host: HostStage;
  read: ReadStage;
  suppressed: string[];
  emittedOk: number;
  relayOk: number;
  hostOk: number;
  readOk: number;
  received: number;
}

interface Env {
  agent: string;
  messageId: string;
  skew: number;
  createdAt: string | null;
  receipts: readonly RelayReceipt[];
  runs: readonly HostRun[];
  reads: readonly ReadOutcome[];
  replaySet: Set<RelayReceipt>;
}

function emittedProblems(row: EmittedDelivery, env: Env): string[] {
  const reasons: string[] = [];
  if (row.agent !== env.agent) reasons.push('agent_mismatch');
  if (row.message_id !== env.messageId) reasons.push('message_mismatch');
  if (msOf(row.emitted_at) === null) reasons.push('bad_timestamp');
  else if (env.createdAt !== null && msOf(env.createdAt) !== null && leads(row.emitted_at, env.createdAt, env.skew) === 'early') {
    reasons.push('emitted_before_created');
  }
  return reasons;
}

function linkReasons(row: RelayReceipt, emission: EmittedDelivery, env: Env): string[] {
  const reasons: string[] = [];
  if (row.agent !== env.agent) reasons.push('agent_mismatch');
  if (row.message_id !== env.messageId) reasons.push('message_mismatch');
  if (row.event_id !== emission.event_id) reasons.push('event_mismatch');
  if (row.delivery_id !== emission.delivery_id) reasons.push('delivery_mismatch');
  return reasons;
}

function relayProblems(row: RelayReceipt, emission: EmittedDelivery, env: Env): string[] {
  const reasons = linkReasons(row, emission, env);
  if (env.replaySet.has(row)) reasons.push('replay');
  if (row.source === 'poll') reasons.push('source_poll');
  if (row.signature_verified !== true) reasons.push('signature_unverified');
  if (msOf(row.received_at) === null) reasons.push('bad_timestamp');
  else if (msOf(emission.emitted_at) !== null && leads(row.received_at, emission.emitted_at, env.skew) === 'early') {
    reasons.push('received_before_emitted');
  }
  return reasons;
}

function hostProblems(run: HostRun, emission: EmittedDelivery, anchor: RelayReceipt | null, env: Env): string[] {
  const reasons: string[] = [];
  if (run.agent !== env.agent) reasons.push('agent_mismatch');
  if (run.event_id !== emission.event_id) reasons.push('event_mismatch');
  if (run.delivery_id !== emission.delivery_id) reasons.push('delivery_mismatch');
  if (run.cause === 'schedule') reasons.push('cause_schedule');
  else if (run.cause === 'manual') reasons.push('cause_manual');
  if (!anchor) reasons.push('no_relay_receipt');
  else if (msOf(run.started_at) === null || msOf(anchor.received_at) === null) reasons.push('bad_timestamp');
  else if (leads(run.started_at, anchor.received_at, env.skew) === 'early') reasons.push('started_before_received');
  return reasons;
}

function readProblems(row: ReadOutcome, run: HostRun | null, env: Env): string[] {
  const reasons: string[] = [];
  if (row.agent !== env.agent) reasons.push('agent_mismatch');
  if (row.message_id !== env.messageId) reasons.push('message_mismatch');
  if (!run) reasons.push('no_host_run');
  else if (row.run_id !== run.run_id) reasons.push('run_mismatch');
  if (row.principal_authenticated !== true) reasons.push('principal_unauthenticated');
  if (msOf(row.read_at) === null) reasons.push('bad_timestamp');
  else if (run && msOf(run.started_at) !== null && leads(row.read_at, run.started_at, env.skew) === 'early') {
    reasons.push('read_before_started');
  }
  return reasons;
}

function judgeRelay(emission: EmittedDelivery, env: Env): { stage: RelayStage; anchor: RelayReceipt | null } {
  const problemsOf = (row: RelayReceipt) => relayProblems(row, emission, env);
  const linked = env.receipts.filter(row => linkReasons(row, emission, env).length === 0 && !env.replaySet.has(row));
  const usable = sortBy(linked.filter(row => problemsOf(row).length === 0), row => row.received_at, row => row.delivery_id);
  const anchor = usable[0] ?? sortBy(linked, row => row.received_at, row => row.delivery_id)[0] ?? null;
  const proven = usable[0];
  if (proven) return { stage: { status: 'proven', reasons: [], ids: relayIds(proven) }, anchor: proven };
  if (!env.receipts.length) return { stage: missingRelay(), anchor: null };
  const chosen = fewest(env.receipts, problemsOf, row => row.received_at, row => `${row.delivery_id}\0${row.event_id}`);
  if (!chosen) return { stage: missingRelay(), anchor };
  return { stage: { status: 'invalid', reasons: problemsOf(chosen), ids: relayIds(chosen) }, anchor };
}

function judgeHost(emission: EmittedDelivery, anchor: RelayReceipt | null, env: Env): { stage: HostStage; run: HostRun | null; suppressed: string[] } {
  if (!env.runs.length) return { stage: missingHost(), run: null, suppressed: [] };
  const problemsOf = (run: HostRun) => hostProblems(run, emission, anchor, env);
  const usable = sortBy(env.runs.filter(run => problemsOf(run).length === 0), run => run.started_at, run => run.run_id);
  const chosen = usable[0];
  if (chosen) {
    return {
      stage: { status: 'proven', reasons: [], ids: hostIds(chosen) },
      run: chosen,
      suppressed: usable.slice(1).map(run => `suppressed run ${run.run_id}`),
    };
  }
  const explained = fewest(env.runs, problemsOf, run => run.started_at, run => run.run_id);
  if (!explained) return { stage: missingHost(), run: null, suppressed: [] };
  return { stage: { status: 'invalid', reasons: problemsOf(explained), ids: hostIds(explained) }, run: explained, suppressed: [] };
}

function judgeRead(run: HostRun | null, env: Env): ReadStage {
  if (!env.reads.length) return missingRead();
  const problemsOf = (row: ReadOutcome) => readProblems(row, run, env);
  const usable = sortBy(env.reads.filter(row => problemsOf(row).length === 0), row => row.read_at, row => row.run_id);
  const chosen = usable[0];
  if (chosen) return { status: 'proven', reasons: [], ids: readIds(chosen) };
  const explained = fewest(env.reads, problemsOf, row => row.read_at, row => row.run_id);
  if (!explained) return missingRead();
  return { status: 'invalid', reasons: problemsOf(explained), ids: readIds(explained) };
}

function judgeChain(emission: EmittedDelivery, env: Env): Chain {
  const emitReasons = emittedProblems(emission, env);
  const emitted: EmittedStage = { status: emitReasons.length ? 'invalid' : 'proven', reasons: emitReasons, ids: emittedIds(emission) };
  const relay = judgeRelay(emission, env);
  const host = judgeHost(emission, relay.anchor, env);
  const read = judgeRead(host.run, env);
  const linked = env.receipts.some(row => linkReasons(row, emission, env).length === 0);
  return {
    emitted, relay: relay.stage, host: host.stage, read, suppressed: host.suppressed,
    emittedOk: emitted.status === 'proven' ? 1 : 0,
    relayOk: relay.stage.status === 'proven' ? 1 : 0,
    hostOk: host.stage.status === 'proven' ? 1 : 0,
    readOk: read.status === 'proven' ? 1 : 0,
    received: linked ? 1 : 0,
  };
}

function better(a: Chain & { attempt: number; at: number; deliveryId: string }, b: Chain & { attempt: number; at: number; deliveryId: string }): boolean {
  if (a.emittedOk !== b.emittedOk) return a.emittedOk > b.emittedOk;
  if (a.relayOk !== b.relayOk) return a.relayOk > b.relayOk;
  if (a.hostOk !== b.hostOk) return a.hostOk > b.hostOk;
  if (a.readOk !== b.readOk) return a.readOk > b.readOk;
  if (a.received !== b.received) return a.received > b.received;
  if (a.attempt !== b.attempt) return a.attempt < b.attempt;
  if (a.at !== b.at) return a.at < b.at;
  return a.deliveryId < b.deliveryId;
}

function looseRelay(env: Env): RelayStage {
  if (!env.receipts.length) return missingRelay();
  const problemsOf = (row: RelayReceipt): string[] => {
    const reasons: string[] = [];
    if (row.agent !== env.agent) reasons.push('agent_mismatch');
    if (row.message_id !== env.messageId) reasons.push('message_mismatch');
    reasons.push('no_emitted_delivery');
    if (row.source === 'poll') reasons.push('source_poll');
    if (row.signature_verified !== true) reasons.push('signature_unverified');
    if (msOf(row.received_at) === null) reasons.push('bad_timestamp');
    return reasons;
  };
  const chosen = fewest(env.receipts, problemsOf, row => row.received_at, row => row.delivery_id);
  if (!chosen) return missingRelay();
  return { status: 'invalid', reasons: problemsOf(chosen), ids: relayIds(chosen) };
}

function looseHost(env: Env): { stage: HostStage; run: HostRun | null } {
  if (!env.runs.length) return { stage: missingHost(), run: null };
  const problemsOf = (run: HostRun): string[] => {
    const reasons: string[] = [];
    if (run.agent !== env.agent) reasons.push('agent_mismatch');
    reasons.push('no_emitted_delivery');
    if (run.cause === 'schedule') reasons.push('cause_schedule');
    else if (run.cause === 'manual') reasons.push('cause_manual');
    return reasons;
  };
  const chosen = fewest(env.runs, problemsOf, run => run.started_at, run => run.run_id);
  if (!chosen) return { stage: missingHost(), run: null };
  return { stage: { status: 'invalid', reasons: problemsOf(chosen), ids: hostIds(chosen) }, run: chosen };
}

export function evaluateWakeProof(input: WakeProofInput): WakeProofResult {
  const agent = input.agent;
  const messageId = input.message_id;
  const skew = skewOf(input.clockSkewMs);
  const notes: string[] = [];
  const persistedRec = input.persisted ?? null;
  const emittedAll = [...(input.emitted ?? [])];
  const envBase = {
    agent,
    messageId,
    skew,
    createdAt: persistedRec && persistedRec.message_id === messageId ? persistedRec.created_at : null,
    receipts: [...(input.relay_receipts ?? [])],
    runs: [...(input.host_runs ?? [])],
    reads: [...(input.read_outcomes ?? [])],
  };

  const persisted: PersistedStage = (() => {
    if (!persistedRec) return missingPersisted();
    const reasons: string[] = [];
    if (persistedRec.message_id !== messageId) reasons.push('message_mismatch');
    if (!persistedRec.mentions.includes(agent)) reasons.push('agent_not_mentioned');
    if (msOf(persistedRec.created_at) === null) reasons.push('bad_timestamp');
    if (reasons.includes('agent_not_mentioned')) notes.push('agent not mentioned');
    return { status: reasons.length ? 'invalid' : 'proven', reasons, ids: { message_id: persistedRec.message_id } };
  })();

  const { replaySet, duplicates } = classify(agent, messageId, skew, envBase.receipts, envBase.runs);
  const env: Env = { ...envBase, replaySet };
  const matched = emittedAll.filter(row => row.agent === agent && row.message_id === messageId);

  let emitted: EmittedStage;
  let relay: RelayStage;
  let host: HostStage;
  let read: ReadStage;
  let suppressed: string[] = [];

  if (!matched.length) {
    const explained = fewest(emittedAll, row => emittedProblems(row, env), row => row.emitted_at, row => row.delivery_id);
    emitted = explained
      ? { status: 'invalid', reasons: emittedProblems(explained, env), ids: emittedIds(explained) }
      : missingEmitted();
    relay = looseRelay(env);
    const loose = looseHost(env);
    host = loose.stage;
    read = judgeRead(loose.run, env);
  } else {
    let best: (Chain & { attempt: number; at: number; deliveryId: string; eventId: string }) | null = null;
    for (const row of matched) {
      const chain = judgeChain(row, env);
      const cand = { ...chain, attempt: row.attempt, at: msOf(row.emitted_at) ?? Number.POSITIVE_INFINITY, deliveryId: row.delivery_id, eventId: row.event_id };
      if (!best || better(cand, best)) best = cand;
    }
    const winner = best;
    if (!winner) {
      emitted = missingEmitted();
      relay = missingRelay();
      host = missingHost();
      read = missingRead();
    } else {
      emitted = winner.emitted;
      relay = winner.relay;
      host = winner.host;
      read = winner.read;
      suppressed = winner.suppressed;
      const group = matched.filter(row => row.event_id === winner.eventId);
      if (group.length > 1) {
        const attempts = [...group]
          .sort((a, b) => a.attempt - b.attempt || cmpStr(a.delivery_id, b.delivery_id))
          .map(row => String(row.attempt));
        notes.push(`retry ${winner.eventId} attempts ${attempts.join('>')} chosen ${winner.deliveryId}`);
      }
    }
  }

  for (const row of duplicates.receipts) notes.push(`duplicate receipt ${row.delivery_id} count ${row.count}`);
  for (const row of duplicates.replays) notes.push(`replay ${row.delivery_id} ${row.received_at} run ${row.run_id}`);
  for (const note of suppressed) notes.push(note);

  const stages = { persisted, emitted, relay_receipt: relay, host_run: host, read_outcome: read };
  return { agent, message_id: messageId, stages, verdict: verdictOf(stages), duplicates, notes };
}

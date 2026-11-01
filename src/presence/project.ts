import type {
  ActivityEvidence, ParsedDeliveries, PresenceOmitted, PresenceOptions, PresenceReport,
} from './types.ts';

const DEFAULT_ACTIVE_MS = 5 * 60_000;
const DEFAULT_RECENT_MS = 2 * 3_600_000;

const DELIVERY_ID_FIELDS = ['id', 'delivery_id', 'event_id', 'message_id'] as const;
const DELIVERY_TS_FIELDS = ['delivered_at', 'deliveredAt', 'timestamp', 'ts', 'created_at'] as const;
const DELIVERY_AGENT_FIELDS = ['agent_id', 'actor_id', 'principal'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function strField(rec: Record<string, unknown>, field: string): string | null {
  const v = rec[field];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function firstStr(rec: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const f of fields) {
    const v = strField(rec, f);
    if (v !== null) return v;
  }
  return null;
}
function parseMs(v: unknown): number | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
}
function firstMs(rec: Record<string, unknown>, fields: readonly string[]): number | null {
  for (const f of fields) {
    const n = parseMs(rec[f]);
    if (n !== null) return n;
  }
  return null;
}
const iso = (ms: number): string => new Date(ms).toISOString();

interface ValidMessage { agent: string; id: string; ms: number }
interface DeliveryCandidate { agent: string; ref: string; ms: number }

/** Parse webhook deliveries JSONL defensively: blank lines are ignored,
 *  unparseable lines are counted as malformed, never thrown. */
export function parseDeliveriesJsonl(text: string): ParsedDeliveries {
  const entries: unknown[] = [];
  let malformedLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      malformedLines++;
    }
  }
  return { entries, malformedLines };
}

/**
 * Build the presence/activity projection. Pure: no I/O, no wall clock.
 * Pipeline: validate → dedup deliveries → attribute → clamp skew → aggregate.
 */
export function buildPresenceReport(
  input: { messages: unknown; deliveries?: readonly unknown[] },
  options: PresenceOptions = {},
): PresenceReport {
  const activeWithinMs = options.activeWithinMs ?? DEFAULT_ACTIVE_MS;
  const recentWithinMs = options.recentWithinMs ?? DEFAULT_RECENT_MS;
  const omitted: PresenceOmitted = {
    messages_invalid: 0,
    delivery_lines_malformed: options.deliveryMalformedLines ?? 0,
    deliveries_invalid: 0,
    deliveries_unattributed: 0,
    duplicate_deliveries: 0,
    clamped_timestamps: 0,
  };

  // --- validate messages -------------------------------------------------
  const rawMessages = Array.isArray(input.messages) ? input.messages : [];
  const messages: ValidMessage[] = [];
  for (const raw of rawMessages) {
    if (!isRecord(raw)) { omitted.messages_invalid++; continue; }
    const id = strField(raw, 'id');
    const agent = strField(raw, 'actor_id');
    const ms = parseMs(raw['created_at']);
    if (id === null || agent === null || ms === null) { omitted.messages_invalid++; continue; }
    messages.push({ agent, id, ms });
  }

  // --- validate + dedup + attribute deliveries ---------------------------
  const rawDeliveries = input.deliveries ?? [];
  const seenKeys = new Set<string>();
  const deliveries: DeliveryCandidate[] = [];
  for (const raw of rawDeliveries) {
    if (!isRecord(raw)) { omitted.deliveries_invalid++; continue; }
    const ms = firstMs(raw, DELIVERY_TS_FIELDS);
    const ref = firstStr(raw, DELIVERY_ID_FIELDS);
    if (ms === null || ref === null) { omitted.deliveries_invalid++; continue; }
    const deliveryId = strField(raw, 'id') ?? strField(raw, 'delivery_id') ?? strField(raw, 'event_id');
    const key = deliveryId !== null ? `id:${deliveryId}` : `msgts:${ref}:${ms}`;
    if (seenKeys.has(key)) { omitted.duplicate_deliveries++; continue; }
    seenKeys.add(key);
    const agent = firstStr(raw, DELIVERY_AGENT_FIELDS) ?? options.deliveriesAgent ?? null;
    if (agent === null) { omitted.deliveries_unattributed++; continue; }
    deliveries.push({ agent, ref, ms });
  }

  // --- effective now -------------------------------------------------------
  let nowMs: number | null = null;
  if (options.asOf !== undefined) {
    const parsed = parseMs(options.asOf);
    if (parsed === null) throw new TypeError(`presence: unparseable asOf: ${options.asOf}`);
    nowMs = parsed;
  } else {
    for (const m of messages) nowMs = nowMs === null ? m.ms : Math.max(nowMs, m.ms);
    for (const d of deliveries) nowMs = nowMs === null ? d.ms : Math.max(nowMs, d.ms);
  }

  // --- aggregate -----------------------------------------------------------
  interface Agg {
    lastMsg: { ms: number; id: string } | null;
    lastDlv: { ms: number; ref: string } | null;
    messages: number;
    deliveries: number;
    skew: boolean;
  }
  const byAgent = new Map<string, Agg>();
  const aggOf = (agent: string): Agg => {
    let a = byAgent.get(agent);
    if (!a) { a = { lastMsg: null, lastDlv: null, messages: 0, deliveries: 0, skew: false }; byAgent.set(agent, a); }
    return a;
  };
  const clamp = (a: Agg, ms: number): number => {
    if (nowMs !== null && ms > nowMs) { a.skew = true; omitted.clamped_timestamps++; return nowMs; }
    return ms;
  };
  for (const m of messages) {
    const a = aggOf(m.agent);
    a.messages++;
    const ms = clamp(a, m.ms);
    if (a.lastMsg === null || ms > a.lastMsg.ms) a.lastMsg = { ms, id: m.id };
  }
  for (const d of deliveries) {
    const a = aggOf(d.agent);
    a.deliveries++;
    const ms = clamp(a, d.ms);
    if (a.lastDlv === null || ms > a.lastDlv.ms) a.lastDlv = { ms, ref: d.ref };
  }

  // --- rows ------------------------------------------------------------------
  const agents: ActivityEvidence[] = [...byAgent.entries()]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([agent_id, a]) => {
      const lastMs = Math.max(a.lastMsg?.ms ?? -Infinity, a.lastDlv?.ms ?? -Infinity);
      const has = Number.isFinite(lastMs);
      const age = has && nowMs !== null ? nowMs - lastMs : null;
      return {
        agent_id,
        last_activity_at: has ? iso(lastMs) : null,
        last_message_id: a.lastMsg?.id ?? null,
        last_delivery_at: a.lastDlv !== null ? iso(a.lastDlv.ms) : null,
        evidence: {
          message_ids: a.lastMsg !== null ? [a.lastMsg.id] : [],
          delivery_ids: a.lastDlv !== null ? [a.lastDlv.ref] : [],
        },
        counts: { messages: a.messages, deliveries: a.deliveries },
        classification: !has || age === null ? 'unknown'
          : age <= activeWithinMs ? 'active'
          : age <= recentWithinMs ? 'recent' : 'stale',
        clock_skew: a.skew,
      };
    });

  return {
    basis: 'activity-evidence',
    not_wake_proof: true,
    as_of: nowMs !== null ? iso(nowMs) : null,
    thresholds: { active_within_ms: activeWithinMs, recent_within_ms: recentWithinMs },
    inputs: {
      messages_seen: rawMessages.length,
      messages_used: messages.length,
      deliveries_seen: rawDeliveries.length,
      deliveries_used: deliveries.length,
    },
    omitted,
    clock_skew_detected: omitted.clamped_timestamps > 0,
    agents,
  };
}

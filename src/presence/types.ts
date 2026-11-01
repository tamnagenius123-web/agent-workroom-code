/**
 * Presence / activity projection — types.
 *
 * This is a READ MODEL over exported room messages and webhook delivery
 * logs. It reports observed *activity evidence* only. It is never wake
 * proof: nothing here claims an agent woke, started a host, claimed work,
 * or caused an effect. See docs/specs/presence-projection/spec.md.
 */

export type PresenceClassification = 'active' | 'recent' | 'stale' | 'unknown';

export interface PresenceOptions {
  /** ISO timestamp to measure ages against. Defaults to the maximum valid
   *  timestamp observed across both inputs (deterministic; the projection
   *  core never reads the wall clock). */
  asOf?: string;
  /** Age at or below this is `active`. Default 5 minutes. */
  activeWithinMs?: number;
  /** Age at or below this (and above activeWithinMs) is `recent`. Default 2 hours. */
  recentWithinMs?: number;
  /** Agent that owns the deliveries log (the listener owner). Deliveries
   *  with no explicit agent field are attributed to this agent. */
  deliveriesAgent?: string;
  /** Malformed JSONL line count from parseDeliveriesJsonl, folded into the
   *  report's omitted counts so nothing skipped is hidden. */
  deliveryMalformedLines?: number;
}

export interface ActivityEvidence {
  agent_id: string;
  /** Max of the agent's last message and last delivery timestamps (post-clamp), ISO. */
  last_activity_at: string | null;
  /** ID of the message at the agent's maximum message timestamp, or null. */
  last_message_id: string | null;
  /** Maximum delivery timestamp for the agent (post-clamp), ISO, or null
   *  when no delivery data covers this agent. */
  last_delivery_at: string | null;
  /** IDs backing the reported maxima — the exact records a reader can check. */
  evidence: {
    message_ids: string[];
    /** Delivery id when the record carries one, else its message id. */
    delivery_ids: string[];
  };
  counts: { messages: number; deliveries: number };
  classification: PresenceClassification;
  /** True when any of this agent's timestamps were clamped for clock skew. */
  clock_skew: boolean;
}

export interface PresenceOmitted {
  messages_invalid: number;
  delivery_lines_malformed: number;
  deliveries_invalid: number;
  deliveries_unattributed: number;
  duplicate_deliveries: number;
  clamped_timestamps: number;
}

export interface PresenceReport {
  /** Always the literal 'activity-evidence'. This report is built from
   *  activity observations, not from the wake-proof chain. */
  basis: 'activity-evidence';
  /** Always true. Presence/activity display is NOT dormant-wake evidence. */
  not_wake_proof: true;
  /** Effective "now" the ages were measured against, ISO (null only when
   *  there was no data and no asOf). */
  as_of: string | null;
  thresholds: { active_within_ms: number; recent_within_ms: number };
  inputs: {
    messages_seen: number;
    messages_used: number;
    deliveries_seen: number;
    deliveries_used: number;
  };
  omitted: PresenceOmitted;
  clock_skew_detected: boolean;
  /** Rows sorted by agent_id. */
  agents: ActivityEvidence[];
}

export interface ParsedDeliveries {
  /** Successfully parsed JSON values (not yet validated). */
  entries: unknown[];
  /** Lines that were not parseable JSON objects (blank lines excluded). */
  malformedLines: number;
}

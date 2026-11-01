import { ROOM, Fault, wakeRelaySchema, wakeHostSchema, wakeReadSchema, type WakeProofQuery, type WakeReportInput } from './contracts.ts';
import type { Database } from './db.ts';
import { evaluateWakeProof, type HostRun, type PersistedMessage, type ReadOutcome, type RelayReceipt, type EmittedDelivery } from './wake-proof.ts';

// persisted and emitted are server records. relay_receipt, host_run and read_outcome are claimed
// by the caller. A caller can store only its own principal. recorded_at is the server clock.
export const WAKE_EVIDENCE_SOURCE = 'server: persisted/emitted; host-reported: relay_receipt/host_run/read_outcome';
const CLAIMED_NOTE = 'Agent-supplied timestamps are claimed host-reported values and are not server-verified. recorded_at is stamped by the server.';

const REPORT_DESCRIPTION = 'Record one host-side wake stage for yourself only (relay_receipt, host_run, or read_outcome) against message_id. agent must be your principal id or your own alias; another agent is rejected. relay_receipt and read_outcome payloads must use that same message_id. The same idempotency key and payload returns the stored row; the same key with a different payload conflicts. recorded_at is server-stamped. Timestamps you supply are claimed host-reported values and are not server-verified.';
const PROOF_DESCRIPTION = 'Read the wake proof for one message and one agent (principal id or alias). Any room member may read. persisted and emitted are server records (messages, mentions, webhook outbox). relay_receipt, host_run and read_outcome are host-reported and not server-verified. evidence_source: ' + WAKE_EVIDENCE_SOURCE;

export const WAKE_REPORT_TOOL = { name: 'workroom_wake_report', readOnly: false, description: REPORT_DESCRIPTION } as const;
export const WAKE_PROOF_TOOL = { name: 'workroom_wake_proof', readOnly: true, description: PROOF_DESCRIPTION } as const;
export const WAKE_READ_TOOLS = [WAKE_PROOF_TOOL.name] as const;
export const WAKE_WRITE_TOOLS = [WAKE_REPORT_TOOL.name] as const;

const missing = (e: unknown) => /no such table/i.test(String((e as Error)?.message ?? e));

async function hasTable(db: Database, name: 'wake_evidence' | 'webhook_outbox' | 'message_mentions' | 'agent_aliases'): Promise<boolean> {
  try { await db.prepare(`SELECT 1 FROM ${name} LIMIT 0`).all(); return true; }
  catch (e) { if (missing(e)) return false; throw e; }
}

function isoFromMs(value: number | string): string {
  if (typeof value === 'string' && value.includes('T')) return value;
  const ms = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(value);
}

// event_id is payload_json.event_id when that field is a non-empty string; otherwise the outbox row id.
function eventIdFrom(payloadJson: string, id: string): string {
  try {
    const parsed = JSON.parse(payloadJson) as { event_id?: unknown };
    if (typeof parsed?.event_id === 'string' && parsed.event_id.length > 0) return parsed.event_id;
  } catch { /* fall back to the outbox id */ }
  return id;
}

export async function resolveWakeAgent(db: Database, agent: string): Promise<string> {
  if (!await hasTable(db, 'agent_aliases')) return agent;
  const exact = await db.prepare('SELECT principal_id FROM agent_aliases WHERE alias=?').bind(agent).first<{ principal_id: string }>();
  if (exact) return exact.principal_id;
  const folded = await db.prepare('SELECT principal_id FROM agent_aliases WHERE lower(alias)=lower(?)').bind(agent).first<{ principal_id: string }>();
  return folded?.principal_id ?? agent;
}

async function loadPersisted(db: Database, messageId: string): Promise<PersistedMessage | null> {
  const message = await db.prepare('SELECT id, created_at FROM messages WHERE id=? AND room_id=?')
    .bind(messageId, ROOM).first<{ id: string; created_at: string }>();
  if (!message) return null;
  let mentions: string[] = [];
  if (await hasTable(db, 'message_mentions')) {
    const rows = await db.prepare('SELECT principal_id FROM message_mentions WHERE message_id=?')
      .bind(messageId).all<{ principal_id: string }>();
    mentions = rows.results.map(row => row.principal_id);
  }
  return { message_id: message.id, created_at: message.created_at, mentions };
}

async function loadEmitted(db: Database, agent: string, messageId: string): Promise<EmittedDelivery[]> {
  if (!await hasTable(db, 'webhook_outbox')) return [];
  const rows = await db.prepare(`SELECT id, principal_id, message_id, payload_json, attempts, created_at
    FROM webhook_outbox WHERE principal_id=? AND message_id=?`)
    .bind(agent, messageId).all<{ id: string; principal_id: string; message_id: string; payload_json: string; attempts: number | string; created_at: number | string }>();
  return rows.results.map(row => {
    const attempt = Number(row.attempts);
    return {
      delivery_id: row.id,
      event_id: eventIdFrom(row.payload_json, row.id),
      message_id: row.message_id,
      agent: row.principal_id,
      attempt: Number.isFinite(attempt) ? attempt : 0,
      emitted_at: isoFromMs(row.created_at),
    };
  });
}

async function loadHost(db: Database, agent: string, messageId: string): Promise<{ receipts: RelayReceipt[]; runs: HostRun[]; reads: ReadOutcome[] }> {
  const empty = { receipts: [] as RelayReceipt[], runs: [] as HostRun[], reads: [] as ReadOutcome[] };
  if (!await hasTable(db, 'wake_evidence')) return empty;
  const rows = await db.prepare(`SELECT stage, payload_json FROM wake_evidence
    WHERE message_id=? AND principal_id=? ORDER BY recorded_at, id`)
    .bind(messageId, agent).all<{ stage: string; payload_json: string }>();
  for (const row of rows.results) {
    let value: unknown;
    try { value = JSON.parse(row.payload_json); } catch { continue; }
    if (row.stage === 'relay_receipt') {
      const parsed = wakeRelaySchema.safeParse(value);
      if (parsed.success) empty.receipts.push(parsed.data);
    } else if (row.stage === 'host_run') {
      const parsed = wakeHostSchema.safeParse(value);
      if (parsed.success) empty.runs.push(parsed.data);
    } else if (row.stage === 'read_outcome') {
      const parsed = wakeReadSchema.safeParse(value);
      if (parsed.success) empty.reads.push(parsed.data);
    }
  }
  return empty;
}

interface EvidenceRow {
  id: string;
  principal_id: string;
  stage: string;
  message_id: string;
  delivery_id: string | null;
  event_id: string | null;
  run_id: string | null;
  payload_json: string;
  idempotency_key: string;
  recorded_at: number | string;
}

interface Extracted {
  stage: WakeReportInput['stage'];
  messageId: string;
  deliveryId: string | null;
  eventId: string | null;
  runId: string | null;
  payloadJson: string;
}

function claimedFrom(stage: string, payload: Record<string, unknown>): Record<string, string> {
  if (stage === 'relay_receipt' && typeof payload.received_at === 'string') return { received_at: payload.received_at };
  if (stage === 'host_run' && typeof payload.started_at === 'string') return { started_at: payload.started_at };
  if (stage === 'read_outcome' && typeof payload.read_at === 'string') return { read_at: payload.read_at };
  return {};
}

export class WakeProofs {
  constructor(private db: Database, private principal: string) {}

  private async ownAgent(agent: string): Promise<string> {
    const resolved = await resolveWakeAgent(this.db, agent);
    if (resolved !== this.principal) throw new Fault('FORBIDDEN', 'A caller can report only its own wake evidence.', 403);
    return resolved;
  }

  private async extract(input: WakeReportInput): Promise<Extracted> {
    const sameMessage = (messageId: string) => {
      if (messageId !== input.message_id) throw new Fault('INVALID_INPUT', 'message_id does not match the stage payload.');
    };
    if (input.stage === 'relay_receipt') {
      const row = input.relay_receipt;
      if (!row) throw new Fault('INVALID_INPUT', 'Stage payload is required.');
      sameMessage(row.message_id);
      const agent = await this.ownAgent(row.agent);
      return {
        stage: input.stage, messageId: input.message_id, deliveryId: row.delivery_id, eventId: row.event_id, runId: null,
        payloadJson: JSON.stringify({
          delivery_id: row.delivery_id, event_id: row.event_id, message_id: row.message_id, agent,
          received_at: row.received_at, signature_verified: row.signature_verified, source: row.source,
        }),
      };
    }
    if (input.stage === 'host_run') {
      const row = input.host_run;
      if (!row) throw new Fault('INVALID_INPUT', 'Stage payload is required.');
      const agent = await this.ownAgent(row.agent);
      return {
        stage: input.stage, messageId: input.message_id, deliveryId: row.delivery_id, eventId: row.event_id, runId: row.run_id,
        payloadJson: JSON.stringify({
          run_id: row.run_id, delivery_id: row.delivery_id, event_id: row.event_id, agent,
          started_at: row.started_at, cause: row.cause,
        }),
      };
    }
    const row = input.read_outcome;
    if (input.stage !== 'read_outcome' || !row) throw new Fault('INVALID_INPUT', 'Stage payload is required.');
    sameMessage(row.message_id);
    const agent = await this.ownAgent(row.agent);
    return {
      stage: input.stage, messageId: input.message_id, deliveryId: null, eventId: null, runId: row.run_id,
      payloadJson: JSON.stringify({
        run_id: row.run_id, message_id: row.message_id, agent, read_at: row.read_at,
        principal_authenticated: row.principal_authenticated, outcome_ref: row.outcome_ref,
      }),
    };
  }

  private present(row: EvidenceRow, replayed: boolean) {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const recorded = isoFromMs(row.recorded_at);
    return {
      data: {
        id: row.id, principal_id: row.principal_id, stage: row.stage, message_id: row.message_id,
        delivery_id: row.delivery_id, event_id: row.event_id, run_id: row.run_id,
        idempotency_key: row.idempotency_key, recorded_at: recorded, replayed, payload,
        timestamps: {
          recorded_at: { value: recorded, authority: 'server' as const },
          claimed: { authority: 'host-reported' as const, server_verified: false as const, values: claimedFrom(row.stage, payload) },
        },
      },
      meta: { replayed, note: CLAIMED_NOTE },
    };
  }

  async report(input: WakeReportInput) {
    if (!await hasTable(this.db, 'wake_evidence')) {
      throw new Fault('NOT_AVAILABLE', 'Wake evidence cannot be recorded because wake_evidence is not installed.', 400, 'not_applied');
    }
    const extracted = await this.extract(input);
    const id = crypto.randomUUID();
    const recordedAt = Date.now();
    await this.db.prepare(`INSERT INTO wake_evidence(id,principal_id,stage,message_id,delivery_id,event_id,run_id,payload_json,idempotency_key,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(principal_id, idempotency_key) DO NOTHING`)
      .bind(id, this.principal, extracted.stage, extracted.messageId, extracted.deliveryId, extracted.eventId, extracted.runId, extracted.payloadJson, input.idempotency_key, recordedAt)
      .all();
    const row = await this.db.prepare(`SELECT id,principal_id,stage,message_id,delivery_id,event_id,run_id,payload_json,idempotency_key,recorded_at
      FROM wake_evidence WHERE principal_id=? AND idempotency_key=?`)
      .bind(this.principal, input.idempotency_key).first<EvidenceRow>();
    if (!row) throw new Fault('TEMPORARY_FAILURE', 'Wake evidence was not stored.', 503, 'unknown', true);
    if (row.payload_json !== extracted.payloadJson || row.stage !== extracted.stage) {
      throw new Fault('IDEMPOTENCY_CONFLICT', 'Key already has different wake evidence.', 409, 'not_applied', false, { idempotency_key: input.idempotency_key });
    }
    return this.present(row, row.id !== id);
  }

  async proof(input: WakeProofQuery) {
    const agent = await resolveWakeAgent(this.db, input.agent);
    const persisted = await loadPersisted(this.db, input.message_id);
    const emitted = await loadEmitted(this.db, agent, input.message_id);
    const host = await loadHost(this.db, agent, input.message_id);
    const result = evaluateWakeProof({
      agent, message_id: input.message_id, persisted, emitted,
      relay_receipts: host.receipts, host_runs: host.runs, read_outcomes: host.reads,
    });
    return {
      data: {
        ...result,
        notes: [...result.notes, WAKE_EVIDENCE_SOURCE],
        evidence_source: WAKE_EVIDENCE_SOURCE,
        time_authority: {
          persisted: 'server' as const,
          emitted: 'server' as const,
          relay_receipt: 'host-reported' as const,
          host_run: 'host-reported' as const,
          read_outcome: 'host-reported' as const,
        },
      },
      meta: { evidence_source: WAKE_EVIDENCE_SOURCE },
    };
  }
}

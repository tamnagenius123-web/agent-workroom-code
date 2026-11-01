// Read-only projections of tasks, task_leases, task_audit, and task_submissions.
// G3 stores no verifier column. Approve authority is an active posting principal_roles.kind = 'user',
// so each such member is a verifier of each review submission. worker == that user is flagged.

import { Fault } from './contracts.ts';
import type { Database } from './db.ts';
import type { Workroom } from './domain.ts';
import { DB_NOW } from './tasks.ts';
import {
  STALE_CLAIM_THRESHOLD_MS, listStaleClaims, verifierQueue,
  type ClaimRow, type StaleClaim, type VerificationRow, type VerifierQueueView,
} from './claim-views.ts';

const STALE_PATH = /^\/api\/v1\/rooms\/([^/]+)\/claims\/stale$/;
const QUEUE_PATH = /^\/api\/v1\/rooms\/([^/]+)\/verifier-queue$/;

export interface StaleClaimsData {
  server_time_ms: number;
  threshold_ms: number;
  claims: StaleClaim[];
}

export interface VerifierQueueData extends VerifierQueueView {
  server_time_ms: number;
}

export type ClaimViewsData = StaleClaimsData | VerifierQueueData;

interface Stamp { now_ms: number }
interface ClaimSql {
  unit_id: string;
  assignee: string | null;
  state: string;
  claimed_at: string | null;
  updated_at_ms: number | null;
}
interface QueueSql {
  unit_id: string;
  state: string;
  worker_principal: string;
  verifier_principal: string;
  awaiting_since_ms: number;
}

function instantMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function serverNow(db: Database): Promise<number> {
  const row = await db.prepare(`SELECT ${DB_NOW} AS now_ms`).first<Stamp>();
  const now = instantMs(row?.now_ms);
  if (now === null) throw new Fault('TEMPORARY_FAILURE', 'Server clock is unavailable.', 503, 'unknown', true);
  return now;
}

async function claimRows(db: Database, room: string): Promise<ClaimRow[]> {
  const loaded = await db.prepare(`SELECT t.id AS unit_id, l.holder_id AS assignee, t.state AS state,
      (SELECT a.created_at FROM task_audit a
        WHERE a.target_id = t.id AND a.room_id = t.room_id AND a.operation = 'task.claim'
        ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS claimed_at,
      t.updated_at_ms AS updated_at_ms
    FROM tasks t
    JOIN task_leases l ON l.task_id = t.id
    WHERE t.room_id = ? AND t.state = 'in_progress' AND l.holder_id IS NOT NULL`).bind(room).all<ClaimSql>();
  return loaded.results.map(row => ({
    unit_id: row.unit_id,
    assignee: row.assignee,
    state: row.state,
    claimed_at_ms: instantMs(row.claimed_at) ?? instantMs(row.updated_at_ms),
  }));
}

async function verificationRows(db: Database, room: string): Promise<VerificationRow[]> {
  const loaded = await db.prepare(`SELECT t.id AS unit_id, t.state AS state, s.actor_id AS worker_principal,
      u.principal_id AS verifier_principal, s.submitted_at_ms AS awaiting_since_ms
    FROM tasks t
    JOIN task_submissions s ON s.id = t.current_submission_id AND s.task_id = t.id AND s.disposition = 'review'
    JOIN principal_roles u ON u.kind = 'user'
    JOIN principals p ON p.id = u.principal_id AND p.active = 1
    JOIN memberships m ON m.principal_id = u.principal_id AND m.room_id = t.room_id AND m.active = 1 AND m.can_post = 1
    WHERE t.room_id = ? AND t.state = 'review'`).bind(room).all<QueueSql>();
  return loaded.results.map(row => ({
    unit_id: row.unit_id,
    state: row.state,
    worker_principal: row.worker_principal,
    verifier_principal: row.verifier_principal,
    awaiting_since_ms: row.awaiting_since_ms,
  }));
}

export async function claimViewsRoute(service: Workroom, request: Request, url: URL): Promise<{ data: ClaimViewsData; meta: { count: number; flagged?: number } } | null> {
  const stale = STALE_PATH.exec(url.pathname);
  const queue = stale ? null : QUEUE_PATH.exec(url.pathname);
  const match = stale ?? queue;
  if (!match) return null;
  if (request.method !== 'GET') throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
  if (url.search) throw new Fault('INVALID_INPUT', 'Unsupported query parameters.');
  const room = decodeURIComponent(match[1] ?? '');
  await service.authorize(room);
  const now = await serverNow(service.database);
  if (stale) {
    const claims = listStaleClaims(await claimRows(service.database, room), now);
    const data: StaleClaimsData = { server_time_ms: now, threshold_ms: STALE_CLAIM_THRESHOLD_MS, claims };
    return { data, meta: { count: claims.length } };
  }
  const view = verifierQueue(await verificationRows(service.database, room));
  const data: VerifierQueueData = { server_time_ms: now, groups: view.groups, flagged: view.flagged };
  const listed = view.groups.reduce((count, group) => count + group.units.length, 0);
  return { data, meta: { count: listed, flagged: view.flagged.length } };
}

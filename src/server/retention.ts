// BOUNDARY CONTRACT — mirrors src/server/retention.ts in the gate MCP repo
// (agent-workroom-gate-mcp), split out under owner decision D5-cm (2026-11-01).
//
// RETENTION windows are policy constants (contract data) and are declared
// here. The retention run itself — which counts and deletes auth/delivery
// bookkeeping rows — is gate-side behavior and fails closed with
// BoundaryUnavailableError; no deletion is ever simulated in this repo.
// Phase 2 replaces this seam with gate-MCP calls.
import { boundaryUnavailable } from '../boundary.ts';
import type { Database } from './db.ts';

// R8: retention for auth/delivery bookkeeping. Messages, operations and audit stay immutable (append-only record).
export const RETENTION = {
  oauth_codes_ms: 86400_000,            // expired/used codes: 1 day after expiry
  oauth_tokens_ms: 7 * 86400_000,       // tokens: 7 days after expiry or revocation
  consent_flows_ms: 86400_000,
  auth_audit_ms: 90 * 86400_000,
  webhook_outbox_ms: 14 * 86400_000,    // delivered/failed rows only
  gate_ms: 86400_000,
  retention_runs_ms: 30 * 86400_000,
};

export async function retain(_db: Database, _now = Date.now(), _mode: 'dry_run' | 'delete' = 'dry_run'): Promise<Record<string, number | string>> {
  return boundaryUnavailable('src/server/retention.ts', 'retain', _db, _now, _mode);
}

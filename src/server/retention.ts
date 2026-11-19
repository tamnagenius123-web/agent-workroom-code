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

// Dry run by default: counts what would be deleted. Deletes only when mode==='delete'.
export async function retain(db: Database, now = Date.now(), mode: 'dry_run' | 'delete' = 'dry_run') {
  const r = RETENTION;
  const jobs: [string, string, (string | number)[]][] = [
    ['oauth_codes', 'DELETE FROM oauth_codes WHERE expires_at<?', [now - r.oauth_codes_ms]],
    ['oauth_tokens', 'DELETE FROM oauth_tokens WHERE COALESCE(revoked_at, expires_at)<? AND expires_at<?', [now - r.oauth_tokens_ms, now]],
    ['consent_flows', 'DELETE FROM consent_flows WHERE expires_at<?', [now - r.consent_flows_ms]],
    ['auth_audit', 'DELETE FROM auth_audit WHERE at<?', [now - r.auth_audit_ms]],
    ['webhook_outbox', "DELETE FROM webhook_outbox WHERE status IN ('delivered','failed') AND COALESCE(terminal_at, created_at)<?", [now - r.webhook_outbox_ms]],
    ['requester_gate', 'DELETE FROM requester_gate WHERE locked_until<? AND window_start<?', [now, now - r.gate_ms]],
    ['retention_runs', 'DELETE FROM retention_runs WHERE at<?', [now - r.retention_runs_ms]],
  ];
  const out: Record<string, number | string> = {};
  for (const [name, sql, args] of jobs) {
    try {
      if (mode === 'delete') { const res = await db.prepare(sql).bind(...args).all() as unknown as { meta?: { changes?: number } }; out[name] = res.meta?.changes ?? 0; }
      else out[name] = (await db.prepare(sql.replace(/^DELETE FROM (\w+)/, 'SELECT COUNT(*) n FROM $1')).bind(...args).first<{ n: number }>())?.n ?? 0;
    }
    catch (e) { out[name] = 'error: ' + String((e as Error).message).slice(0, 80); }
  }
  try { await db.prepare('INSERT INTO retention_runs(at,result_json) VALUES (?,?)').bind(now, JSON.stringify({ mode, ...out })).all(); } catch { /* pre-0010 schema */ }
  return out;
}

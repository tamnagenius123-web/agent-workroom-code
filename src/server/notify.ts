// BOUNDARY CONTRACT — mirrors src/server/notify.ts in the gate MCP repo (agent-workroom-gate-mcp).
//
// This repo (the public codebase) was split from the gate repo; webhook registration, mention
// resolution against the delivery tables, and outbound webhook delivery live on the gate side.
// Only the type declarations and contract constants are declared here. Runtime entry points fail
// closed: nothing is notified, delivered, or registered from this repo, and no wake credentials
// exist here, so wake auth always resolves to NO_WAKE_AUTH. Phase 2 replaces this seam with
// calls to the gate MCP server, which owns the real implementation.
import { boundaryUnavailable } from '../boundary.ts';
import type { Database } from './db.ts';

export type Defer = (p: Promise<unknown>) => void;

// No mention rows are read in this repo: the empty resolution (nobody is mentioned).
export async function resolveMentions(_db: Database, _text: string, _sender: string): Promise<{ principal_id: string; via: string }[]> {
  void _db; void _text; void _sender;
  return [];
}

// No mention rows are read in this repo: an empty map for every call.
export async function mentionsFor(_db: Database, _ids: string[]): Promise<Map<string, string[]>> {
  void _db; void _ids;
  return new Map<string, string[]>();
}

// Empty plan in the real return shape: no mentions, no deliveries, no statements. A post made
// through this repo therefore enqueues no webhook work and notifies nobody.
export async function planNotify(
  _db: Database,
  _message: { id: string; actor_id: string; text: string; created_at: string },
): Promise<{ mentions: string[]; deliveries: string[]; statements: ReturnType<Database['prepare']>[] }> {
  void _db; void _message;
  return { mentions: [], deliveries: [], statements: [] };
}

// Writes delivery rows on the gate side; never simulated here.
export async function recordAndEnqueue(
  _db: Database,
  _message: { id: string; actor_id: string; text: string; created_at: string },
): Promise<{ mentions: string[]; deliveries: string[] }> {
  return boundaryUnavailable('src/server/notify.ts', 'recordAndEnqueue', _db, _message);
}

export const CLAIM_MS = 60_000; // > the 8 s fetch timeout, so a live attempt's lease never lapses mid-flight

export type WakeAuth = Readonly<Record<string, Readonly<{ key: string; url: string }>>>;
export const NO_WAKE_AUTH: WakeAuth = Object.freeze({});

// No wake credentials exist in this repo, so no invocation ever carries wake auth.
export function wakeAuthFrom(_env: object): WakeAuth {
  void _env;
  return NO_WAKE_AUTH;
}

// With no wake auth configured, the header set is always empty.
export function wakeAuthHeader(_auth: WakeAuth, _principal: string | undefined, _url: string): Record<string, string> {
  void _auth; void _principal; void _url;
  return {};
}

// Outbound delivery is gate behavior; callers that tolerate delivery failure catch this throw.
export async function deliver(
  _db: Database,
  _ids?: string[],
  _auth: WakeAuth = NO_WAKE_AUTH,
  _fetchImpl: typeof fetch = fetch,
): Promise<number> {
  return boundaryUnavailable('src/server/notify.ts', 'deliver', _db, _ids, _auth, _fetchImpl);
}

// Webhook URL allow-listing is gate behavior; no URL is approved from this repo.
export function checkWebhookUrl(_raw: string): string {
  return boundaryUnavailable('src/server/notify.ts', 'checkWebhookUrl', _raw);
}

export class Webhooks {
  constructor(_db: Database, _principal: string, _auth: WakeAuth = NO_WAKE_AUTH) {
  void _db; void _principal; void _auth;}
  async set(_input: { url: string; all_messages: boolean; rotate_secret: boolean }) {
    return boundaryUnavailable('src/server/notify.ts', 'Webhooks.set', _input);
  }
  async get() {
    return boundaryUnavailable('src/server/notify.ts', 'Webhooks.get');
  }
  async remove() {
    return boundaryUnavailable('src/server/notify.ts', 'Webhooks.remove');
  }
  async test() {
    return boundaryUnavailable('src/server/notify.ts', 'Webhooks.test');
  }
}

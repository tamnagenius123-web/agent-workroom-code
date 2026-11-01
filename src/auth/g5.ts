// BOUNDARY CONTRACT — mirrors src/auth/g5.ts in the gate MCP repo (agent-workroom-gate-mcp).
// Types and contract constants are declared here; runtime entry points fail closed.
// Phase 2 replaces this seam with gate-MCP calls; do not implement auth behavior here.

import { boundaryUnavailable } from '../boundary.ts';
import { Fault } from '../server/contracts.ts';
import type { Identity } from '../server/app.ts';
import type { Database, Env, Rows } from '../server/db.ts';

export interface G5Env extends Env {
  WORKROOM_RESOURCE?: string; WORKROOM_INGRESS_ID?: string; OWNER_PASSWORD_HASH?: string;
  OWNER_EMAIL?: string; WORKROOM_TOKEN_PEPPER?: string; MCP_COMPAT?: string;
}
export interface Config { resource: string; issuer: string; ingress: string; ownerHash: string; pepper: string }
export const ACCESS_TTL = 3600_000;
export const REFRESH_TTL = 30 * 86400_000;
export const CODE_TTL = 60_000;
export const ASSERTION_TTL = 300_000;
export const G5_SCOPES = ['workroom.read', 'workroom.write', 'offline_access'] as const;

export function config(_env: G5Env): Config | null {
  void _env;
  // OAuth is not configured in this repo; the gate implementation returns null when unconfigured.
  return null;
}

export interface ScopeReport { requested: string[]; granted: string[]; dropped: string[]; rejected: string[] }

export function scopeSet(_raw: string | null, _allowed: string[]): ScopeReport & { ok: boolean } {
  return boundaryUnavailable('src/auth/g5.ts', 'scopeSet', _raw, _allowed);
}

export const LOCK_FAILURES = 5;
export const LOCK_WINDOW = 15 * 60_000;
export const LOCK_TIME = 15 * 60_000;
export const FLOW_TTL = 600_000;
export const GLOBAL_LOCK_FAILURES = 50;

export interface Slot { window_start: number; set_lock: number }
export interface Reservation { key: string; requester: Slot; global: Slot }

export async function admit(_db: Database, _key: string, _now: number): Promise<Reservation | null> {
  return boundaryUnavailable('src/auth/g5.ts', 'admit', _db, _key, _now);
}

export const refund = (_db: Database, _r: Reservation): Promise<Rows<unknown>[]> => boundaryUnavailable('src/auth/g5.ts', 'refund', _db, _r);

export function sameOriginPost(_request: Request, _issuer: string): boolean {
  return boundaryUnavailable('src/auth/g5.ts', 'sameOriginPost', _request, _issuer);
}

export async function g5Routes(_request: Request, _env: G5Env): Promise<Response | null> {
  void _env;
  // OAuth/well-known routes are not served in this repo. The real module
  // returns null outside those paths and throws AUTH_NOT_CONFIGURED on them
  // when OAuth is unconfigured — which is always the case here, so this stub
  // reproduces exactly that unconfigured behavior (fail closed).
  const path = new URL(_request.url).pathname;
  if (!path.startsWith('/.well-known/') && !path.startsWith('/oauth/')) return null;
  throw new Fault('AUTH_NOT_CONFIGURED', 'Hosted authentication is not configured. API is closed.', 503);
}

export async function g5Authenticate(_request: Request, _env: G5Env): Promise<Identity> {
  void _request; void _env;
  // OAuth is never configured in this repo; the real module throws this same
  // Fault whenever its config is absent. No identity is ever issued here.
  throw new Fault('AUTH_NOT_CONFIGURED', 'Hosted authentication is not configured. API is closed.', 503);
}

export const wwwAuthenticate = (_env: G5Env): string | null => {
  void _env;
  return null;
};

export async function g5Capabilities(_env: G5Env, _identity: { principal: string; write: boolean }) {
  return boundaryUnavailable('src/auth/g5.ts', 'g5Capabilities', _env, _identity);
}

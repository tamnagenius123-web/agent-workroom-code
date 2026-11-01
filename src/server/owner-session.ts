// BOUNDARY CONTRACT — mirrors src/server/owner-session.ts in the gate MCP repo (agent-workroom-gate-mcp).
// Types and contract constants are declared here; runtime entry points fail closed.
// Phase 2 replaces this seam with gate-MCP calls; do not implement auth behavior here.

import { boundaryUnavailable } from '../boundary.ts';
import type { Database } from './db.ts';

export const OWNER_PRINCIPAL = 'user:minsung';
export const OWNER_ROLE = 'owner';
export const OWNER_COOKIE = '__Host-owner_session';
export const SESSION_TTL_MS = 15 * 60 * 1000;

export interface OwnerSession { exp: number; csrf: string; sid: string }
interface Slot { window_start: number; set_lock: number }
interface Reservation { key: string; requester: Slot; global: Slot }

export function ownerHash(_env: { OWNER_PASSWORD_HASH?: string }): string {
  void _env;
  // No owner password hash is configured in this repo.
  return '';
}

export async function requireOwnerTables(_db: Database): Promise<void> {
  boundaryUnavailable('src/server/owner-session.ts', 'requireOwnerTables', _db);
}

export function ownerSameOrigin(_request: Request): boolean {
  return boundaryUnavailable('src/server/owner-session.ts', 'ownerSameOrigin', _request);
}

export function readOwnerCookie(_header: string | null): string | null {
  return boundaryUnavailable('src/server/owner-session.ts', 'readOwnerCookie', _header);
}

export function ownerCookieHeader(_value: string, _maxAge: number): string {
  return boundaryUnavailable('src/server/owner-session.ts', 'ownerCookieHeader', _value, _maxAge);
}

export async function sealOwnerSession(_hash: string, _fields: OwnerSession): Promise<string> {
  return boundaryUnavailable('src/server/owner-session.ts', 'sealOwnerSession', _hash, _fields);
}

export async function openOwnerSession(_hash: string, _token: string): Promise<OwnerSession | null> {
  return boundaryUnavailable('src/server/owner-session.ts', 'openOwnerSession', _hash, _token);
}

export async function loadOwnerSession(_db: Database, _hash: string, _request: Request): Promise<OwnerSession> {
  return boundaryUnavailable('src/server/owner-session.ts', 'loadOwnerSession', _db, _hash, _request);
}

export function assertOwnerCsrf(_session: OwnerSession, _request: Request): void {
  boundaryUnavailable('src/server/owner-session.ts', 'assertOwnerCsrf', _session, _request);
}

export async function issueOwnerSession(_db: Database, _hash: string): Promise<{ session: OwnerSession; cookie: string }> {
  return boundaryUnavailable('src/server/owner-session.ts', 'issueOwnerSession', _db, _hash);
}

export async function revokeOwnerSession(_db: Database, _hash: string, _session: OwnerSession): Promise<void> {
  boundaryUnavailable('src/server/owner-session.ts', 'revokeOwnerSession', _db, _hash, _session);
}

export async function loginKey(_hash: string, _request: Request): Promise<string> {
  return boundaryUnavailable('src/server/owner-session.ts', 'loginKey', _hash, _request);
}

export async function admitOwnerLogin(_db: Database, _key: string, _now = Date.now()): Promise<Reservation | null> {
  return boundaryUnavailable('src/server/owner-session.ts', 'admitOwnerLogin', _db, _key, _now);
}

export async function refundOwnerLogin(_db: Database, _reservation: Reservation): Promise<void> {
  boundaryUnavailable('src/server/owner-session.ts', 'refundOwnerLogin', _db, _reservation);
}

// The gate implementation derives this as Math.ceil(LOCK_MS / 1000) with LOCK_MS = 15 * 60 * 1000.
export const LOGIN_LOCK_SECONDS = 900;

export interface OwnerNote { verified: boolean; directiveId?: string }

export async function ownerNotes(_db: Database, _ids: string[]): Promise<Map<string, OwnerNote>> {
  return boundaryUnavailable('src/server/owner-session.ts', 'ownerNotes', _db, _ids);
}

export function withAgentNote<T extends object>(_row: T, _note: OwnerNote | undefined): T & { owner_verified?: true; directive_id?: string } {
  return boundaryUnavailable('src/server/owner-session.ts', 'withAgentNote', _row, _note);
}

export function applyAgentNotes<T extends { id: string }>(_messages: T[], _notes: Map<string, OwnerNote>): Array<T & { owner_verified?: true; directive_id?: string }> {
  return boundaryUnavailable('src/server/owner-session.ts', 'applyAgentNotes', _messages, _notes);
}

export function applyOwnerNotes<T extends { id: string }>(_messages: T[], _notes: Map<string, OwnerNote>): Array<T & { owner_verified: boolean; directive_id?: string }> {
  return boundaryUnavailable('src/server/owner-session.ts', 'applyOwnerNotes', _messages, _notes);
}

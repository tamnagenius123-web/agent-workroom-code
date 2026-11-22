// wrk_ bearer lookup for the production worker. The hash is SHA-256 of the raw
// token bytes. It does not use WORKROOM_TOKEN_PEPPER and it does not read oauth_tokens.
import { sha256 } from './crypto.ts';
import type { Database } from '../server/db.ts';

const BEARER = /^[A-Za-z0-9_-]{20,200}$/;

export interface AgentCredential {
  key_id: string;
  principal_id: string;
  scopes: string[];
  credential_version: number;
}

interface Stored {
  key_id: string;
  principal_id: string;
  scopes_json: string;
  expires_at: number;
  revoked_at: number | null;
  credential_version: number;
}

export function headerBearer(header: string | null): string | null {
  const match = header?.match(/^Bearer ([A-Za-z0-9_-]{20,200})$/);
  const token = match?.[1];
  return token ?? null;
}

export function queryCarriesWrk(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  for (const value of parsed.searchParams.values()) {
    if (value.startsWith('wrk_')) return true;
  }
  return false;
}

export function isAgentToken(token: string): boolean {
  return token.startsWith('wrk_') && BEARER.test(token);
}

/** sha256: plus unpadded base64url(SHA-256(utf8(token))). */
export async function credentialHash(token: string): Promise<string> {
  return 'sha256:' + await sha256(token);
}

export function missingAgentCredentials(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  return `${message} ${cause}`.toLowerCase().includes('no such table');
}

export async function readAgentCredential(db: Database, token: string, now: number): Promise<AgentCredential | null> {
  if (!isAgentToken(token)) return null;
  let row: Stored | null;
  try {
    row = await db.prepare(
      `SELECT key_id, principal_id, scopes_json, expires_at, revoked_at, credential_version
       FROM agent_credentials WHERE key_hash=?`,
    ).bind(await credentialHash(token)).first<Stored>();
  } catch (error) {
    if (missingAgentCredentials(error)) return null;
    throw error;
  }
  if (!row || row.revoked_at != null || !(row.expires_at > now)) return null;
  if (!Number.isInteger(row.credential_version) || row.credential_version < 1) return null;
  let scopes: unknown;
  try { scopes = JSON.parse(row.scopes_json) as unknown; } catch { return null; }
  if (!Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string')) return null;
  return {
    key_id: row.key_id,
    principal_id: row.principal_id,
    scopes: scopes as string[],
    credential_version: row.credential_version,
  };
}

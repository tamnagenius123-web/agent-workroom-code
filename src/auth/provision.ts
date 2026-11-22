import { hmac, random } from './crypto.ts';

export interface ClientSpec { client_id: string; principal_id: string; agent_id: string; redirect_uris: string[]; scopes: string[]; resource: string; ingress_id: string; can_post: boolean; credential_version?: number; binding_expires_at_ms: number }
// Produces SQL statements and a one-time client secret. The caller shows the secret to the owner once; only its hash is stored.
export async function provisionClient(pepper: string, s: ClientSpec, now = Date.now()) {
  const secret = 'wrc_' + random(32), issuer = new URL(s.resource).origin, v = s.credential_version ?? 1;
  const statements: { sql: string; params: (string | number | null)[] }[] = [
    { sql: 'INSERT OR IGNORE INTO principals(id) VALUES (?)', params: [s.principal_id] },
    { sql: 'INSERT OR IGNORE INTO memberships(principal_id,room_id,can_post) VALUES (?,?,?)', params: [s.principal_id, 'room_main', s.can_post ? 1 : 0] },
    { sql: 'INSERT OR IGNORE INTO principal_roles(principal_id,kind) VALUES (?,?)', params: [s.principal_id, 'agent'] },
    { sql: 'INSERT INTO oauth_clients(client_id,principal_id,subject_kind,redirect_uris_json,secret_hash,credential_version,scopes_json,active,created_at) VALUES (?,?,?,?,?,?,?,1,?) ON CONFLICT(client_id) DO UPDATE SET secret_hash=excluded.secret_hash,credential_version=excluded.credential_version,redirect_uris_json=excluded.redirect_uris_json,scopes_json=excluded.scopes_json,active=1',
      params: [s.client_id, s.principal_id, 'agent', JSON.stringify(s.redirect_uris), await hmac(pepper, 'client:' + secret), v, JSON.stringify(s.scopes), now] },
    { sql: 'INSERT INTO principal_bindings(issuer,subject,credential_id,principal_id,kind,agent_id,room_id,audience,ingress_id,active,credential_version,not_before_ms,expires_at_ms,scopes_json) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?) ON CONFLICT(issuer,subject,credential_id) DO UPDATE SET credential_version=excluded.credential_version,active=1,expires_at_ms=excluded.expires_at_ms',
      params: [issuer, s.principal_id, s.client_id, s.principal_id, 'agent', s.agent_id, 'room_main', s.resource, s.ingress_id, v, now, s.binding_expires_at_ms, JSON.stringify(['connection.identity', 'room.read'])] },
  ];
  return { secret, statements };
}

-- Enrollment credentials. The secret is not a column. The hash is SHA-256, not an HMAC under the token pepper.
-- expires_at is mint time plus 90 days. A principal may hold one overlapping replacement.
CREATE TABLE agent_credentials (
  key_id TEXT PRIMARY KEY CHECK (length(key_id) BETWEEN 12 AND 80 AND key_id GLOB 'wrk_id_*'),
  principal_id TEXT NOT NULL CHECK (length(principal_id) BETWEEN 7 AND 70),
  key_hash TEXT NOT NULL UNIQUE CHECK (length(key_hash) BETWEEN 14 AND 120 AND key_hash GLOB 'sha256:*'),
  scopes_json TEXT NOT NULL,
  minted_by TEXT NOT NULL CHECK (minted_by = 'user:minsung'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  credential_version INTEGER NOT NULL CHECK (credential_version > 0)
);

CREATE INDEX agent_credentials_principal ON agent_credentials(principal_id, created_at);

-- Enrollment rate counter. It is not the owner-password lockout table.
CREATE TABLE enrollment_rate (
  bucket TEXT PRIMARY KEY CHECK (length(bucket) BETWEEN 1 AND 128),
  window_start INTEGER NOT NULL CHECK (window_start >= 0),
  hits INTEGER NOT NULL CHECK (hits >= 0)
);

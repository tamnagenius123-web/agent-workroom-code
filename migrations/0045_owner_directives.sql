-- OWNER-UI sessions, verified posts, and directive fan-out.
-- 0043 and 0044 are reserved for other units. This number is 0045 only.
CREATE TABLE owner_verified_messages (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL
);
CREATE TABLE owner_sessions (
  sid_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX owner_sessions_expiry ON owner_sessions(expires_at);
CREATE TABLE owner_login_gate (
  key_hash TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE owner_directives (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  actor_id TEXT NOT NULL REFERENCES principals(id),
  text TEXT NOT NULL,
  message_id TEXT REFERENCES messages(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (actor_id, idempotency_key)
);
CREATE INDEX owner_directives_message ON owner_directives(message_id);
CREATE TABLE owner_directive_targets (
  directive_id TEXT NOT NULL REFERENCES owner_directives(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  status TEXT NOT NULL CHECK (status IN ('queued','woken','acked','in_progress','done','failed')),
  detail TEXT,
  inbox_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (directive_id, principal_id)
);
INSERT INTO principals(id, active) VALUES ('user:minsung', 1) ON CONFLICT(id) DO NOTHING;
INSERT INTO principal_roles(principal_id, kind) VALUES ('user:minsung', 'user') ON CONFLICT(principal_id) DO NOTHING;

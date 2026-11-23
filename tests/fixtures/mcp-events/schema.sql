-- Apply only to the dedicated MCP Events test database after the Workroom product migrations.
CREATE TABLE mcp_event_subscriptions (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  touched_at INTEGER NOT NULL,
  sealed TEXT,
  verified_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE mcp_event_outbox (
  id TEXT PRIMARY KEY,
  sub_id TEXT NOT NULL REFERENCES mcp_event_subscriptions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','terminal')),
  attempts INTEGER NOT NULL DEFAULT 0,
  claim TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  UNIQUE(sub_id, message_id)
);
CREATE INDEX mcp_event_due ON mcp_event_outbox(status,next_at,lease_until);

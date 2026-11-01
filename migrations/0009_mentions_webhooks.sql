CREATE TABLE agent_aliases (alias TEXT PRIMARY KEY, principal_id TEXT NOT NULL);
INSERT INTO agent_aliases(alias,principal_id) VALUES ('muse','agent:muse'),('뮤즈','agent:muse'),('codex','agent:dots'),('코덱스','agent:dots'),('dots','agent:dots'),('grok','agent:grok'),('그록','agent:grok');
CREATE TABLE message_mentions (message_id TEXT NOT NULL REFERENCES messages(id), principal_id TEXT NOT NULL, via TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(message_id, principal_id));
CREATE INDEX message_mentions_principal ON message_mentions(principal_id, seq);
CREATE TABLE mention_cursors (principal_id TEXT NOT NULL, room_id TEXT NOT NULL, last_seq INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(principal_id, room_id));
CREATE TABLE webhooks (principal_id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, all_messages INTEGER NOT NULL DEFAULT 0 CHECK(all_messages IN (0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE webhook_outbox (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, message_id TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','delivered','failed')), attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, last_status INTEGER, last_error TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER);
CREATE INDEX webhook_outbox_due ON webhook_outbox(status, next_at);
CREATE INDEX webhook_outbox_principal ON webhook_outbox(principal_id, created_at)
;

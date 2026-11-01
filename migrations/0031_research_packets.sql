-- Research packets opened under an intent revision and incorporated on a later turn.
-- incorporated_by stays null until a citation names the intent_rev the packet was opened under.
-- recorded_at is server time in epoch milliseconds.
CREATE TABLE research_packets (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  intent_rev TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('open','incorporate')),
  actor_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  idempotency_key TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  UNIQUE(actor_id, idempotency_key)
);
CREATE INDEX research_packets_task ON research_packets(room_id, task_id, recorded_at);
CREATE UNIQUE INDEX research_packets_one_open ON research_packets(room_id, task_id) WHERE kind='open';

-- Accepted consumer-bound handoffs. principal_id is the authenticated caller.
-- injection_receipt_id is unique in the room; a duplicate is not a second acceptance.
-- recorded_at is server time in epoch milliseconds.
CREATE TABLE handoff_receipts (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  wake_stage_id TEXT NOT NULL,
  injection_receipt_id TEXT NOT NULL,
  proven_live INTEGER NOT NULL CHECK(proven_live IN (0,1)),
  attempt_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  UNIQUE(principal_id, idempotency_key),
  UNIQUE(room_id, injection_receipt_id)
);
CREATE INDEX handoff_receipts_room ON handoff_receipts(room_id, recorded_at);

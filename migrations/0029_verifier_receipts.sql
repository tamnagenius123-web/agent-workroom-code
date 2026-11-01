-- P1 verifier receipt evaluations. principal_id is the authenticated acceptor.
-- acceptor_id and verifier_id are that principal; the body cannot set them.
-- recorded_at is server time in epoch milliseconds.
CREATE TABLE verifier_receipts (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('PASS','HOLD')),
  observation_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  UNIQUE(principal_id, idempotency_key)
);
CREATE INDEX verifier_receipts_room ON verifier_receipts(room_id, recorded_at);

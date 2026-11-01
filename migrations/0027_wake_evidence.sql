-- Host-reported wake stages (relay receipt, host run, read outcome).
-- 0026 is reserved by another branch. This file is 0027 so the two can merge.
-- recorded_at is server time in epoch milliseconds. Payload timestamps are claimed by the caller.
CREATE TABLE wake_evidence (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('relay_receipt','host_run','read_outcome')),
  message_id TEXT NOT NULL,
  delivery_id TEXT,
  event_id TEXT,
  run_id TEXT,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  UNIQUE(principal_id, idempotency_key)
);
CREATE INDEX wake_evidence_message_principal ON wake_evidence(message_id, principal_id);

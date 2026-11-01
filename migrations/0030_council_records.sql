-- Council snapshots from agenda through chair, plus corrections and owner accept.
-- 0028 (budget ledger) and 0029 (verifier receipts) are used by their own units; see migrations/REGISTRY.md.
-- recorded_at is server time in epoch milliseconds. executed_at inside payload_json is caller-claimed.
CREATE TABLE council_records (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  agenda_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('agenda','blind_r1','cross_r2','sealed','correction','owner_accept')),
  record_id TEXT,
  corrects TEXT,
  owner_principal_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  idempotency_key TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  UNIQUE(actor_id, idempotency_key)
);
CREATE INDEX council_records_agenda ON council_records(room_id, agenda_id, recorded_at);
CREATE INDEX council_records_record ON council_records(room_id, record_id);
CREATE UNIQUE INDEX council_records_one_agenda ON council_records(room_id, agenda_id) WHERE stage='agenda';
CREATE UNIQUE INDEX council_records_one_blind ON council_records(room_id, agenda_id) WHERE stage='blind_r1';
CREATE UNIQUE INDEX council_records_one_cross ON council_records(room_id, agenda_id) WHERE stage='cross_r2';
CREATE UNIQUE INDEX council_records_one_chair ON council_records(room_id, agenda_id) WHERE stage='sealed';
CREATE UNIQUE INDEX council_records_one_correction ON council_records(room_id, record_id) WHERE stage='correction';

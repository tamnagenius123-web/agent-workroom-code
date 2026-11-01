-- IW-01 status records. Five classification axes and three lifecycle flags
-- are separate columns. A collapsed status string is not stored.
-- kept, applied, and effect are recorded independently; kept does not fill the others.
-- recorded_at is server time in epoch milliseconds. Rows are append-only.
-- Each trigger is one line because the local harness splits on a semicolon plus a newline.
CREATE TABLE iw01_status_records (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  review_support TEXT NOT NULL CHECK (review_support IN ('none', 'pending', 'supported', 'blocked')),
  structural_grade TEXT NOT NULL CHECK (structural_grade IN ('ungraded', 'F', 'D', 'C', 'B', 'A', 'S')),
  corpus_level TEXT NOT NULL CHECK (corpus_level IN ('L0', 'L1', 'L2')),
  memory_tier INTEGER NOT NULL CHECK (memory_tier IN (0, 1, 2, 3)),
  promotion_stage TEXT NOT NULL CHECK (promotion_stage IN ('candidate', 'shadow', 'replay', 'prospective', 'independent_review', 'promoted')),
  kept INTEGER NOT NULL CHECK (kept IN (0, 1)),
  applied INTEGER NOT NULL CHECK (applied IN (0, 1)),
  effect INTEGER NOT NULL CHECK (effect IN (0, 1)),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  idempotency_key TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  UNIQUE (room_id, subject_id),
  UNIQUE (principal_id, idempotency_key)
);
CREATE INDEX iw01_status_records_room ON iw01_status_records(room_id, recorded_at);
CREATE TRIGGER iw01_status_records_no_update BEFORE UPDATE ON iw01_status_records BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER iw01_status_records_no_delete BEFORE DELETE ON iw01_status_records BEGIN SELECT RAISE(ABORT, 'immutable'); END;

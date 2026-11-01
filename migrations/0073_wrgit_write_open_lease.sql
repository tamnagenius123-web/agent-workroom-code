-- WG-5. write_open_at starts the canonical-write lease for write_open.
-- fence_ok is 1 only after Artifacts compare-and-set, or after a D1 generation
-- recheck that still matched the generation captured for this attempt.
ALTER TABLE wrgit_merge_intents ADD COLUMN write_open_at INTEGER
  CHECK (write_open_at IS NULL OR write_open_at >= 0);

ALTER TABLE wrgit_merge_intents ADD COLUMN fence_ok INTEGER NOT NULL DEFAULT 0
  CHECK (fence_ok IN (0, 1));

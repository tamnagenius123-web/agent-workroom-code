-- WG-5. An intent row with no wrgit_merges row is in doubt until reconciliation.
-- expected_sha is the canonical head the fast-forward compared against.
-- outcome is NULL while the intent is open, merged when Artifacts proved the ref write,
-- and not_merged when reconciliation can prove there was no such write.
-- stale marks a wrgit_merges row recorded after the writer lost the lock.
ALTER TABLE wrgit_merge_intents ADD COLUMN expected_sha TEXT
  CHECK (expected_sha IS NULL OR (length(expected_sha) = 40 AND expected_sha NOT GLOB '*[^0-9a-f]*'));

ALTER TABLE wrgit_merge_intents ADD COLUMN outcome TEXT
  CHECK (outcome IS NULL OR outcome IN ('merged', 'not_merged'));

ALTER TABLE wrgit_merge_intents ADD COLUMN settled_at INTEGER
  CHECK (settled_at IS NULL OR settled_at >= 0);

ALTER TABLE wrgit_merges ADD COLUMN stale INTEGER NOT NULL DEFAULT 0
  CHECK (stale IN (0, 1));

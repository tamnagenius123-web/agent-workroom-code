-- WG-5. A write-open reclaimer that wins the generation compare-and-set records one lease.
-- The loser writes no lease row. write_open_owner is that winner.
ALTER TABLE wrgit_merge_intents ADD COLUMN write_open_owner TEXT
  CHECK (write_open_owner IS NULL OR length(write_open_owner) BETWEEN 1 AND 128);

CREATE TABLE wrgit_write_open_lease (
  intent_id TEXT NOT NULL CHECK (length(intent_id) BETWEEN 1 AND 128),
  owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 128),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  opened_at INTEGER NOT NULL CHECK (opened_at >= 0),
  PRIMARY KEY (intent_id, generation)
);

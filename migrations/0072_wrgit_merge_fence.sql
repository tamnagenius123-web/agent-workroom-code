-- WG-5. The merge lock generation is the fencing token checked at the canonical ref update.
-- It advances when a holder is acquired or renewed. Release leaves the generation unchanged.
-- write_open is 1 only while that holder may still move the ref. fence_fault records stale_lock
-- when the generation the holder captured is no longer current.
CREATE TABLE wrgit_merge_fence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL CHECK (generation >= 0)
);
INSERT INTO wrgit_merge_fence (id, generation) VALUES (1, 0);
CREATE TRIGGER wrgit_merge_fence_bump AFTER UPDATE OF holder, acquired_at ON wrgit_merge_lock WHEN NEW.holder IS NOT NULL AND (OLD.holder IS NOT NEW.holder OR OLD.acquired_at IS NOT NEW.acquired_at) BEGIN UPDATE wrgit_merge_fence SET generation = generation + 1 WHERE id = 1; END;
ALTER TABLE wrgit_merge_intents ADD COLUMN lock_generation INTEGER CHECK (lock_generation IS NULL OR lock_generation >= 0);
ALTER TABLE wrgit_merge_intents ADD COLUMN write_open INTEGER NOT NULL DEFAULT 0 CHECK (write_open IN (0, 1));
ALTER TABLE wrgit_merge_intents ADD COLUMN fence_fault TEXT CHECK (fence_fault IS NULL OR fence_fault = 'stale_lock');

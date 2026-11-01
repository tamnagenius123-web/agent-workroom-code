-- PR #2 HOLD P1 (d1def20): fold proposals are guarded inside the same D1 batch.
-- The conditional INSERTs in proposeFold can affect zero rows when a source message is edited or a child fold
-- is superseded concurrently. A post-commit check would leave a partial pending fold behind. This guard runs as
-- the last write of the batch and aborts the whole batch, so no partial row persists.
CREATE TABLE fold_write_guard (
  fold_id TEXT NOT NULL,
  sources INTEGER NOT NULL,
  children INTEGER NOT NULL,
  supersede INTEGER NOT NULL
);
CREATE TRIGGER fold_write_guard_check BEFORE INSERT ON fold_write_guard WHEN (SELECT COUNT(*) FROM memory_folds WHERE id=NEW.fold_id AND review_state='pending') != 1 OR (SELECT COUNT(*) FROM fold_sources WHERE fold_id=NEW.fold_id) != NEW.sources OR (SELECT COUNT(*) FROM fold_edges WHERE src_id=NEW.fold_id AND type='FOLDED_FROM') != NEW.children OR (SELECT COUNT(*) FROM fold_edges WHERE dst_id=NEW.fold_id AND type='SUPERSEDED_BY') != NEW.supersede BEGIN SELECT RAISE(ABORT, 'Fold was not stored: a source or child changed during the proposal. Re-read and propose again.'); END;
CREATE TRIGGER fold_write_guard_clear AFTER INSERT ON fold_write_guard BEGIN DELETE FROM fold_write_guard WHERE rowid=NEW.rowid; END;
-- PR #2 HOLD design decision S1 rev2 (d0792c2): a SUPERSEDED_BY edge can be approved (armed) only while its replacement is pending, or approved and open. The old fold closes when both are approved.
CREATE TRIGGER fold_supersede_needs_live_replacement BEFORE UPDATE OF review_state ON fold_edges WHEN NEW.type='SUPERSEDED_BY' AND NEW.review_state='approved' AND NOT EXISTS (SELECT 1 FROM memory_folds n WHERE n.id=NEW.dst_id AND n.valid_until IS NULL AND n.review_state IN ('pending','approved')) BEGIN SELECT RAISE(ABORT, 'A SUPERSEDED_BY edge can be approved only while its replacement is pending or approved and open'); END;

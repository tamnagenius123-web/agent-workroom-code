-- OCG-W fold review (F2). Widen memory_reviews.target_kind. Item and edge triggers keep the table name and are not rebuilt.
-- Each trigger is one line because scripts/local-harness.ts splits on /;\s*\n/.
-- legacy_alter_table lets DROP TABLE skip the rewrite of memory_items_review_state and memory_edges_review_state, which name memory_reviews. The rename restores that name.
PRAGMA legacy_alter_table = ON;
CREATE TABLE memory_reviews_v2 (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('item', 'edge', 'fold', 'fold_edge')),
  target_id TEXT NOT NULL CHECK (length(target_id) > 0),
  verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'reject')),
  reviewer_id TEXT NOT NULL REFERENCES principals(id),
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
);
INSERT INTO memory_reviews_v2 SELECT id, target_kind, target_id, verdict, reviewer_id, reason, content_digest, created_at FROM memory_reviews;
DROP TRIGGER memory_reviews_no_update;
DROP TRIGGER memory_reviews_no_delete;
DROP TABLE memory_reviews;
ALTER TABLE memory_reviews_v2 RENAME TO memory_reviews;
CREATE INDEX memory_reviews_target ON memory_reviews(target_kind, target_id);
CREATE TRIGGER memory_reviews_no_update BEFORE UPDATE ON memory_reviews BEGIN SELECT RAISE(ABORT,'immutable review'); END;
CREATE TRIGGER memory_reviews_no_delete BEFORE DELETE ON memory_reviews BEGIN SELECT RAISE(ABORT,'immutable review'); END;
PRAGMA legacy_alter_table = OFF;

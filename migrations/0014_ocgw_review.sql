-- OCG-W W3: independent review. The reviewer list is not seeded; the integrator or owner inserts it.
-- Each trigger is one line because the local harness splits migration files on a semicolon followed by a newline.
CREATE TABLE memory_reviewers (
  principal_id TEXT PRIMARY KEY REFERENCES principals(id),
  added_at TEXT NOT NULL CHECK (length(added_at) > 0)
);
CREATE TABLE memory_reviews (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('item', 'edge')),
  target_id TEXT NOT NULL CHECK (length(target_id) > 0),
  verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'reject')),
  reviewer_id TEXT NOT NULL REFERENCES principals(id),
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
);
CREATE INDEX memory_reviews_target ON memory_reviews(target_kind, target_id);
CREATE TRIGGER memory_reviews_no_update BEFORE UPDATE ON memory_reviews BEGIN SELECT RAISE(ABORT,'immutable review'); END;
CREATE TRIGGER memory_reviews_no_delete BEFORE DELETE ON memory_reviews BEGIN SELECT RAISE(ABORT,'immutable review'); END;
CREATE TRIGGER memory_items_review_state BEFORE UPDATE ON memory_items WHEN NEW.review_state!=OLD.review_state AND (OLD.review_state!='pending' OR NEW.review_state NOT IN ('approved','rejected') OR NOT EXISTS (SELECT 1 FROM memory_reviews rv WHERE rv.target_kind='item' AND rv.target_id=OLD.id AND rv.target_id=NEW.id AND rv.reviewer_id!=OLD.proposed_by AND rv.reviewer_id!=NEW.proposed_by AND ((NEW.review_state='approved' AND rv.verdict='approve') OR (NEW.review_state='rejected' AND rv.verdict='reject')) AND EXISTS (SELECT 1 FROM memory_reviewers rr WHERE rr.principal_id=rv.reviewer_id))) BEGIN SELECT RAISE(ABORT,'review requires an independent listed reviewer'); END;
CREATE TRIGGER memory_edges_review_state BEFORE UPDATE ON memory_edges WHEN NEW.review_state!=OLD.review_state AND (OLD.review_state!='pending' OR NEW.review_state NOT IN ('approved','rejected') OR NOT EXISTS (SELECT 1 FROM memory_reviews rv WHERE rv.target_kind='edge' AND rv.target_id=OLD.id AND rv.target_id=NEW.id AND rv.reviewer_id!=OLD.proposed_by AND rv.reviewer_id!=NEW.proposed_by AND ((NEW.review_state='approved' AND rv.verdict='approve') OR (NEW.review_state='rejected' AND rv.verdict='reject')) AND EXISTS (SELECT 1 FROM memory_reviewers rr WHERE rr.principal_id=rv.reviewer_id))) BEGIN SELECT RAISE(ABORT,'review requires an independent listed reviewer'); END;

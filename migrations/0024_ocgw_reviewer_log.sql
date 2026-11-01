-- Reviewer-list audit. 민성 approved seeding memory_reviewers with agent:muse on the test D1 only (2026-10-23 10:40 KST). That seed is an admin insert, not part of this migration, so prod gets no reviewer.
-- Every insert into or delete from memory_reviewers is logged append-only. Triggers are one line because the local harness splits on a semicolon followed by a newline.
CREATE TABLE memory_reviewer_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('added', 'removed', 'present_at_migration')),
  logged_at TEXT NOT NULL
);
INSERT INTO memory_reviewer_log(principal_id, action, logged_at) SELECT principal_id, 'present_at_migration', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM memory_reviewers ORDER BY principal_id;
CREATE TRIGGER memory_reviewers_log_add AFTER INSERT ON memory_reviewers BEGIN INSERT INTO memory_reviewer_log(principal_id, action, logged_at) VALUES (NEW.principal_id, 'added', strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER memory_reviewers_log_remove AFTER DELETE ON memory_reviewers BEGIN INSERT INTO memory_reviewer_log(principal_id, action, logged_at) VALUES (OLD.principal_id, 'removed', strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER memory_reviewer_log_no_update BEFORE UPDATE ON memory_reviewer_log BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER memory_reviewer_log_no_delete BEFORE DELETE ON memory_reviewer_log BEGIN SELECT RAISE(ABORT,'immutable'); END;

-- OCG-W fold (F1). Message spans and rollups. Each trigger is one line because scripts/local-harness.ts splits on /;\s*\n/.
-- A fold never deletes room messages. Tombstones are the seam for a later retention spec; F1-F4 do not write them.
CREATE TABLE memory_folds (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 8192),
  first_message_id TEXT NOT NULL REFERENCES messages(id),
  last_message_id TEXT NOT NULL REFERENCES messages(id),
  span_from TEXT NOT NULL CHECK (length(span_from) > 0),
  span_to TEXT NOT NULL CHECK (length(span_to) > 0),
  proposed_by TEXT NOT NULL REFERENCES principals(id),
  review_state TEXT NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending', 'approved', 'rejected')),
  valid_from TEXT NOT NULL CHECK (length(valid_from) > 0),
  valid_until TEXT CHECK (valid_until IS NULL OR length(valid_until) > 0),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
);
CREATE TABLE fold_sources (
  fold_id TEXT NOT NULL REFERENCES memory_folds(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
  source_seq INTEGER NOT NULL,
  source_created_at TEXT NOT NULL CHECK (length(source_created_at) > 0),
  provenance_state TEXT NOT NULL DEFAULT 'resolvable' CHECK (provenance_state IN ('resolvable', 'tombstoned')),
  PRIMARY KEY (fold_id, message_id)
);
CREATE TABLE fold_edges (
  id TEXT PRIMARY KEY,
  src_id TEXT NOT NULL REFERENCES memory_folds(id),
  dst_id TEXT NOT NULL REFERENCES memory_folds(id),
  type TEXT NOT NULL CHECK (type IN ('SUPERSEDED_BY', 'FOLDED_FROM')),
  proposed_by TEXT NOT NULL REFERENCES principals(id),
  review_state TEXT NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  CHECK (src_id <> dst_id)
);
CREATE TABLE fold_source_tombstones (
  fold_id TEXT NOT NULL REFERENCES memory_folds(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
  tombstoned_at TEXT NOT NULL CHECK (length(tombstoned_at) > 0),
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  PRIMARY KEY (fold_id, message_id, source_version)
);
CREATE INDEX memory_folds_room_valid ON memory_folds(room_id, review_state, valid_from);
CREATE INDEX fold_sources_message ON fold_sources(message_id);
CREATE INDEX fold_edges_src ON fold_edges(src_id, type, review_state);
CREATE INDEX fold_edges_dst ON fold_edges(dst_id, type, review_state);
CREATE UNIQUE INDEX fold_edges_pair ON fold_edges(src_id, dst_id, type);
CREATE TRIGGER memory_folds_no_delete BEFORE DELETE ON memory_folds BEGIN SELECT RAISE(ABORT,'folds are append-only'); END;
CREATE TRIGGER fold_sources_no_delete BEFORE DELETE ON fold_sources BEGIN SELECT RAISE(ABORT,'fold sources are append-only'); END;
CREATE TRIGGER fold_edges_no_delete BEFORE DELETE ON fold_edges BEGIN SELECT RAISE(ABORT,'fold edges are append-only'); END;
CREATE TRIGGER fold_source_tombstones_no_delete BEFORE DELETE ON fold_source_tombstones BEGIN SELECT RAISE(ABORT,'fold tombstones are append-only'); END;
CREATE TRIGGER fold_source_tombstones_no_update BEFORE UPDATE ON fold_source_tombstones BEGIN SELECT RAISE(ABORT,'immutable tombstone'); END;
CREATE TRIGGER fold_sources_frozen BEFORE UPDATE ON fold_sources WHEN NEW.fold_id IS NOT OLD.fold_id OR NEW.message_id IS NOT OLD.message_id OR NEW.source_version IS NOT OLD.source_version OR NEW.source_hash IS NOT OLD.source_hash OR NEW.source_seq IS NOT OLD.source_seq OR NEW.source_created_at IS NOT OLD.source_created_at BEGIN SELECT RAISE(ABORT,'fold source pin is immutable'); END;
CREATE TRIGGER fold_sources_tombstone BEFORE UPDATE OF provenance_state ON fold_sources WHEN NEW.provenance_state IS NOT OLD.provenance_state AND (NEW.provenance_state!='tombstoned' OR NEW.source_hash IS NOT OLD.source_hash OR NOT EXISTS (SELECT 1 FROM fold_source_tombstones t WHERE t.fold_id=NEW.fold_id AND t.message_id=NEW.message_id AND t.source_version=NEW.source_version AND t.source_hash=NEW.source_hash) OR EXISTS (SELECT 1 FROM message_history h WHERE h.message_id=NEW.message_id AND h.version=NEW.source_version)) BEGIN SELECT RAISE(ABORT,'tombstone requires a matching marker and a missing revision'); END;
CREATE TRIGGER fold_source_tombstones_live BEFORE INSERT ON fold_source_tombstones WHEN EXISTS (SELECT 1 FROM message_history h WHERE h.message_id=NEW.message_id AND h.version=NEW.source_version) BEGIN SELECT RAISE(ABORT,'cannot tombstone a revision that still exists'); END;
CREATE TRIGGER memory_folds_frozen BEFORE UPDATE ON memory_folds WHEN NEW.id IS NOT OLD.id OR NEW.room_id IS NOT OLD.room_id OR NEW.summary IS NOT OLD.summary OR NEW.first_message_id IS NOT OLD.first_message_id OR NEW.last_message_id IS NOT OLD.last_message_id OR NEW.span_from IS NOT OLD.span_from OR NEW.span_to IS NOT OLD.span_to OR NEW.proposed_by IS NOT OLD.proposed_by OR NEW.valid_from IS NOT OLD.valid_from OR NEW.content_digest IS NOT OLD.content_digest OR NEW.created_at IS NOT OLD.created_at OR (OLD.valid_until IS NOT NULL AND NEW.valid_until IS NOT OLD.valid_until) BEGIN SELECT RAISE(ABORT,'fold content is immutable; propose a new fold and supersede'); END;
CREATE TRIGGER memory_folds_window BEFORE UPDATE OF valid_until ON memory_folds WHEN NEW.valid_until IS NOT NULL AND (OLD.valid_until IS NOT NULL OR NEW.valid_until<=NEW.valid_from OR NOT EXISTS (SELECT 1 FROM fold_edges e JOIN memory_folds n ON n.id=e.dst_id WHERE e.src_id=OLD.id AND e.type='SUPERSEDED_BY' AND e.review_state='approved' AND n.valid_from=NEW.valid_until)) BEGIN SELECT RAISE(ABORT,'valid_until is set once from an approved supersede and must not precede valid_from'); END;
CREATE TRIGGER memory_folds_insert_guard BEFORE INSERT ON memory_folds WHEN NEW.review_state!='pending' OR NEW.valid_until IS NOT NULL OR NEW.span_from IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', NEW.span_from) OR NEW.span_to IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', NEW.span_to) OR NEW.valid_from IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', NEW.valid_from) OR NEW.created_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at) OR NEW.span_from>NEW.span_to OR NEW.valid_from<NEW.span_to OR length(NEW.content_digest)!=64 OR NEW.content_digest GLOB '*[^0-9a-f]*' OR NOT EXISTS (SELECT 1 FROM messages a WHERE a.id=NEW.first_message_id AND a.room_id=NEW.room_id) OR NOT EXISTS (SELECT 1 FROM messages b WHERE b.id=NEW.last_message_id AND b.room_id=NEW.room_id) BEGIN SELECT RAISE(ABORT,'fold needs UTC span bounds, a pending row, endpoints in the room, and a 64-hex digest'); END;
CREATE TRIGGER fold_edges_frozen BEFORE UPDATE ON fold_edges WHEN NEW.id IS NOT OLD.id OR NEW.src_id IS NOT OLD.src_id OR NEW.dst_id IS NOT OLD.dst_id OR NEW.type IS NOT OLD.type OR NEW.proposed_by IS NOT OLD.proposed_by OR NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT,'fold edge is immutable'); END;
CREATE TRIGGER fold_edges_folded_from BEFORE INSERT ON fold_edges WHEN NEW.type='FOLDED_FROM' AND NOT EXISTS (SELECT 1 FROM memory_folds p JOIN memory_folds c ON c.id=NEW.dst_id WHERE p.id=NEW.src_id AND p.room_id=c.room_id AND c.review_state='approved' AND c.valid_until IS NULL AND p.review_state='pending' AND NOT EXISTS (SELECT 1 FROM fold_sources s WHERE s.fold_id=p.id)) BEGIN SELECT RAISE(ABORT,'FOLDED_FROM requires a pending parent with no sources and an approved open child in the same room'); END;
CREATE TRIGGER fold_edges_supersede BEFORE INSERT ON fold_edges WHEN NEW.type='SUPERSEDED_BY' AND NOT EXISTS (SELECT 1 FROM memory_folds o JOIN memory_folds n ON n.id=NEW.dst_id WHERE o.id=NEW.src_id AND n.room_id=o.room_id AND n.valid_from>o.valid_from) BEGIN SELECT RAISE(ABORT,'supersede must stay in one room and start after the old fold'); END;
CREATE TRIGGER memory_folds_review_state BEFORE UPDATE ON memory_folds WHEN NEW.review_state!=OLD.review_state AND (OLD.review_state!='pending' OR NEW.review_state NOT IN ('approved','rejected') OR NOT EXISTS (SELECT 1 FROM memory_reviews rv WHERE rv.target_kind='fold' AND rv.target_id=OLD.id AND rv.target_id=NEW.id AND rv.reviewer_id!=OLD.proposed_by AND rv.reviewer_id!=NEW.proposed_by AND ((NEW.review_state='approved' AND rv.verdict='approve') OR (NEW.review_state='rejected' AND rv.verdict='reject')) AND EXISTS (SELECT 1 FROM memory_reviewers rr WHERE rr.principal_id=rv.reviewer_id))) BEGIN SELECT RAISE(ABORT,'review requires an independent listed reviewer'); END;
CREATE TRIGGER fold_edges_review_state BEFORE UPDATE ON fold_edges WHEN NEW.review_state!=OLD.review_state AND (OLD.review_state!='pending' OR NEW.review_state NOT IN ('approved','rejected') OR NOT EXISTS (SELECT 1 FROM memory_reviews rv WHERE rv.target_kind='fold_edge' AND rv.target_id=OLD.id AND rv.target_id=NEW.id AND rv.reviewer_id!=OLD.proposed_by AND rv.reviewer_id!=NEW.proposed_by AND ((NEW.review_state='approved' AND rv.verdict='approve') OR (NEW.review_state='rejected' AND rv.verdict='reject')) AND EXISTS (SELECT 1 FROM memory_reviewers rr WHERE rr.principal_id=rv.reviewer_id))) BEGIN SELECT RAISE(ABORT,'review requires an independent listed reviewer'); END;
CREATE TRIGGER memory_folds_rollup_order BEFORE UPDATE ON memory_folds WHEN NEW.review_state='approved' AND OLD.review_state='pending' AND EXISTS (SELECT 1 FROM fold_edges e WHERE e.src_id=OLD.id AND e.type='FOLDED_FROM' AND e.review_state!='approved') BEGIN SELECT RAISE(ABORT,'approve the FOLDED_FROM edges before the rollup'); END;
CREATE TRIGGER memory_folds_span_coverage BEFORE UPDATE ON memory_folds WHEN NEW.review_state='approved' AND OLD.review_state='pending' AND EXISTS (SELECT 1 FROM fold_sources mine WHERE mine.fold_id=OLD.id AND EXISTS (WITH RECURSIVE cover(id) AS (SELECT f.id FROM memory_folds f WHERE f.room_id=OLD.room_id AND f.review_state='approved' AND f.valid_until IS NULL AND f.id<>OLD.id UNION SELECT e.dst_id FROM fold_edges e JOIN cover c ON e.src_id=c.id WHERE e.type='FOLDED_FROM' AND e.review_state='approved') SELECT 1 FROM fold_sources other JOIN cover ON cover.id=other.fold_id WHERE other.message_id=mine.message_id)) BEGIN SELECT RAISE(ABORT,'message is already covered by an approved open fold'); END;
CREATE TRIGGER memory_folds_rollup_coverage BEFORE UPDATE ON memory_folds WHEN NEW.review_state='approved' AND OLD.review_state='pending' AND EXISTS (SELECT 1 FROM fold_edges mine WHERE mine.src_id=OLD.id AND mine.type='FOLDED_FROM' AND EXISTS (SELECT 1 FROM fold_edges other JOIN memory_folds parent ON parent.id=other.src_id WHERE other.dst_id=mine.dst_id AND other.type='FOLDED_FROM' AND other.review_state='approved' AND other.src_id<>OLD.id AND parent.review_state='approved' AND parent.valid_until IS NULL)) BEGIN SELECT RAISE(ABORT,'child fold is already under an approved open rollup'); END;

-- OCG-W W2: memory items and edges. Not added to memory_fts; reads use exact filters only.
CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'fact', 'skill')),
  tier INTEGER NOT NULL CHECK (tier IN (0, 1, 2, 3)),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body TEXT NOT NULL CHECK (length(body) >= 1),
  source_message_id TEXT NOT NULL REFERENCES messages(id),
  proposed_by TEXT NOT NULL REFERENCES principals(id),
  review_state TEXT NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending', 'approved', 'rejected')),
  valid_from TEXT NOT NULL CHECK (length(valid_from) > 0),
  valid_until TEXT CHECK (valid_until IS NULL OR length(valid_until) > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
);
CREATE TABLE memory_edges (
  id TEXT PRIMARY KEY,
  src_id TEXT NOT NULL REFERENCES memory_items(id),
  dst_id TEXT NOT NULL REFERENCES memory_items(id),
  type TEXT NOT NULL CHECK (type IN ('SUPERSEDED_BY', 'PROMOTED_FROM', 'DERIVED_FROM')),
  proposed_by TEXT NOT NULL REFERENCES principals(id),
  review_state TEXT NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  CHECK (src_id <> dst_id)
);
CREATE INDEX memory_items_room_valid ON memory_items(room_id, review_state, valid_from);
CREATE INDEX memory_edges_src ON memory_edges(src_id, type, review_state);

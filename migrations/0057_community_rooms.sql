-- F1b community board. rooms.kind marks a room as the community board; existing rooms stay 'main'.
-- Posts are F1a CommunityPost records. actor_id is the authenticated principal; sig is the server HMAC over post_json.
-- Memberships for room_community are granted separately; this migration grants none.
ALTER TABLE rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'main' CHECK(kind IN ('main','community'));
INSERT OR IGNORE INTO rooms(id, kind) VALUES ('room_community', 'community');
CREATE TABLE community_posts (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('help_request','help_offer','method','assignment','veto','hold')),
  post_json TEXT NOT NULL CHECK(json_valid(post_json)),
  sig TEXT NOT NULL,
  request_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  UNIQUE(actor_id, idempotency_key)
);
CREATE INDEX community_posts_room ON community_posts(room_id, recorded_at);

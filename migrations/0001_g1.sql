CREATE TABLE principals (id TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
CREATE TABLE rooms (id TEXT PRIMARY KEY);
CREATE TABLE memberships (
  principal_id TEXT NOT NULL REFERENCES principals(id), room_id TEXT NOT NULL REFERENCES rooms(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  can_post INTEGER NOT NULL DEFAULT 0 CHECK(can_post IN (0,1)), PRIMARY KEY(principal_id,room_id)
);
CREATE TABLE operations (
  principal_id TEXT NOT NULL REFERENCES principals(id), operation TEXT NOT NULL, key TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id), request_hash TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at TEXT NOT NULL, PRIMARY KEY(principal_id,operation,key)
);
CREATE INDEX operations_rate ON operations(principal_id,created_at);
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, room_id TEXT NOT NULL REFERENCES rooms(id),
  actor_id TEXT NOT NULL REFERENCES principals(id), text TEXT NOT NULL, format TEXT NOT NULL CHECK(format IN ('text','markdown')),
  created_at TEXT NOT NULL
);
CREATE INDEX messages_room_seq ON messages(room_id,seq);
CREATE TABLE audit (
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id), room_id TEXT NOT NULL REFERENCES rooms(id),
  action TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE REFERENCES messages(id), created_at TEXT NOT NULL
);
CREATE TRIGGER messages_no_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER messages_no_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER operations_no_update BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER operations_no_delete BEFORE DELETE ON operations BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'immutable'); END;

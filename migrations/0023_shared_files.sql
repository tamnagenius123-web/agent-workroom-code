-- Room file sharing. D1 holds the canonical shared_files row. Path B bytes live in R2 under rooms/{room}/files/{id}. Path A stores a Drive link only. Triggers are one physical line because the local harness splits on a semicolon followed by a newline. 5*2^40 = 5497558138880.
CREATE TABLE shared_files (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  storage TEXT NOT NULL CHECK (storage IN ('r2', 'drive')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 240 AND name NOT IN ('.', '..') AND instr(name, char(0))=0 AND instr(name, '/')=0 AND instr(name, char(92))=0),
  mime TEXT NOT NULL CHECK (length(mime) BETWEEN 1 AND 127 AND instr(mime, '/')>1),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5497558138880),
  sha256 TEXT NOT NULL CHECK (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  sha256_verified INTEGER NOT NULL CHECK (sha256_verified IN (0, 1)),
  uploader_id TEXT NOT NULL REFERENCES principals(id),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  r2_key TEXT UNIQUE,
  drive_file_id TEXT,
  web_link TEXT,
  deleted_at_ms INTEGER,
  tombstone_reason TEXT,
  CHECK (
    (storage='r2'
      AND sha256_verified=1
      AND expires_at_ms IS NOT NULL
      AND expires_at_ms >= created_at_ms + 60000
      AND expires_at_ms <= created_at_ms + 3600000
      AND r2_key IS NOT NULL
      AND drive_file_id IS NULL
      AND web_link IS NULL
      AND ((deleted_at_ms IS NULL AND tombstone_reason IS NULL)
        OR (deleted_at_ms IS NOT NULL AND tombstone_reason='expired' AND deleted_at_ms >= expires_at_ms)))
    OR
    (storage='drive'
      AND sha256_verified=0
      AND expires_at_ms IS NULL
      AND r2_key IS NULL
      AND deleted_at_ms IS NULL
      AND tombstone_reason IS NULL
      AND drive_file_id IS NOT NULL
      AND length(drive_file_id) BETWEEN 10 AND 128
      AND drive_file_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND web_link IS NOT NULL
      AND length(web_link) BETWEEN 1 AND 2048)
  )
);
CREATE INDEX shared_files_room_created ON shared_files(room_id, created_at_ms, id);
CREATE INDEX shared_files_r2_expiry ON shared_files(expires_at_ms) WHERE storage='r2' AND deleted_at_ms IS NULL;
CREATE TABLE message_file_refs (
  message_id TEXT NOT NULL REFERENCES messages(id),
  file_id TEXT NOT NULL REFERENCES shared_files(id),
  position INTEGER NOT NULL CHECK (position >= 0 AND position <= 7),
  PRIMARY KEY (message_id, position),
  UNIQUE (message_id, file_id)
);
CREATE TABLE file_gc_runs (
  id TEXT PRIMARY KEY,
  at_ms INTEGER NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json))
);
CREATE TRIGGER shared_files_no_delete BEFORE DELETE ON shared_files BEGIN SELECT RAISE(ABORT,'shared file rows are kept'); END;
CREATE TRIGGER shared_files_tombstone_only BEFORE UPDATE ON shared_files WHEN NOT (OLD.storage='r2' AND OLD.deleted_at_ms IS NULL AND OLD.tombstone_reason IS NULL AND NEW.deleted_at_ms IS NOT NULL AND NEW.deleted_at_ms>=OLD.expires_at_ms AND NEW.tombstone_reason='expired' AND NEW.id IS OLD.id AND NEW.room_id IS OLD.room_id AND NEW.storage IS OLD.storage AND NEW.name IS OLD.name AND NEW.mime IS OLD.mime AND NEW.size_bytes IS OLD.size_bytes AND NEW.sha256 IS OLD.sha256 AND NEW.sha256_verified IS OLD.sha256_verified AND NEW.uploader_id IS OLD.uploader_id AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.expires_at_ms IS OLD.expires_at_ms AND NEW.r2_key IS OLD.r2_key AND NEW.drive_file_id IS OLD.drive_file_id AND NEW.web_link IS OLD.web_link) BEGIN SELECT RAISE(ABORT,'shared file rows change only by tombstone'); END;
CREATE TRIGGER message_file_refs_no_update BEFORE UPDATE ON message_file_refs BEGIN SELECT RAISE(ABORT,'message file refs are immutable'); END;
CREATE TRIGGER message_file_refs_no_delete BEFORE DELETE ON message_file_refs BEGIN SELECT RAISE(ABORT,'message file refs are immutable'); END;
CREATE TRIGGER message_file_refs_same_room BEFORE INSERT ON message_file_refs WHEN (SELECT room_id FROM messages WHERE id=NEW.message_id) IS NOT (SELECT room_id FROM shared_files WHERE id=NEW.file_id) BEGIN SELECT RAISE(ABORT,'file and message are in different rooms'); END;

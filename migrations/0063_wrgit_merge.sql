-- WG-5 submit and merge fields on the WG-2 wrgit index (0061_wrgit.sql).
-- Workspace repo name stays wrgit_workspaces.repo. 0062 is WG-3's remote and pending fork.
-- submitted_sha is the sha submit recorded. merged_sha is the sha canonical main accepted.
-- Lock expiry stays on wrgit_merge_lock.expires_at from 0061.
ALTER TABLE wrgit_workspaces ADD COLUMN canonical_repo TEXT
  CHECK (canonical_repo IS NULL OR (length(canonical_repo) BETWEEN 1 AND 200));

ALTER TABLE wrgit_workspaces ADD COLUMN unit TEXT
  CHECK (unit IS NULL OR (length(unit) BETWEEN 1 AND 128));

ALTER TABLE wrgit_workspaces ADD COLUMN submitted_sha TEXT
  CHECK (submitted_sha IS NULL OR (length(submitted_sha) = 40 AND submitted_sha NOT GLOB '*[^0-9a-f]*'));

ALTER TABLE wrgit_workspaces ADD COLUMN merged_sha TEXT
  CHECK (merged_sha IS NULL OR (length(merged_sha) = 40 AND merged_sha NOT GLOB '*[^0-9a-f]*'));

-- Recorded before canonical main moves. A later retry may treat canonical==sha as its own
-- fast-forward only when a row for this workspace, receipt, and sha is already here.
CREATE TABLE wrgit_merge_intents (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 128),
  receipt_id TEXT NOT NULL CHECK (length(receipt_id) BETWEEN 1 AND 128),
  sha TEXT NOT NULL CHECK (length(sha) = 40 AND sha NOT GLOB '*[^0-9a-f]*'),
  lock_token TEXT NOT NULL CHECK (length(lock_token) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (workspace_id, receipt_id, sha)
);

CREATE TABLE wrgit_merges (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL UNIQUE CHECK (length(workspace_id) BETWEEN 1 AND 128),
  receipt_id TEXT NOT NULL CHECK (length(receipt_id) BETWEEN 1 AND 128),
  sha TEXT NOT NULL CHECK (length(sha) = 40 AND sha NOT GLOB '*[^0-9a-f]*'),
  base_sha TEXT NOT NULL CHECK (length(base_sha) = 40 AND base_sha NOT GLOB '*[^0-9a-f]*'),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  merged_at INTEGER NOT NULL CHECK (merged_at >= 0)
);

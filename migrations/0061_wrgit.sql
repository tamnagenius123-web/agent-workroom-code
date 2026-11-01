-- WG-2 WR-GIT. Artifacts holds the git objects. These tables are the workroom index.
-- Canonical main is written only by the worker merge step, serialized by the one lock row.
-- Timestamps are unix milliseconds. The lock is free when holder is null or expires_at <= now.
CREATE TABLE wrgit_workspaces (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 128),
  agent_id TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 128),
  repo TEXT NOT NULL UNIQUE CHECK (length(repo) BETWEEN 1 AND 200),
  base_sha TEXT NOT NULL CHECK (length(base_sha) = 40 AND base_sha NOT GLOB '*[^0-9a-f]*'),
  head_sha TEXT CHECK (head_sha IS NULL OR (length(head_sha) = 40 AND head_sha NOT GLOB '*[^0-9a-f]*')),
  status TEXT NOT NULL CHECK (status IN ('open', 'submitted', 'merged', 'canceled')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  merged_at INTEGER CHECK (merged_at IS NULL OR merged_at >= 0),
  CHECK (status != 'submitted' OR head_sha IS NOT NULL),
  CHECK (status != 'merged' OR (head_sha IS NOT NULL AND merged_at IS NOT NULL)),
  CHECK (status = 'merged' OR merged_at IS NULL)
);
CREATE INDEX wrgit_workspaces_task ON wrgit_workspaces(task_id, created_at);
CREATE TABLE wrgit_commits (
  repo TEXT NOT NULL CHECK (length(repo) BETWEEN 1 AND 200),
  sha TEXT NOT NULL CHECK (length(sha) = 40 AND sha NOT GLOB '*[^0-9a-f]*'),
  agent_id TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 128),
  task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 128),
  pushed_at INTEGER NOT NULL CHECK (pushed_at >= 0),
  PRIMARY KEY (repo, sha)
);
CREATE INDEX wrgit_commits_task ON wrgit_commits(task_id, pushed_at);
CREATE TABLE wrgit_merge_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT CHECK (holder IS NULL OR length(holder) BETWEEN 1 AND 128),
  acquired_at INTEGER,
  expires_at INTEGER,
  CHECK (
    (holder IS NULL AND acquired_at IS NULL AND expires_at IS NULL)
    OR (holder IS NOT NULL AND acquired_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at >= acquired_at)
  )
);
INSERT INTO wrgit_merge_lock (id, holder, acquired_at, expires_at) VALUES (1, NULL, NULL, NULL);

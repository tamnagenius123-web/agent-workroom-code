-- WG-3. Public clone URL for a workspace, and the retry marker when a claim's fork has not finished.
-- Credential material is not a column. 0063 is reserved for WG-5.
ALTER TABLE wrgit_workspaces ADD COLUMN remote_url TEXT
  CHECK (remote_url IS NULL OR (length(remote_url) BETWEEN 1 AND 500 AND remote_url NOT GLOB '*://*@*'));

CREATE TABLE wrgit_workspace_pending (
  task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 128),
  agent_id TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 128),
  repo TEXT NOT NULL UNIQUE CHECK (length(repo) BETWEEN 1 AND 200),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (task_id, agent_id)
);

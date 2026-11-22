-- G1 run/attempt envelope. This file is not applied to a remote database by the change that adds it.
-- The task, lease, intent, budget, and message tables stay the authority. These rows only bind one attempt.
CREATE TABLE execution_cancels (
  task_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation >= 0)
);
CREATE TABLE execution_runs (
  run_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL,
  task_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  spec_digest TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 0),
  intent_revision INTEGER NOT NULL CHECK (intent_revision >= 0),
  cancel_generation INTEGER NOT NULL CHECK (cancel_generation >= 0),
  harness_digest TEXT NOT NULL,
  model_digest TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  context_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  failure TEXT,
  generation_id TEXT,
  reservation_id TEXT,
  artifact_id TEXT,
  receipt_id TEXT,
  trace_json TEXT NOT NULL CHECK (json_valid(trace_json)),
  created_at INTEGER NOT NULL
);
CREATE TABLE execution_receipts (
  receipt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  verifier TEXT NOT NULL,
  author_principal TEXT NOT NULL,
  task_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  intent_revision INTEGER NOT NULL,
  generation_id TEXT,
  artifact_id TEXT,
  disposition TEXT NOT NULL CHECK (disposition IN ('PASS', 'FAIL', 'UNKNOWN', 'CANCELED')),
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

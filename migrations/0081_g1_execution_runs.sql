-- G1 run/attempt envelope. This file is not applied to a remote database by the change that adds it.
-- 0080 is gate telegram_topics on the shared D1. This unit is 0081.
-- The task, lease, intent, budget, and message tables stay the authority. These rows only bind one attempt.
-- IF NOT EXISTS makes a re-run harmless.
CREATE TABLE IF NOT EXISTS execution_cancels (
  task_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation >= 0)
);
CREATE TABLE IF NOT EXISTS execution_runs (
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
CREATE INDEX IF NOT EXISTS execution_runs_attempt ON execution_runs(attempt_id);
CREATE INDEX IF NOT EXISTS execution_runs_task ON execution_runs(task_id);
CREATE TABLE IF NOT EXISTS execution_receipts (
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
CREATE INDEX IF NOT EXISTS execution_receipts_run ON execution_receipts(run_id);

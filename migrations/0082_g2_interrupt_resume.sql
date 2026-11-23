-- G2 interrupt/resume checkpoint and interrupt audit tables.
-- 0080 belongs to gate telegram_topics; 0081 is G1 execution_runs. This unit is 0082.
-- This file is not applied to a remote database by the change that adds it.
-- IF NOT EXISTS makes a re-run harmless.
CREATE TABLE IF NOT EXISTS execution_checkpoints (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 0),
  intent_revision INTEGER NOT NULL CHECK (intent_revision >= 0),
  cancel_generation INTEGER NOT NULL CHECK (cancel_generation >= 0),
  checkpoint_step TEXT NOT NULL CHECK (checkpoint_step IN ('claimed', 'reserved', 'modeled', 'tool', 'artifact', 'settled', 'canceled', 'unknown', 'rejected')),
  model_text TEXT,
  tool_digest TEXT,
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  resumed_count INTEGER NOT NULL DEFAULT 0 CHECK (resumed_count >= 0),
  last_heartbeat_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS execution_checkpoints_task ON execution_checkpoints(task_id, updated_at);
CREATE TABLE IF NOT EXISTS execution_interrupts (
  interrupt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT,
  actor_principal TEXT NOT NULL,
  cancel_generation INTEGER NOT NULL CHECK (cancel_generation >= 0),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS execution_interrupts_task ON execution_interrupts(task_id, cancel_generation);

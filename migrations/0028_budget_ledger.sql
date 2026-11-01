-- D1 single-writer budget ledger for OpenRouter reserve-then-settle.
-- Replaces the JSON file ledger. Money is integer micro-USD.
-- The hard cap is env BUDGET_CAP_USD_MICROS (default 3000000), not a column.
-- Counted holds are open, pending_actual, and unknown.
-- Null provider accounts are stored as empty text so UNIQUE can dedupe generations.
CREATE TABLE budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  project TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'pending_actual', 'unknown', 'settled', 'closed_no_charge')),
  micro_usd INTEGER NOT NULL CHECK (micro_usd >= 0),
  pricing_snapshot_json TEXT NOT NULL CHECK (json_valid(pricing_snapshot_json)),
  generation_id TEXT,
  provider_account TEXT NOT NULL DEFAULT '',
  pending_reason TEXT,
  evidence TEXT,
  flag TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX budget_reservations_project_state ON budget_reservations(project, state);
CREATE TABLE budget_actuals (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  project TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'openrouter',
  provider_account TEXT NOT NULL DEFAULT '',
  generation_id TEXT NOT NULL,
  model TEXT NOT NULL,
  micro_usd INTEGER NOT NULL CHECK (micro_usd >= 0),
  cost_field TEXT NOT NULL CHECK (cost_field IN ('total_cost', 'usage')),
  tokens_json TEXT NOT NULL CHECK (json_valid(tokens_json)),
  flag TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_account, generation_id)
);
CREATE INDEX budget_actuals_project ON budget_actuals(project);
CREATE TABLE unit_cost_records (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  category TEXT NOT NULL,
  cost_usd_micros TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  request_hash TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  UNIQUE (principal_id, idempotency_key)
);
CREATE INDEX unit_cost_records_room_time ON unit_cost_records(room_id, recorded_at);
CREATE TABLE dispatch_calls (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  reservation_id TEXT,
  state TEXT NOT NULL,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  message_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (principal_id, idempotency_key)
);

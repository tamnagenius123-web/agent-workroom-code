-- Decision-layer judgments. Separate from 0055 decisions, which is the owner-decision ledger.
-- A row records one shadow or live judgment. It is not an owner approval and not a verification PASS.
CREATE TABLE judgments (
  id TEXT PRIMARY KEY,
  point TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  source_watermark TEXT,
  hard_filter_result_json TEXT CHECK (hard_filter_result_json IS NULL OR json_valid(hard_filter_result_json)),
  request_payload_json TEXT CHECK (request_payload_json IS NULL OR json_valid(request_payload_json)),
  provider_path TEXT NOT NULL CHECK (provider_path IN ('d1', 'jev', 'llm', 'rule')),
  routing_reason TEXT,
  model TEXT,
  answer_json TEXT CHECK (answer_json IS NULL OR json_valid(answer_json)),
  probs_json TEXT CHECK (probs_json IS NULL OR json_valid(probs_json)),
  verdict TEXT NOT NULL CHECK (verdict IN ('act', 'reject', 'unsettled', 'fallback_rule')),
  shadow_decider_json TEXT CHECK (shadow_decider_json IS NULL OR json_valid(shadow_decider_json)),
  rule_baseline TEXT NOT NULL,
  agreed INTEGER NOT NULL CHECK (agreed IN (0, 1)),
  cost_micro_usd INTEGER CHECK (cost_micro_usd IS NULL OR cost_micro_usd >= 0),
  gen_id TEXT,
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at TEXT NOT NULL,
  consumed_by TEXT,
  CHECK (
    (provider_path = 'rule' AND model IS NULL) OR
    (
      provider_path = 'd1'
      AND model LIKE 'liquid/d1.2-ultra%'
      AND model NOT LIKE '%latest%'
      AND model NOT LIKE '~%'
    ) OR
    (provider_path = 'jev' AND model LIKE 'typesafe/jev-1.14-%' AND model != 'typesafe/jev-1.14-') OR
    (
      provider_path = 'llm' AND model IS NOT NULL
      AND model NOT LIKE 'typesafe/%'
      AND model NOT LIKE 'liquid/%'
      AND model NOT LIKE '~%'
      AND model != 'perplexity/pplx-decider-v1.2'
    )
  )
);
CREATE INDEX judgments_unit_point ON judgments(unit_id, point, created_at DESC);

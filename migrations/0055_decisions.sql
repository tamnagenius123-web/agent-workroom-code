-- H3 weighted decisions. Agents cite a decision id instead of asking the owner again.
-- Renumbered 0053_decisions.sql -> 0055 in grok/batch-a. 0053 is 0053_claude_alias.sql on main.
-- Apply after 0054 (intent_versions). directive_id references owner_directives (0045, not in this branch).
-- weight is the provenance class. Rank is explicit: USER_STATED 3 > relay 2 > inferred 1.
-- A relayed or inferred row cannot store owner text or an approval bit. Owner text is not approval.
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  directive_id TEXT NOT NULL REFERENCES owner_directives(id),
  intent_version INTEGER NOT NULL REFERENCES intent_versions(version),
  statement TEXT NOT NULL,
  criteria_json TEXT NOT NULL CHECK (json_valid(criteria_json)),
  alternatives_json TEXT NOT NULL CHECK (json_valid(alternatives_json)),
  best_choice TEXT NOT NULL,
  scored_choice TEXT NOT NULL,
  weight TEXT NOT NULL,
  weight_rank INTEGER NOT NULL,
  provenance TEXT NOT NULL,
  approval INTEGER NOT NULL,
  owner_text TEXT,
  recorded_by TEXT NOT NULL,
  room_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (weight IN ('USER_STATED', 'relay', 'inferred')),
  CHECK (
    (weight = 'USER_STATED' AND weight_rank = 3 AND approval = 1) OR
    (weight = 'relay' AND weight_rank = 2 AND approval = 0 AND owner_text IS NULL) OR
    (weight = 'inferred' AND weight_rank = 1 AND approval = 0 AND owner_text IS NULL)
  ),
  -- Replay is (recorded_by, idempotency_key, room_id). A global pair would reject a legitimate row in another room.
  -- This CREATE starts the table empty, so no existing row can violate the key.
  UNIQUE (recorded_by, room_id, idempotency_key)
);
CREATE INDEX decisions_directive ON decisions(directive_id, weight_rank DESC, created_at DESC);
CREATE INDEX decisions_created ON decisions(created_at);
CREATE INDEX decisions_intent ON decisions(intent_version);

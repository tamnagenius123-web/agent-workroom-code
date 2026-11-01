-- OCG-W W6: experience ledger (self-evolution with independent keep/revert). See docs/specs/ocg-w6-experience.md.
-- Lineage: Harness² EXPERIENCE.md (arXiv 2610.14224), RSI-Anything propose->predict->execute->keep (arXiv 2610.13912), MASS independent supervision (arXiv 2610.12176), INORI H-RS1 (no auto-apply).
-- Nothing in this table is ever applied automatically. Each trigger is one line because the local harness splits on a semicolon followed by a newline.
CREATE TABLE experience_entries (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  component TEXT NOT NULL CHECK (component IN ('system_prompt', 'guardrails', 'memory', 'tool_guidance', 'subagents', 'skills', 'scripts', 'plugins')),
  change TEXT NOT NULL CHECK (length(change) BETWEEN 1 AND 4000),
  prediction TEXT NOT NULL CHECK (length(prediction) BETWEEN 1 AND 2000),
  source_message_id TEXT NOT NULL REFERENCES messages(id),
  proposed_by TEXT NOT NULL REFERENCES principals(id),
  state TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'observed', 'kept', 'reverted')),
  outcome TEXT CHECK (outcome IS NULL OR length(outcome) BETWEEN 1 AND 4000),
  outcome_message_id TEXT REFERENCES messages(id),
  observed_by TEXT REFERENCES principals(id),
  observed_at TEXT,
  verdict_by TEXT REFERENCES principals(id),
  verdict_reason TEXT CHECK (verdict_reason IS NULL OR length(verdict_reason) BETWEEN 1 AND 2000),
  verdict_digest TEXT CHECK (verdict_digest IS NULL OR length(verdict_digest) = 64),
  verdict_at TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  CHECK ((state = 'proposed') = (outcome IS NULL)),
  CHECK ((state IN ('kept', 'reverted')) = (verdict_by IS NOT NULL))
);
CREATE INDEX experience_room_state ON experience_entries(room_id, state, component);
CREATE TRIGGER experience_no_delete BEFORE DELETE ON experience_entries BEGIN SELECT RAISE(ABORT,'experience is append-only'); END;
CREATE TRIGGER experience_frozen_fields BEFORE UPDATE ON experience_entries WHEN NEW.id IS NOT OLD.id OR NEW.room_id IS NOT OLD.room_id OR NEW.component IS NOT OLD.component OR NEW.change IS NOT OLD.change OR NEW.prediction IS NOT OLD.prediction OR NEW.source_message_id IS NOT OLD.source_message_id OR NEW.proposed_by IS NOT OLD.proposed_by OR NEW.created_at IS NOT OLD.created_at OR (OLD.outcome IS NOT NULL AND (NEW.outcome IS NOT OLD.outcome OR NEW.outcome_message_id IS NOT OLD.outcome_message_id OR NEW.observed_by IS NOT OLD.observed_by OR NEW.observed_at IS NOT OLD.observed_at)) OR OLD.state IN ('kept','reverted') BEGIN SELECT RAISE(ABORT,'experience fields are immutable once written'); END;
CREATE TRIGGER experience_transition BEFORE UPDATE ON experience_entries WHEN NEW.state IS NOT OLD.state AND NOT ((OLD.state='proposed' AND NEW.state='observed') OR (OLD.state='observed' AND NEW.state IN ('kept','reverted') AND NEW.verdict_by IS NOT NULL AND NEW.verdict_by<>OLD.proposed_by AND NEW.verdict_by<>OLD.observed_by AND EXISTS (SELECT 1 FROM memory_reviewers r WHERE r.principal_id=NEW.verdict_by))) BEGIN SELECT RAISE(ABORT,'experience verdict requires an observed entry and an independent listed reviewer'); END;

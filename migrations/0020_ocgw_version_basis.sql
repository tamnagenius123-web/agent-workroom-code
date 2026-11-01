-- OCG-W rev2c (Codex ec45569a P2 #2 at 80cc719). Each trigger is one line because the local harness splits on a semicolon followed by a newline.
-- 0018 inferred source_version / outcome_message_version for pre-rev2 rows from timestamps (max revision created at or before the row). That is not proof
-- of what the proposer read or the reviewer saw. version_basis records how the pin was obtained: 'pinned' = written by rev2+ code at proposal time.
-- 'inferred' = present before this migration. Rows written between 0018 and 0020 cannot be told apart from 0018 backfills in-database, so every
-- pre-0020 row is conservatively 'inferred' (understates, never overstates). New rows default to pinned; a promotion copies its source basis (inferred is only ever an understatement); basis is frozen.
ALTER TABLE memory_items ADD COLUMN version_basis TEXT NOT NULL DEFAULT 'pinned' CHECK (version_basis IN ('pinned','inferred'));
ALTER TABLE experience_entries ADD COLUMN version_basis TEXT NOT NULL DEFAULT 'pinned' CHECK (version_basis IN ('pinned','inferred'));
UPDATE memory_items SET version_basis='inferred';
DROP TRIGGER experience_frozen_fields;
UPDATE experience_entries SET version_basis='inferred';
CREATE TRIGGER experience_frozen_fields BEFORE UPDATE ON experience_entries WHEN NEW.id IS NOT OLD.id OR NEW.room_id IS NOT OLD.room_id OR NEW.component IS NOT OLD.component OR NEW.change IS NOT OLD.change OR NEW.prediction IS NOT OLD.prediction OR NEW.source_message_id IS NOT OLD.source_message_id OR NEW.proposed_by IS NOT OLD.proposed_by OR NEW.created_at IS NOT OLD.created_at OR (OLD.outcome IS NOT NULL AND (NEW.outcome IS NOT OLD.outcome OR NEW.outcome_message_id IS NOT OLD.outcome_message_id OR NEW.observed_by IS NOT OLD.observed_by OR NEW.observed_at IS NOT OLD.observed_at)) OR OLD.state IN ('kept','reverted') BEGIN SELECT RAISE(ABORT,'experience fields are immutable once written'); END;
CREATE TRIGGER memory_items_basis_frozen BEFORE UPDATE OF version_basis ON memory_items WHEN NEW.version_basis IS NOT OLD.version_basis BEGIN SELECT RAISE(ABORT,'version_basis is immutable'); END;
CREATE TRIGGER experience_basis_frozen BEFORE UPDATE OF version_basis ON experience_entries WHEN NEW.version_basis IS NOT OLD.version_basis BEGIN SELECT RAISE(ABORT,'version_basis is immutable'); END;

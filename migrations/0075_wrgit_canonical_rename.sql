-- WG-11. The canonical repo is agent-workroom in the native ARTIFACTS namespace workroom.
-- 0068 backfilled the old name main/agent-workroom and is already applied, so it stays as is.
-- This renames those rows so every row matches WRGIT_CANONICAL_REPO. Other values are untouched.
UPDATE wrgit_workspaces SET canonical_repo = 'agent-workroom' WHERE canonical_repo = 'main/agent-workroom';

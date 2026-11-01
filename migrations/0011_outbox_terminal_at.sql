-- Outbox retention ages from completion, not creation (Codex review). terminal_at is set when a row becomes delivered/failed.
ALTER TABLE webhook_outbox ADD COLUMN terminal_at INTEGER;
-- Backfill: delivered rows use delivered_at. Failed rows have no completion stamp, so the backfill uses the latest
-- known activity, MAX(next_at, created_at). That is conservative, because next_at is always >= the last attempt time.
UPDATE webhook_outbox SET terminal_at = COALESCE(delivered_at, MAX(next_at, created_at)) WHERE status IN ('delivered','failed');

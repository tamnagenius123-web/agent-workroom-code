-- wrk_ credential usage signal. last_used_at is the most recent successful
-- authentication time (epoch ms) for an enrollment credential, written
-- best-effort and throttled by the worker. NULL means the credential has not
-- authenticated since this column landed. It stores no secret material: the
-- token and its hash are never written by the usage path.
ALTER TABLE agent_credentials ADD COLUMN last_used_at INTEGER CHECK (last_used_at IS NULL OR last_used_at >= 0);

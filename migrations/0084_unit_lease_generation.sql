-- U8-G6 follow-up (dots P1 on PR #29): lease generation fence. Holder id alone
-- cannot distinguish two executions of the same holder: after a re-claim, the
-- previous execution's delayed heartbeat/release would still match the row.
-- generation starts at 1 on the first claim and increments on every
-- successful claim (takeover or refresh); heartbeat/release must present the
-- generation issued by the latest claim. Not applied by this change.
ALTER TABLE unit_leases ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;

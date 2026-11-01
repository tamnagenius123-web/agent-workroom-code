-- ORCH-A1 (owner t995u): one lease row per unit. A claim is one upsert so two holders cannot both win.
CREATE TABLE IF NOT EXISTS unit_leases (
  unit_id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held', 'released', 'expired'))
);

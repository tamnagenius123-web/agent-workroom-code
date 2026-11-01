-- PBKDF2-ITER (owner t783u): lazily upgraded owner password hash. The worker reads this row
-- before the OWNER_PASSWORD_HASH secret; a successful login with a legacy/weaker hash writes
-- the 600k chained hash here (secrets can't be rewritten from inside the worker).
CREATE TABLE IF NOT EXISTS owner_credential (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  source_hash_fp TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

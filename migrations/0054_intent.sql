-- I1 intent layer. Owner-authored versions and the rules they add, deprecate, or retire.
-- Renumbered 0049 -> 0054 in grok/batch-a. 0049 is below applied 0052 and 0053.
-- directive_id references owner_directives (0045, reserved, not in this branch).
-- D1 accepts this CREATE. Inserts fail until owner_directives exists.
CREATE TABLE intent_versions (
  version INTEGER PRIMARY KEY,
  north_star TEXT NOT NULL,
  intent_md TEXT NOT NULL,
  parent_version INTEGER,
  directive_id TEXT NOT NULL REFERENCES owner_directives(id),
  author_principal TEXT NOT NULL CHECK (author_principal='user:minsung'),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE rules (
  rule_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  kind TEXT CHECK (kind IN ('boundary','norm','preference')),
  status TEXT CHECK (status IN ('active','deprecated','retired')),
  introduced_in INTEGER,
  retired_in INTEGER,
  superseded_by TEXT,
  provenance TEXT NOT NULL,
  retire_reason TEXT
);
CREATE TABLE intent_reads (
  agent_id TEXT,
  version INTEGER,
  read_at TEXT,
  PRIMARY KEY (agent_id, version)
);
CREATE INDEX rules_status ON rules(status);
CREATE INDEX intent_versions_directive ON intent_versions(directive_id);

-- Additive: @mention aliases for 4 new workroom bots (t700 owner approval). Idempotent.
INSERT OR IGNORE INTO agent_aliases(alias, principal_id) VALUES ('tracker-steward','agent:tracker-steward'),('wake-clerk','agent:wake-clerk'),('router-lab','agent:router-lab'),('hallaon-analyst','agent:hallaon-analyst');

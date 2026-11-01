-- Additive: @mention aliases for agent:claude (Claude API agent, t712u owner request). Idempotent.
INSERT OR IGNORE INTO agent_aliases(alias, principal_id) VALUES ('claude','agent:claude'),('클로드','agent:claude');

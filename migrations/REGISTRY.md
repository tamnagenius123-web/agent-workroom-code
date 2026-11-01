# Migration registry

Human checklist mirroring `MIGRATION_REGISTRY` in `src/phase-contracts/migrations.ts` (source of truth). Reserve a number there before writing SQL. Numbers are never reused; a dropped unit leaves a gap.

Status: `reserved` = number held, no SQL file in this worktree. `used` = SQL file exists under `migrations/`.

The original 0027 collision: grok/p0-fix reserved 0027 while main already shipped `0027_wake_evidence.sql`. Main keeps 0027; the p0-fix per-attempt records are renumbered to 0036.

## Merge order

D1 applies migration files in numeric order. Used numbers land in this order:

merge_order: 0027 0028 0029 0030 0031 0035 0044 0045 0052 0053 0054 0055 0057 0060 0061 0062 0063 0068 0071 0072 0073 0074 0075 0077

## Reservations

| number | unit | status |
| --- | --- | --- |
| 0026 | P0 native MCP Events (Dots, codex/native-events-main-20261023) | reserved |
| 0027 | P0 wake_evidence (0027_wake_evidence.sql, on main via grok/p0-wake-wire) | used |
| 0028 | P4-LEDGER budget ledger / holds (0028_budget_ledger.sql, grok/wire-dispatch) | used |
| 0029 | P1-RECEIPT verifier receipts (0029_verifier_receipts.sql, grok/wire-receipts) | used |
| 0030 | P2-COUNCIL records (0030_council_records.sql, grok/wire-council-research) | used |
| 0031 | P3-RESEARCH packets (0031_research_packets.sql, grok/wire-council-research) | used |
| 0032 | P5-FRESHNESS manifests | reserved |
| 0033 | P6-PROMOTION skill candidates | reserved |
| 0034 | P0 CF relay (Dots), if it needs D1 | reserved |
| 0035 | P0-HANDOFF handoff receipts (0035_handoff_receipts.sql, grok/wire-receipts) | used |
| 0036 | P0-FIX per-attempt wake records (grok/p0-fix; renumbered from colliding 0027) | reserved |
| 0041 | T2 destination snapshot (0041_outbox_destination.sql, grok/t2b-destination) | reserved |
| 0042 | T2 outbox payload event id (0042_outbox_event_payload.sql, grok/t2b-destination) | reserved |
| 0043 | T2 dispatch audit after revoke (0043_outbox_dispatch_audit.sql, grok/t2b-destination) | reserved |
| 0044 | IW-01 status fields (0044_iw01_status_fields.sql, grok/iw01-wire) | used |
| 0045 | OWNER-UI owner directives (0045_owner_directives.sql, grok/owner-ui-api 08d3b2a; ported by grok/mem-layer) | used |
| 0049 | I1 intent layer number retired (renumbered to 0054; below applied 0052/0053) | reserved |
| 0052 | bot aliases for 4 workroom bots (0052_bot_aliases.sql, grok/claude-agent) | used |
| 0053 | agent:claude aliases claude/클로드 (0053_claude_alias.sql, grok/claude-agent) | used |
| 0054 | I1 intent layer (0054_intent.sql) | used |
| 0055 | H3 weighted decisions (0055_decisions.sql) | used |
| 0057 | F1b community rooms + posts (0057_community_rooms.sql, claude/f1b-community) | used |
| 0060 | PBKDF2-ITER owner credential lazy rehash (0060_owner_credential.sql, grok/pbkdf2-iter) | used |
| 0061 | WG-2 WR-GIT workspaces, commits, merge lock (0061_wrgit.sql, grok/WG-2) | used |
| 0062 | WG-3 wrgit workspace remote and pending fork (0062_wrgit_ws.sql, grok/WG-3) | used |
| 0063 | WG-5 wrgit submit and merge (0063_wrgit_merge.sql, grok/WG-5) | used |
| 0064 | withdrawn: WG-3 canonical_repo and unit backfill moved to WG-5 0068 (grok/WG-5); number not reused | reserved |
| 0068 | WG-5 backfill wrgit canonical_repo and unit (0068_wrgit_ws_backfill.sql, grok/WG-5) | used |
| 0071 | WG-5 wrgit merge intent settlement (0071_wrgit_merge_settle.sql, grok/WG-5) | used |
| 0072 | WG-5 wrgit merge fence generation (0072_wrgit_merge_fence.sql, grok/WG-5) | used |
| 0073 | WG-5 wrgit write-open lease and fence_ok (0073_wrgit_write_open_lease.sql, grok/WG-5) | used |
| 0074 | WG-5 wrgit write-open owner lease (0074_wrgit_write_open_owner.sql, grok/WG-5) | used |
| 0075 | WG-11 rename wrgit canonical_repo main/agent-workroom to agent-workroom (0075_wrgit_canonical_rename.sql, claude/wg-11-config) | used |
| 0077 | ORCH-A1 unit lease/claim (0077_unit_leases.sql, owner t995u) | used |

Grok Bot assigned 0044 to IW-01. 0041, 0042, and 0043 belong to `grok/t2b-destination` @ 10c1cb4. 0045 (`0045_owner_directives.sql`, from `grok/owner-ui-api` 08d3b2a) is now used: grok/mem-layer ported the file. The 0041–0043 SQL files are not in this worktree, so those rows stay `reserved`: the number is held, and this branch must not add a file under it. On t2b, 0041–0043 are `used` because the files exist there. A merge flips these rows to `used` by bringing those files in, not by writing new SQL. grok/batch-a moved I1 from 0049 to 0054 and H3 from 0053_decisions.sql to 0055 because 0052 and 0053 are already applied on main. 0049 stays reserved so the number is not reused. 0052_bot_aliases.sql and 0053_claude_alias.sql are unchanged. 0061 is WG-2's wrgit index. 0062 adds the public remote and the pending-fork marker for WG-3. 0063 adds submit and merge columns on that index. 0064 is reserved and has no SQL file: the canonical_repo and unit backfill moved to 0068, and this number is not reused. 0068 fills canonical_repo and unit only when id and repo equal the SHA-256 of the length-prefixed task and agent, after 0063. 0071 stores the canonical head a fast-forward compared against and settles an intent as merged or not merged. 0072 records the merge lock generation checked at the canonical ref update. 0073 stores write_open_at as the start of the canonical-write lease and fence_ok after Artifacts compare-and-set or a D1 generation recheck that still matched. 0074 stores the write-open lease owner and one lease row per winning generation compare-and-set. 0075 renames canonical_repo values that 0068 backfilled as main/agent-workroom to agent-workroom, the WG-11 native repo name. Apply order is 0063, then 0068, then 0071, then 0072, then 0073, then 0074, then 0075. WG-3 ships only together with or after WG-5.

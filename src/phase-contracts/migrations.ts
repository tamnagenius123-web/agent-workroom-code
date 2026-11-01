// Migration-number registry (W0). Reserve a number here BEFORE writing a migration on any branch.
// Status: reserved = number held, no SQL file in this worktree; used = SQL file exists under migrations/. Numbers are never reused; a dropped unit leaves a gap.
export const MIGRATION_REGISTRY = {
  '0026': { unit: 'P0 native MCP Events (Dots, codex/native-events-main-20261023)', status: 'reserved' },
  '0027': { unit: 'P0 wake_evidence (0027_wake_evidence.sql, on main via grok/p0-wake-wire)', status: 'used' },
  '0028': { unit: 'P4-LEDGER budget ledger / holds (0028_budget_ledger.sql, grok/wire-dispatch)', status: 'used' },
  '0029': { unit: 'P1-RECEIPT verifier receipts (0029_verifier_receipts.sql, grok/wire-receipts)', status: 'used' },
  '0030': { unit: 'P2-COUNCIL records (0030_council_records.sql, grok/wire-council-research)', status: 'used' },
  '0031': { unit: 'P3-RESEARCH packets (0031_research_packets.sql, grok/wire-council-research)', status: 'used' },
  '0032': { unit: 'P5-FRESHNESS manifests', status: 'reserved' },
  '0033': { unit: 'P6-PROMOTION skill candidates', status: 'reserved' },
  '0034': { unit: 'P0 CF relay (Dots), if it needs D1', status: 'reserved' },
  '0035': { unit: 'P0-HANDOFF handoff receipts (0035_handoff_receipts.sql, grok/wire-receipts)', status: 'used' },
  '0036': { unit: 'P0-FIX per-attempt wake records (grok/p0-fix; renumbered from colliding 0027)', status: 'reserved' },
  '0041': { unit: 'T2 destination snapshot (0041_outbox_destination.sql, grok/t2b-destination)', status: 'reserved' },
  '0042': { unit: 'T2 outbox payload event id (0042_outbox_event_payload.sql, grok/t2b-destination)', status: 'reserved' },
  '0043': { unit: 'T2 dispatch audit after revoke (0043_outbox_dispatch_audit.sql, grok/t2b-destination)', status: 'reserved' },
  '0044': { unit: 'IW-01 status fields (0044_iw01_status_fields.sql, grok/iw01-wire)', status: 'used' },
  '0045': { unit: 'OWNER-UI owner directives (0045_owner_directives.sql, grok/owner-ui-api 08d3b2a; ported by grok/mem-layer)', status: 'used' },
  '0049': { unit: 'I1 intent layer number retired (renumbered to 0054; below applied 0052/0053)', status: 'reserved' },
  '0052': { unit: 'bot aliases for 4 workroom bots (0052_bot_aliases.sql, grok/claude-agent)', status: 'used' },
  '0053': { unit: 'agent:claude aliases claude/클로드 (0053_claude_alias.sql, grok/claude-agent)', status: 'used' },
  '0054': { unit: 'I1 intent layer (0054_intent.sql)', status: 'used' },
  '0055': { unit: 'H3 weighted decisions (0055_decisions.sql)', status: 'used' },
  '0057': { unit: 'F1b community rooms + posts (0057_community_rooms.sql, claude/f1b-community)', status: 'used' },
  '0060': { unit: 'PBKDF2-ITER owner credential lazy rehash (0060_owner_credential.sql, grok/pbkdf2-iter)', status: 'used' },
  '0061': { unit: 'WG-2 WR-GIT workspaces, commits, merge lock (0061_wrgit.sql, grok/WG-2)', status: 'used' },
  '0062': { unit: 'WG-3 wrgit workspace remote and pending fork (0062_wrgit_ws.sql, grok/WG-3)', status: 'used' },
  '0063': { unit: 'WG-5 wrgit submit and merge (0063_wrgit_merge.sql, grok/WG-5)', status: 'used' },
  '0064': { unit: 'withdrawn: WG-3 canonical_repo and unit backfill moved to WG-5 0068 (grok/WG-5); number not reused', status: 'reserved' },
  '0068': { unit: 'WG-5 backfill wrgit canonical_repo and unit (0068_wrgit_ws_backfill.sql, grok/WG-5)', status: 'used' },
  '0071': { unit: 'WG-5 wrgit merge intent settlement (0071_wrgit_merge_settle.sql, grok/WG-5)', status: 'used' },
  '0072': { unit: 'WG-5 wrgit merge fence generation (0072_wrgit_merge_fence.sql, grok/WG-5)', status: 'used' },
  '0073': { unit: 'WG-5 wrgit write-open lease and fence_ok (0073_wrgit_write_open_lease.sql, grok/WG-5)', status: 'used' },
  '0074': { unit: 'WG-5 wrgit write-open owner lease (0074_wrgit_write_open_owner.sql, grok/WG-5)', status: 'used' },
  '0075': { unit: 'WG-11 rename wrgit canonical_repo main/agent-workroom to agent-workroom (0075_wrgit_canonical_rename.sql, claude/wg-11-config)', status: 'used' },
  '0077': { unit: 'ORCH-A1 unit lease/claim (0077_unit_leases.sql, owner t995u)', status: 'used' },
} as const;
export type ReservedMigration = keyof typeof MIGRATION_REGISTRY;

export interface MigrationAllocation {
  number: string;
  unit: string;
  status: string;
}

/** Flat view of the registry. Collision checks run on this list so a duplicated row cannot hide. */
export const MIGRATION_ALLOCATIONS: readonly MigrationAllocation[] = Object.entries(MIGRATION_REGISTRY).map(([number, row]) => ({
  number,
  unit: row.unit,
  status: row.status,
}));

/** Numbers must be unique, units must be unique, and every number must be above 0025 (main's last applied migration). */
export function findMigrationCollisions(rows: readonly { number: string; unit: string }[]): string[] {
  const errors: string[] = [];
  const numbers = new Map<string, number>();
  const units = new Map<string, number>();
  for (const row of rows) {
    if (!/^\d{4}$/.test(row.number) || Number(row.number) <= 25) errors.push(`number ${row.number} is not above 0025`);
    numbers.set(row.number, (numbers.get(row.number) ?? 0) + 1);
    units.set(row.unit, (units.get(row.unit) ?? 0) + 1);
  }
  for (const [number, count] of numbers) if (count > 1) errors.push(`duplicate number ${number}`);
  for (const [unit, count] of units) if (count > 1) errors.push(`duplicate unit ${unit}`);
  return errors;
}

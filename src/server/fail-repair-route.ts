// V3-9 FAIL-REPAIR-ROUTE (owner t887u: "fail나는거 수리는 claude에게 맡겨").
// Pure routing rule: a FAIL verdict becomes a repair claim for Claude, except on owner-pinned units.
// V3-7 owns reassignment: a builder with FAILs on two different shas of a unit is barred from it,
// and this router never hands a repair to a barred builder.

export type Principal = `agent:${string}`;

export interface Verdict {
  unit: string;
  sha: string;
  builder: Principal;
  verifier: Principal;
  result: 'PASS' | 'FAIL';
}

export interface RepairClaim {
  id: string;
  unit: string;
  failed_sha: string;
  assignee: Principal;
  /** The verifier who found the FAIL re-checks the repair, unless that would make them its author. */
  verifier: Principal | null;
}

export type RepairDecision =
  | { kind: 'none' }
  | { kind: 'rejected'; reason: 'self_verdict' | 'invalid_verdict' }
  | { kind: 'repair'; claim: RepairClaim }
  | { kind: 'pinned'; claim: RepairClaim }
  | { kind: 'reassign'; unit: string; barred: Principal[] }
  | { kind: 'owner'; unit: string; pinned: Principal; barred: Principal[] };

export const REPAIR_PRINCIPAL: Principal = 'agent:claude';

// Owner pins from t887u: OR-U2 stays with Dots, SSU-GW with Grok CLI (posts as agent:grok).
// Only the owner can change these, so a pinned builder that hits the V3-7 limit goes to the owner.
const OWNER_PINS: readonly (readonly [string, Principal])[] = [
  ['OR-U2', 'agent:dots'],
  ['SSU-GW', 'agent:grok'],
];

const BARRED_AFTER = 2;

// Verdicts come from an untrusted source (a verdict table or room post), so shape is checked here.
// A sha is a full lowercase 40-hex git object id; claim ids use it whole, so distinct shas never collide.
const SHA = /^[0-9a-f]{40}$/;
const UNIT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PRINCIPAL = /^agent:[a-z0-9][a-z0-9-]*$/;

function isValidVerdict(v: Verdict): boolean {
  const ok = (re: RegExp, x: unknown) => typeof x === 'string' && re.test(x);
  return !!v && ok(UNIT, v.unit) && ok(SHA, v.sha) && ok(PRINCIPAL, v.builder) && ok(PRINCIPAL, v.verifier)
    && (v.result === 'PASS' || v.result === 'FAIL');
}

function pinFor(unit: string): Principal | null {
  for (const [prefix, owner] of OWNER_PINS) if (unit === prefix || unit.startsWith(prefix + '-')) return owner;
  return null;
}

/** Builders with FAILs on at least two distinct shas of the unit. Two verifiers failing one sha is one failure. */
function barredBuilders(unit: string, verdicts: readonly Verdict[]): Principal[] {
  const failedShas = new Map<Principal, Set<string>>();
  for (const v of verdicts) {
    if (!isValidVerdict(v) || v.unit !== unit || v.result !== 'FAIL' || v.verifier === v.builder) continue;
    const shas = failedShas.get(v.builder) ?? new Set<string>();
    shas.add(v.sha);
    failedShas.set(v.builder, shas);
  }
  return [...failedShas].filter(([, shas]) => shas.size >= BARRED_AFTER).map(([builder]) => builder).sort();
}

export function routeVerdict(verdict: Verdict, history: readonly Verdict[]): RepairDecision {
  if (!isValidVerdict(verdict)) return { kind: 'rejected', reason: 'invalid_verdict' };
  if (verdict.verifier === verdict.builder) return { kind: 'rejected', reason: 'self_verdict' };
  if (verdict.result !== 'FAIL') return { kind: 'none' };
  const barred = barredBuilders(verdict.unit, [...history, verdict]);
  const pinned = pinFor(verdict.unit);
  const assignee = pinned ?? REPAIR_PRINCIPAL;
  if (barred.includes(assignee)) {
    return pinned ? { kind: 'owner', unit: verdict.unit, pinned, barred } : { kind: 'reassign', unit: verdict.unit, barred };
  }
  const claim: RepairClaim = {
    id: `${verdict.unit}-REPAIR-${verdict.sha}`,
    unit: verdict.unit,
    failed_sha: verdict.sha,
    assignee,
    verifier: verdict.verifier === assignee ? null : verdict.verifier,
  };
  return pinned ? { kind: 'pinned', claim } : { kind: 'repair', claim };
}

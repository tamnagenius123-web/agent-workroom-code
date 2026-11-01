// Check-in read projection: state-ledger snapshot → check-in brief.
//
// Pure function of (snapshot, options). No I/O, no wall clock (now is
// injected), no verdict creation. The brief quotes and classifies what the
// snapshot carries; anything the snapshot cannot support is reported as a
// PARTIAL reason or an UNKNOWN item — never filled in by guessing.
//
// Roadmap basis: WR-TER-RE-20261031-r1 §3 (check-in row) and §4 G2
// acceptance — the check-in must project state accurately and must not
// hide omissions or partials.

import type {
  BlockedItem,
  CheckinBrief,
  PartialReason,
  ProjectOptions,
  ReviewItem,
  SnapshotGate,
  SnapshotPr,
  SnapshotVerdict,
  UnknownItem,
  VerdictEvidence,
} from './types.ts';

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;

const CLAIMS_GAP_DETAIL =
  'state-ledger/1 snapshot carries no claim records (CLAIM posts are not extracted by the ledger), so OPEN CLAIMS cannot be projected';
const EXTRACTION_CAVEAT_DETAIL =
  'verdict and gate mentions are text extractions without a completeness anchor; their counts are lower bounds, so a missing mention cannot be ruled out';

// ---------------------------------------------------------------------------
// Tolerant structural reads. The consumed artifact is a JSON file: it can be
// truncated, hand-edited, or written by another producer, so nothing here
// trusts the declared shape blindly.

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asBool(v: unknown): boolean {
  return v === true;
}

interface Normalized {
  schema: string | null;
  builtAt: string | null;
  room: string | null;
  anchors: Rec | null;
  refs: { name: string; sha: string }[];
  prs: SnapshotPr[];
  decisionsCount: number;
  verdicts: SnapshotVerdict[];
  gates: SnapshotGate[];
  malformed: PartialReason[];
}

function normalizePr(raw: unknown): SnapshotPr | null {
  if (!isRec(raw)) return null;
  const number = asNumber(raw.number);
  if (number === null) return null;
  return {
    number,
    title: asString(raw.title) ?? '',
    state: asString(raw.state) ?? 'UNKNOWN',
    headRefName: asString(raw.headRefName) ?? '',
    headRefOid: asString(raw.headRefOid) ?? '',
    baseRefName: asString(raw.baseRefName) ?? '',
    author: asString(raw.author),
    updatedAt: asString(raw.updatedAt) ?? '',
    url: asString(raw.url) ?? '',
    isDraft: asBool(raw.isDraft),
  };
}

function normalizeVerdict(raw: unknown): SnapshotVerdict | null {
  if (!isRec(raw)) return null;
  const pr = asNumber(raw.pr);
  const verdict = asString(raw.verdict);
  if (pr === null || (verdict !== 'PASS' && verdict !== 'FAIL')) return null;
  return {
    pr,
    verdict,
    messageId: asString(raw.messageId) ?? '',
    actor: asString(raw.actor) ?? '',
    at: asString(raw.at) ?? '',
    sha: asString(raw.sha),
    localCi: asBool(raw.localCi),
    excerpt: asString(raw.excerpt) ?? '',
  };
}

function normalizeGate(raw: unknown): SnapshotGate | null {
  if (!isRec(raw)) return null;
  const kind = asString(raw.kind);
  if (kind !== 'BLOCKED' && kind !== 'HOLD') return null;
  const source = asString(raw.source);
  return {
    kind,
    source: source === 'decisions' ? 'decisions' : 'room',
    ref: asString(raw.ref) ?? '',
    actor: asString(raw.actor),
    at: asString(raw.at),
    pr: asNumber(raw.pr),
    excerpt: asString(raw.excerpt) ?? '',
  };
}

function normalize(input: Rec): Normalized {
  const malformed: PartialReason[] = [];
  const drop = (section: string, raws: unknown[], kept: number) => {
    if (raws.length !== kept) {
      malformed.push({
        code: `malformed-entry:${section}`,
        detail: `${raws.length - kept} of ${raws.length} ${section} entries could not be read and were dropped`,
      });
    }
  };
  const rawRefs = asArray(input.refs);
  const refs = rawRefs
    .map((r) => (isRec(r) ? { name: asString(r.name) ?? '', sha: asString(r.sha) ?? '' } : null))
    .filter((r): r is { name: string; sha: string } => r !== null && r.name !== '');
  drop('refs', rawRefs, refs.length);
  const rawPrs = asArray(input.prs);
  const prs = rawPrs.map(normalizePr).filter((p): p is SnapshotPr => p !== null);
  drop('prs', rawPrs, prs.length);
  const rawVerdicts = asArray(input.verdicts);
  const verdicts = rawVerdicts.map(normalizeVerdict).filter((v): v is SnapshotVerdict => v !== null);
  drop('verdicts', rawVerdicts, verdicts.length);
  const rawGates = asArray(input.gates);
  const gates = rawGates.map(normalizeGate).filter((g): g is SnapshotGate => g !== null);
  drop('gates', rawGates, gates.length);
  return {
    schema: asString(input.schema),
    builtAt: asString(input.builtAt),
    room: asString(input.room),
    anchors: isRec(input.anchors) ? input.anchors : null,
    refs,
    prs,
    decisionsCount: asArray(input.decisions).length,
    verdicts,
    gates,
    malformed,
  };
}

function anchorRec(anchors: Rec | null, key: string): Rec | null {
  const v = anchors?.[key];
  return isRec(v) ? v : null;
}
function anchorNum(anchors: Rec | null, key: string, field: string): number | null {
  const rec = anchorRec(anchors, key);
  return rec ? asNumber(rec[field]) : null;
}
function anchorStr(anchors: Rec | null, key: string, field: string): string | null {
  const rec = anchorRec(anchors, key);
  return rec ? asString(rec[field]) : null;
}

// ---------------------------------------------------------------------------

export function projectBrief(input: unknown, opts: ProjectOptions): CheckinBrief {
  if (!isRec(input)) throw new Error('snapshot must be a JSON object');
  const snap = normalize(input);
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const actor = opts.actor ?? null;

  // -- partial reasons, in a fixed production order -------------------------
  const schemaReasons: PartialReason[] = [];
  if (snap.schema !== 'state-ledger/1') {
    schemaReasons.push({
      code: 'unexpected-schema',
      detail: `expected schema state-ledger/1, found ${snap.schema === null ? '(missing)' : snap.schema}`,
    });
  }
  const missingReasons: PartialReason[] = [];
  const builtAtMs = snap.builtAt ? Date.parse(snap.builtAt) : Number.NaN;
  if (snap.builtAt === null || Number.isNaN(builtAtMs)) {
    missingReasons.push({ code: 'missing-field:builtAt', detail: 'snapshot builtAt is absent or unparseable; age cannot be computed' });
  }
  const roomCount = anchorNum(snap.anchors, 'room', 'messageCount');
  const roomLastAt = anchorStr(snap.anchors, 'room', 'lastMessageAt');
  if (roomCount === null) {
    missingReasons.push({ code: 'missing-field:anchors.room.messageCount', detail: 'room watermark count is absent' });
  } else if (roomCount > 0 && roomLastAt === null) {
    missingReasons.push({ code: 'missing-field:anchors.room.lastMessageAt', detail: 'room has messages but no last-message timestamp anchor' });
  }
  const mismatchReasons: PartialReason[] = [];
  const countCheck = (section: string, anchor: number | null, actual: number) => {
    if (anchor === null) {
      missingReasons.push({ code: `missing-field:anchors.${section}`, detail: `${section} anchor total is absent; omitted count cannot be verified` });
    } else if (anchor !== actual) {
      mismatchReasons.push({
        code: `count-mismatch:${section}`,
        detail:
          anchor > actual
            ? `anchor total ${anchor} vs ${actual} entries present (omitted ${anchor - actual})`
            : `anchor total ${anchor} vs ${actual} entries present (inconsistent snapshot)`,
      });
    }
  };
  countCheck('prs', anchorNum(snap.anchors, 'prs', 'total'), snap.prs.length);
  countCheck('decisions', anchorNum(snap.anchors, 'decisions', 'rows'), snap.decisionsCount);
  countCheck('refs', anchorNum(snap.anchors, 'refs', 'count'), snap.refs.length);

  const ageMs = Number.isNaN(builtAtMs) ? null : Math.max(0, opts.now.getTime() - builtAtMs);
  const staleReasons: PartialReason[] = [];
  if (ageMs !== null && ageMs > staleAfterMs) {
    staleReasons.push({
      code: 'stale-snapshot',
      detail: `snapshot age ${ageMs}ms exceeds the ${staleAfterMs}ms staleness threshold`,
    });
  }
  const partialReasons: PartialReason[] = [
    ...schemaReasons,
    ...missingReasons.sort((a, b) => (a.code < b.code ? -1 : 1)),
    ...snap.malformed,
    ...mismatchReasons,
    ...staleReasons,
    { code: 'claims-not-in-snapshot', detail: CLAIMS_GAP_DETAIL },
    { code: 'extraction-completeness-unverifiable', detail: EXTRACTION_CAVEAT_DETAIL },
  ];

  // -- blocked --------------------------------------------------------------
  const blocked: BlockedItem[] = snap.gates
    .map((g) => ({
      kind: g.kind,
      source: g.source,
      ref: g.ref,
      raisedBy: g.actor,
      at: g.at,
      pr: g.pr,
      excerpt: g.excerpt,
      waitingOn: null,
    }))
    .sort((a, b) => {
      const at = a.at ?? '';
      const bt = b.at ?? '';
      if (at !== bt) return at < bt ? 1 : -1; // newest first, nulls (empty) last
      return a.ref < b.ref ? -1 : 1;
    });

  // -- reviews ---------------------------------------------------------------
  const prByNumber = new Map(snap.prs.map((p) => [p.number, p]));
  const verdictsByPr = new Map<number, SnapshotVerdict[]>();
  for (const v of snap.verdicts) {
    const list = verdictsByPr.get(v.pr) ?? [];
    list.push(v);
    verdictsByPr.set(v.pr, list);
  }
  const refNames = new Set(snap.refs.map((r) => r.name));

  const awaiting: ReviewItem[] = [];
  const unknown: UnknownItem[] = [];
  let satisfiedCount = 0;

  const openPrs = snap.prs.filter((p) => p.state === 'OPEN').sort((a, b) => a.number - b.number);
  for (const pr of openPrs) {
    const vs = [...(verdictsByPr.get(pr.number) ?? [])].sort((a, b) =>
      a.at === b.at ? (a.messageId < b.messageId ? -1 : 1) : a.at < b.at ? -1 : 1,
    );
    const passes = vs.filter((v) => v.verdict === 'PASS');
    const fails = vs.filter((v) => v.verdict === 'FAIL');
    const validPass = passes.some((v) => v.actor !== pr.author && v.sha !== null && v.sha === pr.headRefOid);
    if (validPass) {
      satisfiedCount += 1;
      if (fails.length > 0) {
        unknown.push({
          kind: 'pass-fail-conflict',
          pr: pr.number,
          detail: `PR #${pr.number} has a gate-valid PASS and ${fails.length} FAIL mention(s); both trails are evidence and neither is silently dropped`,
          refs: vs.map((v) => v.messageId),
        });
      }
    } else {
      const flags: string[] = [];
      if (passes.some((v) => v.actor === pr.author)) flags.push('self-pass-not-counted');
      if (passes.some((v) => v.actor !== pr.author && v.sha !== null && v.sha !== pr.headRefOid)) flags.push('stale-pass');
      if (passes.some((v) => v.actor !== pr.author && v.sha === null)) flags.push('unbound-pass');
      const state = vs.length === 0 ? 'no-verdicts' : fails.length > 0 ? 'after-fail' : 'no-valid-pass';
      const evidence: VerdictEvidence[] = vs.map((v) => ({
        verdict: v.verdict,
        actor: v.actor,
        at: v.at,
        sha: v.sha,
        messageId: v.messageId,
        localCi: v.localCi,
      }));
      awaiting.push({
        pr: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author,
        headRefName: pr.headRefName,
        headRefOid: pr.headRefOid,
        updatedAt: pr.updatedAt,
        state,
        flags,
        awaitingMe: actor !== null && pr.author !== actor,
        verdicts: evidence,
      });
    }
    if (!refNames.has(`refs/heads/${pr.headRefName}`)) {
      unknown.push({
        kind: 'head-ref-missing',
        pr: pr.number,
        detail: `PR #${pr.number} is OPEN but refs/heads/${pr.headRefName} is absent from the snapshot refs (branch deleted or snapshot incomplete)`,
        refs: [`refs/heads/${pr.headRefName}`, pr.url],
      });
    }
  }

  // -- orphans ---------------------------------------------------------------
  for (const v of snap.verdicts) {
    if (!prByNumber.has(v.pr)) {
      unknown.push({
        kind: 'orphan-verdict',
        pr: v.pr,
        detail: `verdict mention ${v.messageId} (${v.verdict} by ${v.actor}) references PR #${v.pr}, which is absent from the snapshot PR list`,
        refs: [v.messageId],
      });
    }
  }
  for (const g of snap.gates) {
    if (g.pr !== null && !prByNumber.has(g.pr)) {
      unknown.push({
        kind: 'orphan-gate',
        pr: g.pr,
        detail: `gate ${g.ref} (${g.kind}) references PR #${g.pr}, which is absent from the snapshot PR list`,
        refs: [g.ref],
      });
    }
  }
  unknown.push({ kind: 'extraction-caveat', pr: null, detail: EXTRACTION_CAVEAT_DETAIL, refs: [] });

  return {
    header: {
      room: snap.room,
      builtAt: snap.builtAt,
      ageMs,
      status: partialReasons.length > 0 ? 'PARTIAL' : 'COMPLETE',
      partialReasons,
      watermark: {
        messageCount: roomCount,
        lastMessageId: anchorStr(snap.anchors, 'room', 'lastMessageId'),
        lastMessageAt: roomLastAt,
        mainSha: anchorStr(snap.anchors, 'refs', 'mainSha'),
      },
    },
    claims: { status: 'UNKNOWN', reason: CLAIMS_GAP_DETAIL, items: [] },
    blocked,
    reviews: { awaiting, satisfiedCount },
    unknown,
    summary: {
      openPrs: openPrs.length,
      awaitingReviews: awaiting.length,
      awaitingMe: awaiting.filter((r) => r.awaitingMe).length,
      blocked: blocked.filter((b) => b.kind === 'BLOCKED').length,
      holds: blocked.filter((b) => b.kind === 'HOLD').length,
      conflicts: unknown.filter((u) => u.kind === 'pass-fail-conflict').length,
      satisfied: satisfiedCount,
    },
  };
}

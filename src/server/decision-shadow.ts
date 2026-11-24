// Shadow judgments on the worker request path. The HTTP response is already
// fixed before this runs. DECISION_LIVE_ENABLED stays false, and this caller
// also forces mode shadow and live false, so a verdict is never applied.

import { DECISION_LIVE_ENABLED } from '../decision/config.ts';
import { applyOutcome, decide, type DecisionLedger } from '../decision/decide.ts';
import { DECISIONS_URL } from '../decision/jev-client.ts';
import { CHAT_URL, GENERATION_URL, type FetchLike } from '../decision/llm-fallback.ts';
import { createTolerantJudgmentStore, missingJudgmentsTable } from '../decision/store.ts';
import { budgetCapUsdMicros, openD1Ledger } from './dispatch-wire.ts';
import type { Database, Env } from './db.ts';

export interface ShadowEnv extends Env {
  OPENROUTER_API_KEY?: string;
  BUDGET_CAP_USD_MICROS?: string | number;
}

const CLAIM = /^\/api\/v1\/rooms\/[^/]+\/tasks\/([^/]+)\/claim$/;

export function claimUnitId(url: string, method: string): string | null {
  if (method !== 'POST') return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const match = CLAIM.exec(parsed.pathname);
  if (!match?.[1]) return null;
  try {
    const unit = decodeURIComponent(match[1]);
    return unit.length > 0 && unit.length <= 128 && !unit.includes('/') ? unit : null;
  } catch {
    return null;
  }
}

export function openRouterFetch(base: FetchLike): FetchLike {
  return async (input, init) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const allowed = target === DECISIONS_URL || target === CHAT_URL || target.startsWith(`${GENERATION_URL}?id=`);
    if (!allowed) throw new Error('outbound url is not an OpenRouter decision endpoint');
    return base(input, init);
  };
}

function capOf(env: ShadowEnv): number {
  return budgetCapUsdMicros(env);
}

function decisionLedger(db: Database, cap: number): DecisionLedger {
  const inner = openD1Ledger(db, 'shadow:decision', cap);
  return {
    assertReservation: binding => inner.assertReservation(binding),
    async reserve(input) {
      const result = await inner.reserve(input);
      if (result.ok) return result;
      return { ok: false, reason: 'over_budget', remaining: result.remaining };
    },
    markPending: (id, reason, extra) => inner.markPending(id, reason, extra),
    settle: (id, actual) => inner.settle(id, actual),
    closeNoCharge: (id, evidence) => inner.closeNoCharge(id, evidence),
  };
}

async function ledgerOrNone(db: Database, cap: number): Promise<DecisionLedger | undefined> {
  try {
    await db.prepare('SELECT 1 FROM budget_reservations LIMIT 0').all();
    return decisionLedger(db, cap);
  } catch (error) {
    if (missingJudgmentsTable(error)) return undefined;
    throw error;
  }
}

/** Records one t2 shadow judgment. The returned verdict is not an instruction to the caller. */
export async function shadowClaim(env: ShadowEnv, unitId: string, fetchImpl: FetchLike = fetch): Promise<{ applied: false; verdict: string }> {
  if (DECISION_LIVE_ENABLED) throw new Error('decision live flag is not shadow');
  const result = await decide({
    point: 't2.rebalance',
    unit_id: unitId,
    state: { task: unitId },
    candidates: [],
    mode: 'shadow',
    config: { live: false },
    apiKey: env.OPENROUTER_API_KEY,
    fetchImpl: openRouterFetch(fetchImpl),
    ledger: await ledgerOrNone(env.DB, capOf(env)),
    store: createTolerantJudgmentStore(env.DB),
    recordId: `jdg_${crypto.randomUUID()}`,
  });
  const view = applyOutcome({ claimed: true }, result);
  if (view.applied || result.applied) throw new Error('shadow judgment was applied');
  return { applied: false, verdict: result.verdict };
}

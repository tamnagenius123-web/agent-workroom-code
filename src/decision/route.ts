// Pre-call routing by estimated request size. This is not a failure fallback.
// Under d1.2-ultra's context (minus the safety margin) the call goes to d1.
// Over that, and still inside Jev 1.14's context, the call goes to Jev.
// Over both, no decision model is called.

import { canonicalJson } from './sweep.ts';
import type { DecisionConfig } from './config.ts';
import { DecisionInputError } from './errors.ts';

export type SizeRoute = 'd1' | 'jev' | 'none';

export type RoutingReason = 'within_d1_ultra' | 'size_over_d1_ultra' | 'size_over_both';

/**
 * Conservative token estimate for state plus questions.
 * Uses the same chars/3 rule as the OpenRouter harness prompt estimate, plus a small constant.
 */
export function estimateDecisionTokens(state: unknown, questions: unknown): number {
  const chars = canonicalJson({ questions, state }).length;
  const tokens = Math.ceil(chars / 3) + 16;
  if (!Number.isSafeInteger(tokens)) {
    throw new DecisionInputError('threshold', 'token estimate overflowed');
  }
  return tokens;
}

export function routeBySize(tokens: number, config: DecisionConfig): { route: SizeRoute; reason: RoutingReason } {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new DecisionInputError('threshold', 'token estimate must be a non-negative integer');
  }
  const margin = config.safetyMarginTokens;
  if (!Number.isSafeInteger(margin) || margin < 0) {
    throw new DecisionInputError('threshold', 'safetyMarginTokens must be a non-negative integer');
  }
  if (tokens + margin <= config.primary.contextTokens) return { route: 'd1', reason: 'within_d1_ultra' };
  if (tokens + margin <= config.largeContext.contextTokens) return { route: 'jev', reason: 'size_over_d1_ultra' };
  return { route: 'none', reason: 'size_over_both' };
}

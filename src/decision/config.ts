// Live application is off. Shadow records a judgment and does not change current flows.
// The primary decision model and the context limits live here. decide() reads this
// registry and does not pin a model of its own.
// Spend shares the OpenRouter ledger (DEC-3). There is no separate decision-model budget.

export interface DecisionModelSpec {
  requestModel: string;
  /** Served ids must equal this or add a build suffix. `latest` aliases are rejected. */
  servedPrefix: string;
  /** Jev answers with a dated build id, so the prefix alone is not enough. */
  requireSuffix: boolean;
  contextTokens: number;
  /** USD per million input tokens, when the price is published. */
  usdPerMillionInput?: number;
  /** Omit when the provider pin is not known. Jev is TypeSafe. */
  providerOnly?: readonly string[];
}

export interface DecisionConfig {
  live: boolean;
  /** Route before the estimate reaches the published context limit. */
  safetyMarginTokens: number;
  primary: DecisionModelSpec;
  largeContext: DecisionModelSpec;
}

export const DECISION_LIVE_ENABLED = false;

/** Liquid d1.2-ultra. Do not send `~liquid/...-latest`. */
export const D1_ULTRA_REQUEST_MODEL = 'liquid/d1.2-ultra';
export const D1_ULTRA_SERVED_PREFIX = 'liquid/d1.2-ultra';
export const D1_ULTRA_CONTEXT_TOKENS = 65_536;
export const D1_ULTRA_USD_PER_MILLION_INPUT = 0.042;

export const JEV_REQUEST_MODEL = 'typesafe/jev-1.14';
export const JEV_SERVED_PREFIX = 'typesafe/jev-1.14-';
export const JEV_CONTEXT_TOKENS = 262_144;

export const DEFAULT_SAFETY_MARGIN_TOKENS = 2_048;

const PRIMARY: DecisionModelSpec = {
  requestModel: D1_ULTRA_REQUEST_MODEL,
  servedPrefix: D1_ULTRA_SERVED_PREFIX,
  requireSuffix: false,
  contextTokens: D1_ULTRA_CONTEXT_TOKENS,
  usdPerMillionInput: D1_ULTRA_USD_PER_MILLION_INPUT,
};

const LARGE_CONTEXT: DecisionModelSpec = {
  requestModel: JEV_REQUEST_MODEL,
  servedPrefix: JEV_SERVED_PREFIX,
  requireSuffix: true,
  contextTokens: JEV_CONTEXT_TOKENS,
  providerOnly: ['TypeSafe'],
};

export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  live: DECISION_LIVE_ENABLED,
  safetyMarginTokens: DEFAULT_SAFETY_MARGIN_TOKENS,
  primary: PRIMARY,
  largeContext: LARGE_CONTEXT,
};

export type DecisionConfigOverride = {
  live?: boolean;
  safetyMarginTokens?: number;
  primary?: Partial<DecisionModelSpec>;
  largeContext?: Partial<DecisionModelSpec>;
};

export function resolveDecisionConfig(override?: DecisionConfigOverride): DecisionConfig {
  return {
    live: override?.live ?? DEFAULT_DECISION_CONFIG.live,
    safetyMarginTokens: override?.safetyMarginTokens ?? DEFAULT_DECISION_CONFIG.safetyMarginTokens,
    primary: { ...PRIMARY, ...override?.primary },
    largeContext: { ...LARGE_CONTEXT, ...override?.largeContext },
  };
}

/** Existing roster general worker. Not a decision model. */
export const LLM_FALLBACK_MODEL = 'z-ai/glm-5.3';

/** Ledger project key in config/models.openrouter.json. */
export const DECISION_LEDGER_PROJECT = 'test';

/**
 * Provisional hold for Jev size-routing. Jev has no published per-token card here.
 * TODO: replace with a roster price. 50_000 micro-USD is US$0.05.
 * d1.2-ultra uses D1_ULTRA_USD_PER_MILLION_INPUT instead.
 */
export const JEV_RESERVE_MICRO_USD = 50_000;

/** micro-USD for `tokens` at a published USD-per-million-input price. */
export function inputReserveMicro(tokens: number, usdPerMillion: number): number {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new Error('token estimate is not a non-negative integer');
  }
  if (!Number.isFinite(usdPerMillion) || usdPerMillion < 0) {
    throw new Error('input price is not a non-negative finite number');
  }
  const micro = Math.ceil(usdPerMillion * tokens);
  if (!Number.isSafeInteger(micro)) throw new Error('reserve micro-USD overflowed');
  return Math.max(micro, 1);
}

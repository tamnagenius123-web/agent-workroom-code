// P3 research applicability (K3.1, EDV, C5). Pure: no clock, I/O, network, or DB.
// DeepResearch is required only when dispatched. Deterministic tasks take not_applicable
// with a reason. R(t) is never a reward or a task selector.

export const APPLICABILITY = ['required', 'not_applicable'] as const;
export type Applicability = (typeof APPLICABILITY)[number];

/** INORI work-unit EDV band. UNKNOWN is not a dispatchable band. */
export const EDV_BANDS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type EdvBand = (typeof EDV_BANDS)[number];

/** INORI frontier routing classes. UNASSESSED is not a dispatch class. */
export const FRONTIER_CLASSES = [
  'CONSUME_FIRST',
  'READY_TO_ADJUDICATE',
  'ONE_DISCRIMINATOR_AWAY',
  'CONTRADICTORY',
  'EVIDENCE_POOR',
  'ACTIVE_SEARCH',
  'HUMAN_GATE',
  'BLOCKED',
] as const;
export type FrontierClass = (typeof FRONTIER_CLASSES)[number];

export type ResearchCheck<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface ResearchRequired {
  applicability: 'required';
  consumer: string;
  hypothesis: string;
  discriminator: string;
  edvBand: EdvBand;
  frontierClass: FrontierClass;
}

export interface ResearchNotApplicable {
  applicability: 'not_applicable';
  reason: string;
}

export type ResearchApplicability = ResearchRequired | ResearchNotApplicable;

const TEXT_MAX = 4000;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const REQUIRED_KEYS = [
  'applicability', 'consumer', 'hypothesis', 'discriminator', 'edvBand', 'frontierClass',
] as const;
const NA_KEYS = ['applicability', 'reason'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function includesConst<T extends string>(allowed: readonly T[], value: string): value is T {
  return (allowed as readonly string[]).includes(value);
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-]/g, '');
}

/** Reward, selector, or R(t) used as either. Nested keys are scanned. */
function isRtDerivedField(key: string): boolean {
  const raw = key.trim();
  if (raw === 'R(t)' || raw === 'r(t)') return true;
  const n = normalizeKey(raw);
  if (n === 'reward' || n === 'selector' || n === 'rt' || n === 'r(t)') return true;
  const fromRt = n.includes('rt') || n.includes('r(t)');
  return fromRt && (n.includes('reward') || n.includes('selector'));
}

function collectRtFields(value: unknown, path: string, into: string[]): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectRtFields(item, `${path}[${index}]`, into));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const here = path === '' ? key : `${path}.${key}`;
    if (isRtDerivedField(key)) into.push(here);
    collectRtFields(child, here, into);
  }
}

function readText(obj: Record<string, unknown>, key: string, errors: string[]): string | undefined {
  const value = obj[key];
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) {
    errors.push(`${key}: expected non-empty text up to ${TEXT_MAX} characters`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || [...value].length > TEXT_MAX) {
    errors.push(`${key}: expected non-empty text up to ${TEXT_MAX} characters`);
    return undefined;
  }
  return value;
}

function readEnum<T extends string>(
  obj: Record<string, unknown>, key: string, allowed: readonly T[], errors: string[],
): T | undefined {
  const value = obj[key];
  if (typeof value !== 'string' || !includesConst(allowed, value)) {
    errors.push(`${key}: expected one of ${allowed.join('|')}`);
    return undefined;
  }
  return value;
}

function readConsumer(obj: Record<string, unknown>, errors: string[]): string | undefined {
  const value = obj.consumer;
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    errors.push('consumer: named consumer (C5) required for dispatched actions');
    return undefined;
  }
  return value;
}

function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], errors: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key) && !isRtDerivedField(key)) {
      errors.push(`unknown field ${JSON.stringify(key)}`);
    }
  }
}

/**
 * Task-contract check for research applicability.
 * `required` is a dispatched research action: named consumer plus EDV fields.
 * `not_applicable` is the deterministic path: a non-blank reason and no EDV fields.
 */
export function checkResearchApplicability(input: unknown): ResearchCheck<ResearchApplicability> {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ['expected an object'] };
  }

  const rtFields: string[] = [];
  collectRtFields(input, '', rtFields);
  for (const path of rtFields) {
    errors.push(`${path}: R(t) is never a reward or selector`);
  }

  const applicability = input.applicability;
  if (applicability !== 'required' && applicability !== 'not_applicable') {
    errors.push('applicability: expected required|not_applicable');
    return { ok: false, errors };
  }

  if (applicability === 'not_applicable') {
    checkKeys(input, NA_KEYS, errors);
    const reason = readText(input, 'reason', errors);
    if (errors.length > 0 || reason === undefined) return { ok: false, errors };
    return { ok: true, value: { applicability, reason } };
  }

  checkKeys(input, REQUIRED_KEYS, errors);
  const consumer = readConsumer(input, errors);
  const hypothesis = readText(input, 'hypothesis', errors);
  const discriminator = readText(input, 'discriminator', errors);
  const edvBand = readEnum(input, 'edvBand', EDV_BANDS, errors);
  const frontierClass = readEnum(input, 'frontierClass', FRONTIER_CLASSES, errors);
  if (
    errors.length > 0
    || consumer === undefined
    || hypothesis === undefined
    || discriminator === undefined
    || edvBand === undefined
    || frontierClass === undefined
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: { applicability, consumer, hypothesis, discriminator, edvBand, frontierClass },
  };
}

// P5 budget selector on the freshness manifest shape.
// Mandatory corrections and mandatory evidence are reserved together. They do not
// compete with optional items or with each other, and they are never dropped or
// truncated. If their render does not fit, the build fails.
// Optional items are copied whole or omitted. token_cost is recorded only.
// token_count is the injected counter on the final rendered string.
// Freshness is recorded as given. Proceed and freshness validation stay in freshness.ts.

import {
  Problems, checkKeys, defined, readBool, readEnum, readId, readInt, readObject, readText,
  type PhaseCheck,
} from './check.ts';
import {
  COVERAGE_LEVELS, SOURCE_STATUSES,
  type CoverageLevel, type FreshnessManifestEntry, type SourceStatus,
} from './freshness.ts';

/** Counts tokens of a rendered context string. This module does not ship a tokenizer. */
export type TokenCounter = (rendered: string) => number;

export type OmissionReason = 'over_budget';

export interface ContextCandidate {
  id: string;
  /** Durable source identity. Same id space as FreshnessManifestEntry.source_id. */
  source_id: string;
  /** Pinned revision of that source. A freshness-manifest id, not a bare integer. */
  revision: string;
  /** Scope the source was selected under (room, task, or other bound). */
  scope: string;
  /** Source representation text, recorded as given. Not a Tencent L0–L3 lifecycle stage. */
  representation: string;
  freshness: SourceStatus;
  /**
   * Coverage offered by this representation.
   * `body` and `partial` carry text. `pointer_only` and `none` are empty.
   * A pointer is not body exposure.
   */
  coverage: CoverageLevel;
  /** Body to emit whole, or empty for a pointer or for coverage none. Never sliced to fit. */
  text: string;
  /** Declared cost. Stored on the entry. The budget uses countTokens(rendered). */
  token_cost: number;
  /** Outside the drop competition. An over-budget mandatory set is an error. */
  mandatory: boolean;
  /** Correction to earlier context. Mandatory corrections are reserved with mandatory evidence. */
  correction: boolean;
}

/** Freshness overlap fields keep the FreshnessManifestEntry shape. Selection state is the budget delta. */
export interface ContextBudgetEntry extends FreshnessManifestEntry {
  id: string;
  scope: string;
  mandatory: boolean;
  correction: boolean;
  token_cost: number;
  /** False when the candidate lost the optional-item competition. */
  selected: boolean;
  omission_reason?: OmissionReason;
}

export interface ContextBudget {
  budget: number;
  /** countTokens(rendered) for the selected render. Not the sum of token_cost. */
  token_count: number;
  rendered: string;
  entries: ContextBudgetEntry[];
}

const TEXT_MAX = 32768;
const SCOPE_MAX = 200;
/** Same length bound the freshness manifest uses for representation text. */
const REPRESENTATION_MAX = 300;
const SEPARATOR = '\n---\n';
const CANDIDATE_KEYS = [
  'id', 'source_id', 'revision', 'scope', 'representation', 'freshness', 'coverage',
  'text', 'token_cost', 'mandatory', 'correction',
] as const;

function isTokenCounter(value: unknown): value is TokenCounter {
  return typeof value === 'function';
}

function readLineText(
  problems: Problems, obj: Record<string, unknown>, key: string, path: string, max: number,
): string | undefined {
  const value = readText(problems, obj, key, path, max);
  if (!defined(value)) return undefined;
  if (value.includes('\n') || value.includes('\r') || !value.isWellFormed()) {
    problems.add(`${path}.${key}`, 'expected single-line text');
    return undefined;
  }
  return value;
}

function readBody(problems: Problems, obj: Record<string, unknown>, path: string): string | undefined {
  const value = obj.text;
  if (typeof value !== 'string' || value.length > TEXT_MAX || value.includes('\0') || !value.isWellFormed()) {
    problems.add(`${path}.text`, `expected text up to ${TEXT_MAX} characters`);
    return undefined;
  }
  return value;
}

function readCandidate(problems: Problems, row: Record<string, unknown>, path: string): ContextCandidate | undefined {
  const id = readId(problems, row, 'id', path);
  const source_id = readId(problems, row, 'source_id', path);
  const revision = readId(problems, row, 'revision', path);
  const scope = readLineText(problems, row, 'scope', path, SCOPE_MAX);
  const representation = readLineText(problems, row, 'representation', path, REPRESENTATION_MAX);
  const freshness = readEnum(problems, row, 'freshness', path, SOURCE_STATUSES);
  const coverage = readEnum(problems, row, 'coverage', path, COVERAGE_LEVELS);
  const text = readBody(problems, row, path);
  const token_cost = readInt(problems, row, 'token_cost', path, 0);
  const mandatory = readBool(problems, row, 'mandatory', path);
  const correction = readBool(problems, row, 'correction', path);
  let coverageMatches = true;
  if (defined(coverage) && defined(text)) {
    const body = coverage === 'body' || coverage === 'partial';
    if (body === (text.length === 0)) {
      coverageMatches = false;
      problems.add(
        `${path}.coverage`,
        body ? `coverage ${coverage} requires text` : `coverage ${coverage} requires empty text`,
      );
    }
  }
  if (!defined(id) || !defined(source_id) || !defined(revision) || !defined(scope) || !defined(representation)
    || !defined(freshness) || !defined(coverage) || !defined(text) || !defined(token_cost)
    || !defined(mandatory) || !defined(correction) || !coverageMatches) {
    return undefined;
  }
  return {
    id, source_id, revision, scope, representation, freshness, coverage, text, token_cost, mandatory, correction,
  };
}

function readCandidates(problems: Problems, items: unknown): ContextCandidate[] | undefined {
  if (!Array.isArray(items)) {
    problems.add('context_budget.items', 'expected an array');
    return undefined;
  }
  const candidates: ContextCandidate[] = [];
  const seen = new Set<string>();
  let ok = true;
  for (let i = 0; i < items.length; i += 1) {
    const path = `context_budget.items[${i}]`;
    const row = readObject(problems, items[i], path);
    if (!row) {
      ok = false;
      continue;
    }
    const before = problems.errors.length;
    checkKeys(problems, row, CANDIDATE_KEYS, path);
    const candidate = readCandidate(problems, row, path);
    if (defined(candidate)) {
      if (seen.has(candidate.id)) {
        problems.add(path, `duplicate item id ${candidate.id}`);
      } else {
        seen.add(candidate.id);
      }
    }
    if (!defined(candidate) || problems.errors.length !== before) {
      ok = false;
      continue;
    }
    candidates.push(candidate);
  }
  return ok ? candidates : undefined;
}

function measure(problems: Problems, rendered: string, countTokens: TokenCounter): number | undefined {
  const count = countTokens(rendered);
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    problems.add('context_budget.count_tokens', 'expected an integer >= 0');
    return undefined;
  }
  return count;
}

function emittedLabel(item: ContextCandidate): string {
  if (item.text.length > 0) return 'emitted: body';
  if (item.coverage === 'pointer_only') return 'emitted: pointer';
  return 'emitted: none';
}

function renderCandidate(item: ContextCandidate): string {
  const lines = [
    `id: ${item.id}`,
    `source_id: ${item.source_id}`,
    `revision: ${item.revision}`,
    `scope: ${item.scope}`,
    `representation: ${item.representation}`,
    `freshness: ${item.freshness}`,
    `coverage: ${item.coverage}`,
    `role: ${item.correction ? 'correction' : 'evidence'}`,
    `mandatory: ${item.mandatory ? 'true' : 'false'}`,
    emittedLabel(item),
  ];
  if (item.text.length > 0) lines.push(item.text);
  return lines.join('\n');
}

/** Render selected candidates. Framing and separators are part of the counted string. */
export function renderContext(items: readonly ContextCandidate[]): string {
  return items.map(renderCandidate).join(SEPARATOR);
}

function toEntry(item: ContextCandidate, selected: boolean): ContextBudgetEntry {
  const entry: ContextBudgetEntry = {
    id: item.id,
    source_id: item.source_id,
    revision: item.revision,
    scope: item.scope,
    representation: item.representation,
    actually_emitted: selected && item.text.length > 0,
    freshness: item.freshness,
    coverage: item.coverage,
    mandatory: item.mandatory,
    correction: item.correction,
    token_cost: item.token_cost,
    selected,
  };
  if (!selected) entry.omission_reason = 'over_budget';
  return entry;
}

/**
 * Select candidates under budget. Mandatory items are all kept, in input order,
 * or the call returns MANDATORY_EXCEEDS_BUDGET. Optional items then compete in
 * input order and are kept only when the full rendered string still fits.
 * Nothing is truncated. token_count is countTokens of that rendered string.
 */
export function buildContextBudget(items: unknown, budget: unknown, countTokens: unknown): PhaseCheck<ContextBudget> {
  const problems = new Problems();
  const candidates = readCandidates(problems, items);
  const parsedBudget = readInt(problems, { budget }, 'budget', 'context_budget', 0);
  if (!isTokenCounter(countTokens)) problems.add('context_budget.count_tokens', 'expected a function');
  if (!defined(candidates) || !defined(parsedBudget) || !isTokenCounter(countTokens)) return problems.fail();

  const mandatory = candidates.filter(item => item.mandatory);
  const optional = candidates.filter(item => !item.mandatory);
  let selected = mandatory;
  let rendered = renderContext(selected);
  let tokenCount = measure(problems, rendered, countTokens);
  if (!defined(tokenCount)) return problems.fail();
  if (tokenCount > parsedBudget) {
    problems.add(
      'context_budget.mandatory',
      `MANDATORY_EXCEEDS_BUDGET: mandatory items render to ${tokenCount} tokens, over the budget of ${parsedBudget}. Mandatory corrections and evidence are not dropped or truncated.`,
    );
    return problems.fail();
  }

  const omitted: ContextCandidate[] = [];
  for (const item of optional) {
    const trialSelected = [...selected, item];
    const trialRendered = renderContext(trialSelected);
    const trialTokens = measure(problems, trialRendered, countTokens);
    if (!defined(trialTokens)) return problems.fail();
    if (trialTokens > parsedBudget) {
      omitted.push(item);
      continue;
    }
    selected = trialSelected;
    rendered = trialRendered;
    tokenCount = trialTokens;
  }

  return {
    ok: true,
    value: {
      budget: parsedBudget,
      token_count: tokenCount,
      rendered,
      entries: [...selected.map(item => toEntry(item, true)), ...omitted.map(item => toEntry(item, false))],
    },
  };
}

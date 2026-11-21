// OpenRouter Decisions client. One POST, no retry, and no switch to another decision model.
// The request model is chosen by decide() (d1.2-ultra, or Jev when the estimate does not fit).
//
// Jev 1.14 response fields were live-checked on 2026-11-17. Liquid d1.2-ultra's answer
// fields are NOT live-verified: confidence, legend, and probabilities are optional, and
// unknown keys are ignored rather than treated as a failed call.
// TODO: pin d1.2-ultra's noul/choice/score/box fields once a live sample exists.
// TODO: session_id / trace max length 256 is from the OpenAPI page, not restated in the Jev sample.
// TODO: score `legend` values are typed as strings when present.
// TODO: box criteria are omitted. Box answers are parsed and not used.
// TODO: usage.input_tokens_details inner keys were not pinned. The value is ignored.

import { Buffer } from 'node:buffer';
import { z } from 'zod';

export const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const JEV_REQUEST_MODEL = 'typesafe/jev-1.14';
export const JEV_SERVED_PREFIX = 'typesafe/jev-1.14-';
export const DECIDER_SHADOW_MODEL = 'perplexity/pplx-decider-v1.2';
export const JEV_TIMEOUT_MS = 30_000;

/** Observed build id on 2026-11-17. Not pinned; any suffix after the prefix is accepted. */
export const JEV_SERVED_EXAMPLE = 'typesafe/jev-1.14-20261014';

export const FORBIDDEN_DECISION_MODELS = [
  'typesafe/jev-router',
  '~typesafe/jev-latest',
  'typesafe/jev-latest',
  '~liquid/d1.2-ultra-latest',
  'liquid/d1.2-ultra-latest',
  DECIDER_SHADOW_MODEL,
] as const;

export const JEV_PROVIDER = { only: ['TypeSafe'] } as const;

export const IMAGE_MIN_SIDE = 256;
export const IMAGE_MAX_SIDE = 1568;
export const IMAGE_MIN_PIXELS = 78_400;

const OBS_MAX = 256;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type JevErrorClass =
  | 'timeout'
  | 'transport'
  | 'http_status'
  | 'bad_response'
  | 'forbidden_model'
  | 'missing_api_key'
  | 'missing_fetch'
  | 'image_rejected'
  | 'bad_request';

export class JevClientError extends Error {
  readonly errorClass: JevErrorClass;
  readonly status: number | null;
  readonly apiCode: string | number | null;
  /** Always false: this client does not retry, and it does not switch decision model. */
  readonly retryable = false;
  readonly generationId: string | null;
  readonly costUsd: number | null;
  readonly servedModel: string | null;
  readonly servedProvider: string | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;

  constructor(errorClass: JevErrorClass, message: string, fields?: {
    status?: number | null;
    apiCode?: string | number | null;
    generationId?: string | null;
    costUsd?: number | null;
    servedModel?: string | null;
    servedProvider?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
  }) {
    super(message);
    this.name = 'JevClientError';
    this.errorClass = errorClass;
    this.status = fields?.status ?? null;
    this.apiCode = fields?.apiCode ?? null;
    this.generationId = fields?.generationId ?? null;
    this.costUsd = fields?.costUsd ?? null;
    this.servedModel = fields?.servedModel ?? null;
    this.servedProvider = fields?.servedProvider ?? null;
    this.promptTokens = fields?.promptTokens ?? null;
    this.completionTokens = fields?.completionTokens ?? null;
  }
}

export interface ImageUrlPart {
  type: 'image_url';
  image_url: { url: string };
}

export type DecisionState = string | { readonly [key: string]: unknown } | readonly unknown[];

export type DecisionQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: readonly string[] }
  | { type: 'box'; instructions: string };

export interface DecisionTrace {
  trace_id: string;
  trace_name: string;
}

export interface DecisionsUsage {
  input_tokens?: number;
  output_tokens?: number;
  cost: number;
  is_byok?: boolean;
  cost_details?: {
    upstream_inference_cost?: number;
    upstream_inference_prompt_cost?: number;
    upstream_inference_completions_cost?: number;
  };
  /** Present on some responses. Not read. */
  input_tokens_details?: unknown;
}

export type DecisionAnswer =
  | { type: 'noul'; noul: number; confidence?: number }
  | { type: 'choice'; choice: string; probabilities?: Record<string, number>; confidence?: number }
  | { type: 'score'; score: number; legend?: Record<string, string>; probabilities?: Record<string, number>; confidence?: number }
  | { type: 'box'; box: { top: number; bottom: number; left: number; right: number }; confidence?: number };

export interface DecisionsResponse {
  id: string;
  model: string;
  provider: string;
  answers: Record<string, DecisionAnswer>;
  usage: DecisionsUsage;
}

export interface BuiltDecisionRequest {
  payload: string;
}

const finiteUnit = z.number().refine(value => Number.isFinite(value) && value >= 0 && value <= 1, 'probability out of range');
const tokenCount = z.number().refine(value => Number.isSafeInteger(value) && value >= 0, 'bad token count');
const usd = z.number().refine(value => Number.isFinite(value) && value >= 0, 'bad cost');

const optionalUnit = finiteUnit.optional();

const noulAnswerSchema = z.object({
  type: z.literal('noul'),
  noul: finiteUnit,
  confidence: optionalUnit,
});

const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string().min(1),
  probabilities: z.record(z.string(), finiteUnit).optional(),
  confidence: optionalUnit,
});

const scoreAnswerSchema = z.object({
  type: z.literal('score'),
  score: z.number().refine(value => Number.isFinite(value), 'bad score'),
  legend: z.record(z.string(), z.string()).optional(),
  probabilities: z.record(z.string(), finiteUnit).optional(),
  confidence: optionalUnit,
});

const boxAnswerSchema = z.object({
  type: z.literal('box'),
  box: z.object({
    top: z.number().refine(value => Number.isFinite(value), 'bad box'),
    bottom: z.number().refine(value => Number.isFinite(value), 'bad box'),
    left: z.number().refine(value => Number.isFinite(value), 'bad box'),
    right: z.number().refine(value => Number.isFinite(value), 'bad box'),
  }),
  confidence: optionalUnit,
});

const usageSchema = z.object({
  input_tokens: tokenCount.optional(),
  output_tokens: tokenCount.optional(),
  cost: usd,
  is_byok: z.boolean().optional(),
  cost_details: z.object({
    upstream_inference_cost: usd.optional(),
    upstream_inference_prompt_cost: usd.optional(),
    upstream_inference_completions_cost: usd.optional(),
  }).optional(),
  input_tokens_details: z.unknown().nullish(),
});

const responseSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().min(1),
  answers: z.record(z.string(), z.union([noulAnswerSchema, choiceAnswerSchema, scoreAnswerSchema, boxAnswerSchema])),
  usage: usageSchema,
});

export function isServedModel(model: string, spec: { servedPrefix: string; requireSuffix: boolean }): boolean {
  if (model.startsWith('~') || model.includes('latest')) return false;
  if (spec.requireSuffix) return model.startsWith(spec.servedPrefix) && model.length > spec.servedPrefix.length;
  return model === spec.servedPrefix || model.startsWith(`${spec.servedPrefix}-`);
}

export function isServedJevModel(model: string): boolean {
  return isServedModel(model, { servedPrefix: JEV_SERVED_PREFIX, requireSuffix: true });
}

export function isServedD1Ultra(model: string): boolean {
  return isServedModel(model, { servedPrefix: 'liquid/d1.2-ultra', requireSuffix: false });
}

export function imageWithinBounds(width: number, height: number): boolean {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return false;
  if (width < IMAGE_MIN_SIDE || height < IMAGE_MIN_SIDE) return false;
  if (width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE) return false;
  const pixels = width * height;
  return Number.isSafeInteger(pixels) && pixels >= IMAGE_MIN_PIXELS;
}

export function assertPinnedRequestModel(model: string): void {
  if (model.startsWith('~') || model.includes('latest') || model === 'typesafe/jev-router') {
    throw new JevClientError('bad_request', 'decision model alias is not allowed');
  }
}

export function buildDecisionsRequest(input: {
  model: string;
  state: unknown;
  questions: Readonly<Record<string, DecisionQuestion>>;
  session_id?: string;
  trace?: DecisionTrace;
  providerOnly?: readonly string[];
}): BuiltDecisionRequest {
  assertPinnedRequestModel(input.model);
  assertState(input.state);
  const questions = compileQuestions(input.questions);
  const wire: Record<string, unknown> = {
    model: input.model,
    state: input.state,
    questions,
  };
  if (input.session_id !== undefined) {
    checkObs(input.session_id, 'session_id');
    wire.session_id = input.session_id;
  }
  if (input.trace !== undefined) {
    checkObs(input.trace.trace_id, 'trace_id');
    checkObs(input.trace.trace_name, 'trace_name');
    wire.trace = { trace_id: input.trace.trace_id, trace_name: input.trace.trace_name };
  }
  if (input.providerOnly && input.providerOnly.length > 0) {
    wire.provider = { only: [...input.providerOnly] };
  }
  return { payload: JSON.stringify(wire) };
}

export function buildJevRequest(input: {
  state: unknown;
  questions: Readonly<Record<string, DecisionQuestion>>;
  session_id?: string;
  trace?: DecisionTrace;
}): BuiltDecisionRequest {
  return buildDecisionsRequest({ ...input, model: JEV_REQUEST_MODEL, providerOnly: JEV_PROVIDER.only });
}

/** Shadow comparison only. Noul and choice. No TypeSafe provider pin, and the answer is not a verdict. */
export function buildDeciderShadowRequest(input: {
  state: unknown;
  questions: Readonly<Record<string, DecisionQuestion>>;
  session_id?: string;
  trace?: DecisionTrace;
}): BuiltDecisionRequest {
  for (const question of Object.values(input.questions)) {
    if (question.type !== 'noul' && question.type !== 'choice') {
      throw new JevClientError('bad_request', 'decider shadow accepts only noul and choice');
    }
  }
  assertState(input.state);
  const questions = compileQuestions(input.questions);
  const wire: Record<string, unknown> = {
    model: DECIDER_SHADOW_MODEL,
    state: input.state,
    questions,
  };
  if (input.session_id !== undefined) {
    checkObs(input.session_id, 'session_id');
    wire.session_id = input.session_id;
  }
  if (input.trace !== undefined) {
    checkObs(input.trace.trace_id, 'trace_id');
    checkObs(input.trace.trace_name, 'trace_name');
    wire.trace = { trace_id: input.trace.trace_id, trace_name: input.trace.trace_name };
  }
  return { payload: JSON.stringify(wire) };
}
export async function postDecision(input: {
  model: string;
  servedPrefix: string;
  requireSuffix: boolean;
  providerOnly?: readonly string[];
  expectProvider?: string;
  state: unknown;
  questions: Readonly<Record<string, DecisionQuestion>>;
  session_id?: string;
  trace?: DecisionTrace;
  apiKey: string;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  logger?: (payload: string) => void;
}): Promise<{ response: DecisionsResponse; payload: string }> {
  const built = buildDecisionsRequest(input);
  const response = await postDecisions(built.payload, input);
  const servedOk = isServedModel(response.model, input);
  const providerOk = input.expectProvider === undefined || response.provider === input.expectProvider;
  if (!servedOk || !providerOk) {
    throw new JevClientError('forbidden_model', 'served model does not match the requested decision model', {
      status: 200,
      generationId: response.id,
      costUsd: response.usage.cost,
      servedModel: response.model,
      servedProvider: response.provider,
      promptTokens: response.usage.input_tokens ?? null,
      completionTokens: response.usage.output_tokens ?? null,
    });
  }
  return { response, payload: built.payload };
}

export async function postJevDecision(input: {
  state: unknown;
  questions: Readonly<Record<string, DecisionQuestion>>;
  session_id?: string;
  trace?: DecisionTrace;
  apiKey: string;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  logger?: (payload: string) => void;
}): Promise<{ response: DecisionsResponse; payload: string }> {
  return postDecision({
    ...input,
    model: JEV_REQUEST_MODEL,
    servedPrefix: JEV_SERVED_PREFIX,
    requireSuffix: true,
    providerOnly: JEV_PROVIDER.only,
    expectProvider: 'TypeSafe',
  });
}

export async function postDeciderShadow(input: {
  state: unknown;
  questions: Readonly<Record<string, DecisionQuestion>>;
  session_id?: string;
  trace?: DecisionTrace;
  apiKey: string;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  logger?: (payload: string) => void;
}): Promise<{ response: DecisionsResponse; payload: string }> {
  const built = buildDeciderShadowRequest(input);
  const response = await postDecisions(built.payload, input);
  return { response, payload: built.payload };
}

async function postDecisions(payload: string, input: {
  apiKey: string;
  fetchImpl: FetchLike | undefined;
  timeoutMs?: number;
  logger?: (payload: string) => void;
}): Promise<DecisionsResponse> {
  const key = usableKey(input.apiKey);
  if (!key) throw new JevClientError('missing_api_key', 'missing api key');
  if (!input.fetchImpl) throw new JevClientError('missing_fetch', 'fetchImpl is required');
  const timeoutMs = input.timeoutMs ?? JEV_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new JevClientError('bad_request', 'bad timeout');
  input.logger?.(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await input.fetchImpl(DECISIONS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: payload,
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbort(error)) throw new JevClientError('timeout', 'decisions timeout');
      throw new JevClientError('transport', 'decisions transport');
    }
    const text = await response.text();
    if (!response.ok) {
      const pub = publicError(text);
      throw new JevClientError('http_status', pub.message ?? `http_${response.status}`, {
        status: response.status,
        apiCode: pub.code,
      });
    }
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) as unknown : null;
    } catch {
      throw new JevClientError('bad_response', 'decisions response was not json', { status: response.status });
    }
    const checked = responseSchema.safeParse(parsed);
    if (!checked.success) {
      throw new JevClientError('bad_response', 'decisions response did not match the documented schema', {
        status: response.status,
      });
    }
    return checked.data;
  } finally {
    clearTimeout(timer);
  }
}

function compileQuestions(questions: Readonly<Record<string, DecisionQuestion>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new JevClientError('bad_request', 'questions are empty');
  for (const id of ids) {
    const question = questions[id];
    if (!question) throw new JevClientError('bad_request', 'missing question');
    if (question.instructions.trim().length === 0) throw new JevClientError('bad_request', 'instructions are empty');
    if (question.type === 'noul') out[id] = compileNoul(question);
    else if (question.type === 'choice') out[id] = compileChoice(question);
    else if (question.type === 'score') out[id] = compileScore(question);
    else out[id] = { type: 'box', instructions: question.instructions };
  }
  return out;
}

function compileNoul(question: Extract<DecisionQuestion, { type: 'noul' }>): Record<string, unknown> {
  const wire: Record<string, unknown> = { type: 'noul', instructions: question.instructions };
  if (question.criteria) {
    const keys = Object.keys(question.criteria);
    if (keys.length !== 2 || question.criteria.true === undefined || question.criteria.false === undefined) {
      throw new JevClientError('bad_request', 'noul criteria must be a record of true and false');
    }
    if (typeof question.criteria.true !== 'string' || typeof question.criteria.false !== 'string') {
      throw new JevClientError('bad_request', 'noul criteria must be strings');
    }
    wire.criteria = { true: question.criteria.true, false: question.criteria.false };
  }
  return wire;
}

function compileChoice(question: Extract<DecisionQuestion, { type: 'choice' }>): Record<string, unknown> {
  const criteria: unknown = question.criteria;
  if (typeof criteria === 'string' || Array.isArray(criteria) || criteria === null || typeof criteria !== 'object') {
    throw new JevClientError('bad_request', 'choice criteria must be a record of label to description');
  }
  const record = criteria as Record<string, unknown>;
  const labels = Object.keys(record);
  if (labels.length === 0) throw new JevClientError('bad_request', 'choice criteria are empty');
  const wire: Record<string, string> = {};
  for (const label of labels) {
    const description = record[label];
    if (typeof description !== 'string' || description.trim().length === 0) {
      throw new JevClientError('bad_request', 'choice criteria descriptions must be strings');
    }
    wire[label] = description;
  }
  return { type: 'choice', instructions: question.instructions, criteria: wire };
}

function compileScore(question: Extract<DecisionQuestion, { type: 'score' }>): Record<string, unknown> {
  const criteria: unknown = question.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0 || criteria.some(level => typeof level !== 'string' || level.trim().length === 0)) {
    throw new JevClientError('bad_request', 'score criteria must be an array of level descriptions');
  }
  return { type: 'score', instructions: question.instructions, criteria: [...criteria] };
}

function assertState(state: unknown): asserts state is DecisionState {
  if (typeof state === 'string') return;
  if (Array.isArray(state) || (state !== null && typeof state === 'object')) {
    walkImages(state);
    return;
  }
  throw new JevClientError('bad_request', 'state must be a string, object, or array');
}

function walkImages(state: unknown): void {
  if (Array.isArray(state)) {
    for (const item of state) walkImages(item);
    return;
  }
  if (!state || typeof state !== 'object') return;
  const record = state as Record<string, unknown>;
  if (record.type === 'image_url') {
    if (!isImagePart(record)) throw new JevClientError('image_rejected', 'image_url part is incomplete');
    assertDataImage(record.image_url.url);
    return;
  }
  for (const value of Object.values(record)) walkImages(value);
}

function isImagePart(value: unknown): value is ImageUrlPart {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== 'image_url') return false;
  const image = record.image_url;
  if (!image || typeof image !== 'object' || Array.isArray(image)) return false;
  return typeof (image as { url?: unknown }).url === 'string';
}

function assertDataImage(url: string): void {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    throw new JevClientError('image_rejected', 'remote image urls are not sent');
  }
  const match = /^data:(image\/(?:png|jpeg|jpg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  const mime = match?.[1];
  const b64 = match?.[2];
  if (!mime || !b64) throw new JevClientError('image_rejected', 'image must be a base64 png or jpeg data url');
  const bytes = Buffer.from(b64, 'base64');
  const size = mime === 'image/png' ? pngSize(bytes) : jpegSize(bytes);
  if (!size || !imageWithinBounds(size.width, size.height)) {
    throw new JevClientError('image_rejected', 'image is outside 256..1568px per side or below 78400 pixels');
  }
}function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < sig.length; i += 1) if (bytes[i] !== sig[i]) return null;
  if (bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) return null;
  const width = readU32(bytes, 16);
  const height = readU32(bytes, 20);
  if (width === null || height === null) return null;
  return { width, height };
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === undefined) return null;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const heightHi = bytes[i + 5];
      const heightLo = bytes[i + 6];
      const widthHi = bytes[i + 7];
      const widthLo = bytes[i + 8];
      if (heightHi === undefined || heightLo === undefined || widthHi === undefined || widthLo === undefined) return null;
      return { width: (widthHi << 8) | widthLo, height: (heightHi << 8) | heightLo };
    }
    const lenHi = bytes[i + 2];
    const lenLo = bytes[i + 3];
    if (lenHi === undefined || lenLo === undefined) return null;
    const len = (lenHi << 8) | lenLo;
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function readU32(bytes: Uint8Array, offset: number): number | null {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) return null;
  return (b0 * 0x1000000) + (b1 * 0x10000) + (b2 * 0x100) + b3;
}

function checkObs(value: string, field: string): void {
  if (value.length === 0 || value.length > OBS_MAX) {
    throw new JevClientError('bad_request', `${field} must be 1..${OBS_MAX} characters`);
  }
}

function usableKey(apiKey: string | undefined): string | null {
  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.trim() !== apiKey) return null;
  if (/[\r\n\0]/.test(apiKey)) return null;
  return apiKey;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Read error.message and error.code. Drop user_id and do not keep the raw body. */
function publicError(text: string): { message: string | null; code: string | number | null } {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { message: null, code: null };
    const error = (parsed as { error?: unknown }).error;
    if (!error || typeof error !== 'object' || Array.isArray(error)) return { message: null, code: null };
    const record = error as Record<string, unknown>;
    const userId = typeof record.user_id === 'string' ? record.user_id : null;
    const code = typeof record.code === 'string' || typeof record.code === 'number' ? record.code : null;
    let message = typeof record.message === 'string' ? record.message : null;
    if (message && userId && userId.length > 0) message = message.split(userId).join('[redacted]');
    return { message, code };
  } catch {
    return { message: null, code: null };
  }
}
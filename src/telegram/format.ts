// Product glue for the Telegram bridge (specs/001-telegram-bridge, tasks T017–T018).
// Pure text: OutboxPayload.text, OutboxPayload.part, OutboxPayload.parts, and
// OutboxPayload.destination. Nothing here sends, reads a bot token, or opens a webhook.
// The gate repository owns delivery. Room text is untrusted and is never executed.

export const PINNED_WORKER = 'agent-workroom-main';
export const SINK_PRINCIPAL = 'sink:telegram';
export const TEXT_LIMIT = 4096;
export const NEWLINE_WINDOW = 400;
export const PREVIEW_CHARS = 180;
export const TOPIC_CAP = 32;
export const PACE = {
  maxSuccessPerWindow: 20,
  windowMs: 60_000,
  minGapMs: 3_000,
  maxPerSecond: 1,
} as const;

export const BRIDGE_STORAGE_NOT_READY = 'Bridge storage is not ready.';

const RESERVED_ACTORS = new Set(['user:minsung', 'topic:timeline', 'topic:unlisted']);
const UPDATE_ID = /^[1-9]\d{0,30}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.-]{8,128}$/;
const SHORT_CODE = /^[A-Z][A-Z0-9_]{0,40}$/;
const BOT_TOKEN = /\d{6,16}:[A-Za-z0-9_-]{30,}/g;
const WEBHOOK_SECRET = /whsec_[A-Za-z0-9_-]{8,}/g;

export type OutboxDestination = 'actor' | 'timeline' | 'unlisted';

/** OutboxPayload fields from data-model.md. The token and the chat id are not fields. */
export interface OutboxPayload {
  kind: 'telegram.room';
  actor_id: string;
  room: string;
  message_id: string;
  thread_id: string | null;
  text: string;
  part: number;
  parts: number;
  destination: OutboxDestination;
}

export interface MirrorInput {
  actorId: string;
  room: string;
  messageId: string;
  threadId?: string | null;
  text: string;
  existingActorIds: readonly string[];
  limit?: number;
}

export interface TopicPlan {
  destination: 'actor' | 'unlisted';
  createTopic: boolean;
  counted: number;
  atCap: boolean;
}

export interface TelegramUpdateKeys {
  decisionId: string;
  source: string;
  roomKey: string;
}

export interface TelegramSendBody {
  text: string;
  link_preview_options: { is_disabled: true };
  disable_notification: boolean;
}

export interface MirrorFilter {
  enabledFlag?: string | null;
  room: string;
  roomsFlag?: string | null;
  mentionsOnlyFlag?: string | null;
  mentionTokensFlag?: string | null;
  text: string;
}

export function redactSecrets(text: string): string {
  return text.replace(BOT_TOKEN, '[redacted]').replace(WEBHOOK_SECRET, '[redacted]');
}

export function isCountedActor(actorId: string): boolean {
  return !RESERVED_ACTORS.has(actorId);
}

/** Visible forum name: timeline, unlisted, or the actor id trimmed to 128 characters. */
export function topicName(actorId: string): string {
  if (actorId === 'topic:timeline' || actorId === 'timeline') return 'timeline';
  if (actorId === 'topic:unlisted' || actorId === 'unlisted') return 'unlisted';
  return Array.from(actorId).slice(0, 128).join('');
}

export function planTopic(actorId: string, existingActorIds: readonly string[]): TopicPlan {
  const existing = existingActorIds.filter((id): id is string => typeof id === 'string');
  const counted = new Set(existing.filter(isCountedActor)).size;
  const has = existing.includes(actorId);
  const atCap = counted >= TOPIC_CAP;
  if (!isCountedActor(actorId)) return { destination: 'actor', createTopic: !has, counted, atCap };
  if (has) return { destination: 'actor', createTopic: false, counted, atCap };
  if (atCap) return { destination: 'unlisted', createTopic: false, counted, atCap };
  return { destination: 'actor', createTopic: true, counted, atCap };
}

export function selectedRooms(roomsFlag: string | null | undefined): string[] {
  if (roomsFlag == null || roomsFlag.trim() === '') return ['room_main'];
  const rooms = roomsFlag.split(',').map(part => part.trim()).filter(part => part.length > 0 && part.length <= 128);
  return rooms.length > 0 ? rooms : ['room_main'];
}

export function mirrorAllowed(input: MirrorFilter): boolean {
  if (input.enabledFlag === '0') return false;
  if (!selectedRooms(input.roomsFlag).includes(input.room)) return false;
  if (input.mentionsOnlyFlag === '1' && !mentionsOwner(input.text, input.mentionTokensFlag)) return false;
  return true;
}

/** Room idempotency key tg-update-<id>. The ledger key in the spec contains a colon, so this module does not build it. */
export function telegramUpdateKeys(updateId: string): TelegramUpdateKeys | null {
  if (!UPDATE_ID.test(updateId)) return null;
  const decisionId = `od_tg_${updateId}`;
  const source = `tg-${updateId}`;
  const roomKey = `tg-update-${updateId}`;
  if (!IDEMPOTENCY_KEY.test(roomKey)) return null;
  return { decisionId, source, roomKey };
}

/** Informational marker. Authority is the authenticated author, which this module does not decide. */
export function ownerDecisionText(input: {
  updateId: string;
  verbatim: string;
  replyToMessageId?: string | null;
  threadId?: string | null;
}): string | null {
  const keys = telegramUpdateKeys(input.updateId);
  if (!keys || typeof input.verbatim !== 'string') return null;
  const lines = [
    `OWNER DECISION ${keys.decisionId}`,
    `source: ${keys.source}`,
    'direct: true',
  ];
  if (input.replyToMessageId != null && input.replyToMessageId !== '') {
    if (!fieldId(input.replyToMessageId)) return null;
    lines.push(`reply_to_message_id: ${input.replyToMessageId}`);
    if (input.threadId != null && input.threadId !== '') {
      if (!fieldId(input.threadId)) return null;
      lines.push(`thread_id: ${input.threadId}`);
    }
  }
  lines.push(redactSecrets(input.verbatim));
  return lines.join('\n');
}

export function recordedLine(updateId: string, roomMessageId: string): string | null {
  const keys = telegramUpdateKeys(updateId);
  if (!keys || !fieldId(roomMessageId)) return null;
  const text = `Recorded ${keys.decisionId}\nroom ${roomMessageId}`;
  return text.length <= TEXT_LIMIT ? text : null;
}

export function digestLine(actorId: string, messageId: string, body: string): string {
  const name = topicName(actorId).replace(/[\r\n]/g, '');
  const id = messageId.replace(/[\r\n]/g, '').slice(0, 128);
  const preview = redactSecrets(body).replace(/\r\n/g, '\n').slice(0, PREVIEW_CHARS);
  const line = `${name} ${id}\n${preview}`;
  return line.length <= TEXT_LIMIT ? line : line.slice(0, TEXT_LIMIT);
}

export function buildCardParts(input: {
  actorId: string;
  room: string;
  messageId: string;
  body: string;
  limit?: number;
}): string[] {
  const limit = input.limit ?? TEXT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return [];
  const actor = topicName(input.actorId).replace(/[\r\n]/g, '');
  const room = input.room.replace(/[\r\n]/g, '');
  const messageId = input.messageId.replace(/[\r\n]/g, '');
  const head = `${actor}\n${room} ${messageId}\n`;
  if (head.length > limit) return [];
  const body = redactSecrets(input.body);
  if (head.length + body.length <= limit) return [head + body];
  let guess = 2;
  const maxGuess = body.length + 2;
  let spins = 0;
  while (guess <= maxGuess && spins < maxGuess + 5) {
    spins += 1;
    const built = tryParts(head, body, guess, limit);
    if (built === null) {
      guess += 1;
      continue;
    }
    if (built.length === guess) return built;
    if (built.length === 0) return [];
    guess = built.length;
  }
  return [];
}

export function mirrorPayloads(input: MirrorInput): OutboxPayload[] {
  if (!fieldId(input.actorId) || !fieldId(input.room) || !fieldId(input.messageId)) return [];
  if (typeof input.text !== 'string') return [];
  const threadId = input.threadId == null || input.threadId === '' ? null : input.threadId;
  if (threadId !== null && !fieldId(threadId)) return [];
  const plan = planTopic(input.actorId, input.existingActorIds);
  const limit = input.limit ?? TEXT_LIMIT;
  const texts = plan.destination === 'unlisted'
    ? [digestLine(input.actorId, input.messageId, input.text)]
    : buildCardParts({
      actorId: input.actorId, room: input.room, messageId: input.messageId, body: input.text, limit,
    });
  if (texts.length === 0 || texts.some(text => text.length < 1 || text.length > limit)) return [];
  const shared = {
    kind: 'telegram.room' as const,
    actor_id: input.actorId,
    room: input.room,
    message_id: input.messageId,
    thread_id: threadId,
  };
  const cards: OutboxPayload[] = texts.map((text, index) => ({
    ...shared,
    text,
    part: index + 1,
    parts: texts.length,
    destination: plan.destination,
  }));
  const timeline = digestLine(input.actorId, input.messageId, input.text);
  if (timeline.length < 1 || timeline.length > TEXT_LIMIT) return [];
  cards.push({ ...shared, text: timeline, part: 1, parts: 1, destination: 'timeline' });
  return cards;
}

/** Plain send body. No parse mode and no entity list. Link previews are off. Does not send. */
export function toSendBody(text: string, muted: boolean): TelegramSendBody | null {
  if (typeof text !== 'string' || text.length < 1 || text.length > TEXT_LIMIT) return null;
  return {
    text,
    link_preview_options: { is_disabled: true },
    disable_notification: muted,
  };
}

export function nextSendAt(now: number, successAt: readonly number[]): number {
  if (!Number.isFinite(now)) return Number.POSITIVE_INFINITY;
  const past = successAt.filter(stamp => Number.isFinite(stamp) && stamp <= now);
  const last = past.length > 0 ? Math.max(...past) : null;
  let at = now;
  if (last !== null && now - last < PACE.minGapMs) at = last + PACE.minGapMs;
  const inWindow = past.filter(stamp => now - stamp < PACE.windowMs);
  if (inWindow.length >= PACE.maxSuccessPerWindow) {
    const oldest = Math.min(...inWindow);
    at = Math.max(at, oldest + PACE.windowMs);
  }
  return at;
}

export function paceAllowsSend(now: number, successAt: readonly number[]): boolean {
  return nextSendAt(now, successAt) <= now;
}

export function retryAfterDelayMs(retryAfterSeconds: unknown): number | null {
  if (typeof retryAfterSeconds !== 'number' || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) return null;
  const ms = Math.ceil(retryAfterSeconds * 1000);
  if (!Number.isFinite(ms) || ms > 24 * 60 * 60 * 1000) return null;
  return ms;
}

export function shortErrorCode(code: string): string {
  return SHORT_CODE.test(code) ? code : 'TELEGRAM_ERROR';
}

function mentionsOwner(text: string, tokensFlag: string | null | undefined): boolean {
  const configured = tokensFlag == null || tokensFlag.trim() === ''
    ? ['minsung', 'ryan']
    : tokensFlag.split(',').map(part => part.trim()).filter(part => part.length > 0);
  const tokens = ['minsung', ...configured];
  const hay = text.toLowerCase();
  for (const raw of tokens) {
    const token = raw.trim().toLowerCase().replace(/^@/, '');
    if (token.length < 1 || token.length > 64) continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[^a-z0-9_])@?${escaped}(?=$|[^a-z0-9_])`, 'i').test(hay)) return true;
  }
  return false;
}

function fieldId(value: string): boolean {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && !/[\u0000\r\n]/.test(value);
}

function avoidSurrogate(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return Math.max(0, cut);
  const prev = text.charCodeAt(cut - 1);
  const next = text.charCodeAt(cut);
  if (prev >= 0xD800 && prev <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) return cut - 1;
  return cut;
}

function takeChunk(text: string, budget: number): string {
  if (budget <= 0 || text.length === 0) return '';
  if (text.length <= budget) return text;
  let cut = budget;
  const windowStart = Math.max(0, budget - NEWLINE_WINDOW);
  const window = text.slice(windowStart, budget);
  const newline = window.lastIndexOf('\n');
  if (newline !== -1) {
    const at = windowStart + newline + 1;
    if (at > 0 && at <= budget) cut = at;
  }
  cut = avoidSurrogate(text, cut);
  if (cut <= 0) {
    const pair = text.charCodeAt(0) >= 0xD800 && text.charCodeAt(0) <= 0xDBFF && budget >= 2;
    cut = pair ? 2 : 1;
  }
  return text.slice(0, Math.min(cut, budget));
}

function tryParts(head: string, body: string, parts: number, limit: number): string[] | null {
  const out: string[] = [];
  let rest = body;
  for (let index = 1; index <= parts; index += 1) {
    if (rest.length === 0) break;
    const marker = `(${index}/${parts})\n`;
    const budget = limit - head.length - marker.length;
    if (budget < 1) return null;
    const chunk = takeChunk(rest, budget);
    if (chunk.length === 0) return null;
    const text = head + marker + chunk;
    if (text.length > limit) return null;
    out.push(text);
    rest = rest.slice(chunk.length);
  }
  return rest.length === 0 ? out : null;
}

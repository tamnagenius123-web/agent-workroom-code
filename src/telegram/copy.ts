// TUI copy for the Telegram command menu (specs/001-telegram-bridge, task T019).
// Plain text only. No auth check and no callback verifier.
// TelegramPageToken.payload_json is the next-page cursor the gate stores.
// This module does not create that table. It only places a token the gate already minted
// onto a More button. Room lines are untrusted data and are never executed.

import { computeTrackerLoad } from '../phase-contracts/tracker-load.ts';
import { TEXT_LIMIT, redactSecrets, toSendBody, type TelegramSendBody } from './format.ts';

export const DENIED_TEXT = 'Not allowed.';

export const ALLOWLISTED_COMMANDS = [
  'menu', 'start', 'read', 'thread', 'history', 'post', 'reply', 'search', 'folds', 'wake', 'whoami', 'load', 'help',
] as const;

export type AllowlistedCommand = (typeof ALLOWLISTED_COMMANDS)[number];

export const WRITE_COMMANDS = ['post', 'reply'] as const;

export interface BotCommand {
  command: string;
  description: string;
}

export const BOT_COMMANDS: readonly BotCommand[] = [
  { command: 'menu', description: 'Show the workroom menu' },
  { command: 'read', description: 'Recent room_main messages' },
  { command: 'thread', description: 'Thread: /thread <thread_id>' },
  { command: 'history', description: 'History: /history <message_id>' },
  { command: 'post', description: 'Post an owner decision' },
  { command: 'reply', description: 'Reply: /reply <message_id> <text>' },
  { command: 'search', description: 'Search room messages' },
  { command: 'folds', description: 'Fold view' },
  { command: 'wake', description: 'Wake proof: /wake <message_id> <agent>' },
  { command: 'whoami', description: 'Owner principal and connection' },
  { command: 'load', description: 'Tracker load (no stored units)' },
  { command: 'help', description: 'What each command does' },
];

const USAGE: Readonly<Record<string, string>> = {
  thread: 'Usage: /thread <thread_id>',
  history: 'Usage: /history <message_id>',
  post: 'Usage: /post <text>',
  reply: 'Usage: /reply <message_id> <text>',
  search: 'Usage: /search <query>',
  wake: 'Usage: /wake <message_id> <agent>',
};

const ALLOWED = new Set<string>(ALLOWLISTED_COMMANDS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_FACT = /^[A-Za-z0-9_.: -]{1,80}$/;
const HEX_HASH = /^[0-9a-f]{32,}$/i;

export interface TelegramButton {
  text: string;
  callback_data: string;
}

export interface TelegramPage {
  text: string;
  keyboard: TelegramButton[][];
}

/** Gate-minted TelegramPageToken.token. The cursor itself stays in TelegramPageToken.payload_json. */
export interface PageCursor {
  token: string;
}

export interface RecentRow {
  actorId: string;
  timeLabel: string;
  messageId: string;
  line: string;
}

export interface HistoryRow {
  version: number;
  actorId: string;
  timeLabel: string;
  line: string;
}

export interface SearchHit {
  messageId: string;
  actorId: string;
  snippet: string;
}

export interface FoldRow {
  id: string;
  state: string;
  summary: string;
}

export interface WhoamiFacts {
  room?: string;
  canPost?: boolean;
  connection?: string;
  write?: string;
}

export interface WakeProofView {
  messageId: string;
  agent: string;
  persisted?: boolean;
  emitted?: boolean;
  relayReceipt?: boolean;
  hostRun?: boolean;
  readOutcome?: boolean;
}

const MENU_KEYBOARD: readonly (readonly TelegramButton[])[] = [
  [{ text: 'Recent', callback_data: 'tgc:read' }, { text: 'Search', callback_data: 'tgc:search' }],
  [{ text: 'Folds', callback_data: 'tgc:folds' }, { text: 'Whoami', callback_data: 'tgc:whoami' }],
  [{ text: 'Load', callback_data: 'tgc:load' }, { text: 'Wake', callback_data: 'tgc:wake' }],
  [{ text: 'Help', callback_data: 'tgc:help' }],
];

export function isAllowlistedCommand(name: string): name is AllowlistedCommand {
  return ALLOWED.has(name);
}

/** Maps /start to menu. Does not run the command and does not check who sent it. */
export function canonicalCommand(name: string): AllowlistedCommand | null {
  const word = name.trim().toLowerCase().replace(/^\//, '').split('@')[0] ?? '';
  if (word === 'start') return 'menu';
  return isAllowlistedCommand(word) ? word : null;
}

export function usageLine(command: string): string {
  const name = canonicalCommand(command);
  if (!name) return 'Unknown command. /help lists the commands.';
  return USAGE[name] ?? `${name} ${BOT_COMMANDS.find(row => row.command === name)?.description ?? ''}`.trim();
}

export function emptyCopy(kind: 'recent' | 'thread' | 'history' | 'search' | 'folds'): string {
  switch (kind) {
    case 'recent': return 'No messages in room_main yet.';
    case 'thread': return 'This thread has no messages.';
    case 'history': return 'No revisions for that message.';
    case 'search': return 'No matches.';
    case 'folds': return 'No folds.';
  }
}

export function menuKeyboard(): TelegramButton[][] {
  return MENU_KEYBOARD.map(row => row.map(button => ({ text: button.text, callback_data: button.callback_data })));
}

export function menuPage(room?: string): TelegramPage {
  const text = ['Workroom', safeRoom(room), 'Choose a read, or type a decision.'].join('\n');
  return finish(text, menuKeyboard());
}

export function recentPage(input: { room?: string; rows: readonly RecentRow[]; more?: PageCursor | null }): TelegramPage {
  if (input.rows.length === 0) return finish(emptyCopy('recent'), menuKeyboard());
  const blocks = input.rows.map(row => [
    `${oneLine(row.actorId, 128)}  ${oneLine(row.timeLabel, 32)}`,
    oneLine(row.messageId, 128),
    oneLine(row.line, 400),
  ].join('\n'));
  return finish(fitBlocks(`${safeRoom(input.room)}  recent`, blocks).text, pageKeyboard(input.more ?? null));
}

export function threadPage(input: { threadId: string; rows: readonly RecentRow[]; more?: PageCursor | null }): TelegramPage {
  if (input.rows.length === 0) return finish(emptyCopy('thread'), pageKeyboard(null));
  const blocks = input.rows.map(row => [
    `${oneLine(row.actorId, 128)}  ${oneLine(row.timeLabel, 32)}`,
    oneLine(row.line, 400),
  ].join('\n'));
  return finish(fitBlocks(`thread ${oneLine(input.threadId, 128)}`, blocks).text, pageKeyboard(input.more ?? null));
}

export function historyPage(input: { messageId: string; rows: readonly HistoryRow[] }): TelegramPage {
  if (input.rows.length === 0) return finish(emptyCopy('history'), pageKeyboard(null));
  const blocks = input.rows
    .filter(row => Number.isInteger(row.version) && row.version >= 1)
    .map(row => [
      `v${row.version} ${oneLine(row.actorId, 128)}  ${oneLine(row.timeLabel, 32)}`,
      oneLine(row.line, 400),
    ].join('\n'));
  if (blocks.length === 0) return finish(emptyCopy('history'), pageKeyboard(null));
  return finish(fitBlocks(`history ${oneLine(input.messageId, 128)}`, blocks).text, pageKeyboard(null));
}

export function searchPage(input: { query: string; hits: readonly SearchHit[]; more?: PageCursor | null }): TelegramPage {
  const query = oneLine(input.query, 120);
  if (input.hits.length === 0) {
    return finish([`search  "${query}"`, emptyCopy('search')].join('\n'), pageKeyboard(null));
  }
  const blocks = input.hits.map(hit => [
    `${oneLine(hit.messageId, 128)} ${oneLine(hit.actorId, 128)}`,
    oneLine(hit.snippet, 400),
  ].join('\n'));
  const label = `search  "${query}"`;
  const fitted = fitBlocks(label, blocks);
  const rest = fitted.text.startsWith(label) ? fitted.text.slice(label.length) : '';
  return finish(`${label}\n${fitted.shown} matches${rest}`, pageKeyboard(input.more ?? null));
}

export function foldsPage(input: { room?: string; folds: readonly FoldRow[] }): TelegramPage {
  if (input.folds.length === 0) return finish(emptyCopy('folds'), pageKeyboard(null));
  const blocks = input.folds.map(fold => [
    `${oneLine(fold.id, 128)}  ${oneLine(fold.state, 32)}`,
    oneLine(fold.summary, 400),
  ].join('\n'));
  return finish(fitBlocks(`folds  ${safeRoom(input.room)}`, blocks).text, pageKeyboard(null));
}

export function whoamiPage(facts: WhoamiFacts = {}): TelegramPage {
  const text = [
    'whoami',
    'principal: user:minsung',
    `room: ${safeRoom(facts.room)}`,
    `can_post: ${facts.canPost === true ? 'yes' : 'no'}`,
    `connection: ${safeFact(facts.connection)}`,
    `write: ${safeFact(facts.write)}`,
  ].join('\n');
  return finish(text, pageKeyboard(null));
}

/** Always the empty unit list. Says no unit store was read. */
export function loadPage(): TelegramPage {
  const load = computeTrackerLoad([]);
  const text = [
    'tracker load',
    'No stored units. Empty list.',
    'Tracker load has no stored units. Counting the empty list.',
    `counted ${load.counted_units}  done ${load.excluded_done}  rejected ${load.rejected.length}`,
  ].join('\n');
  return finish(text, pageKeyboard(null));
}

/** Read-only proof text. Missing flags stay gaps. This does not write wake evidence. */
export function wakeProofPage(proof: WakeProofView): TelegramPage {
  const text = [
    'wake proof',
    `message ${oneLine(proof.messageId, 128) || 'gap'}`,
    `agent ${oneLine(proof.agent, 128) || 'gap'}`,
    `persisted: ${flag(proof.persisted)}`,
    `emitted: ${flag(proof.emitted)}`,
    `relay_receipt: ${flag(proof.relayReceipt)}`,
    `host_run: ${flag(proof.hostRun)}`,
    `read_outcome: ${flag(proof.readOutcome)}`,
  ].join('\n');
  return finish(text, pageKeyboard(null));
}

export function helpPage(): TelegramPage {
  const lines = BOT_COMMANDS.map(row => `${row.command.padEnd(7)}  ${row.description}`);
  return finish(lines.join('\n'), menuKeyboard());
}

export function usagePage(command: string): TelegramPage {
  return finish(usageLine(command), menuKeyboard());
}

export function unknownCommandPage(): TelegramPage {
  return finish('Unknown command. /help lists the commands.', menuKeyboard());
}

/** Command pages are muted plain text. The keyboard stays on the page object, not in the body. */
export function commandSendBody(page: TelegramPage): TelegramSendBody | null {
  return toSendBody(page.text, true);
}

function finish(text: string, keyboard: TelegramButton[][]): TelegramPage {
  return { text: boundText(redactSecrets(text)), keyboard };
}

function pageKeyboard(more: PageCursor | null): TelegramButton[][] {
  const rows: TelegramButton[][] = [];
  const token = more?.token;
  if (typeof token === 'string' && UUID.test(token)) {
    const callback = `tgc:p:${token.toLowerCase()}`;
    if (callback.length === 42) rows.push([{ text: 'More', callback_data: callback }]);
  }
  rows.push([{ text: 'Menu', callback_data: 'tgc:menu' }]);
  return rows;
}

function fitBlocks(head: string, blocks: readonly string[]): { text: string; shown: number } {
  const kept: string[] = [];
  for (const block of blocks) {
    const next = [...kept, block].join('\n\n');
    const candidate = `${head}\n${next}`;
    if (candidate.length > TEXT_LIMIT) break;
    kept.push(block);
  }
  const body = kept.join('\n\n');
  let text = body.length > 0 ? `${head}\n${body}` : head;
  if (kept.length < blocks.length) {
    const marked = `${text}\n…`;
    text = marked.length <= TEXT_LIMIT ? marked : text;
  }
  return { text: text.length <= TEXT_LIMIT ? text : boundText(text), shown: kept.length };
}

function boundText(text: string): string {
  if (text.length <= TEXT_LIMIT) return text;
  let cut = TEXT_LIMIT - 1;
  if (cut > 0 && cut < text.length) {
    const prev = text.charCodeAt(cut - 1);
    const next = text.charCodeAt(cut);
    if (prev >= 0xD800 && prev <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) cut -= 1;
  }
  return `${text.slice(0, Math.max(0, cut))}…`;
}

function oneLine(value: string, max: number): string {
  const clean = redactSecrets(String(value ?? '')).replace(/[\u0000\r\n]/g, ' ').trim();
  return clean.length <= max ? clean : clean.slice(0, max);
}

function safeRoom(room: string | undefined): string {
  return room !== undefined && /^[A-Za-z0-9_.:-]{1,128}$/.test(room) ? room : 'room_main';
}

function safeFact(value: string | undefined): string {
  if (value == null) return 'unavailable';
  const redacted = redactSecrets(value);
  if (redacted !== value || HEX_HASH.test(value) || !SAFE_FACT.test(value)) return 'unavailable';
  return value;
}

function flag(value: boolean | undefined): string {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return 'gap';
}

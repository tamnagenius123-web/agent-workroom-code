// TG-UI (owner t788u; tracker row TG-UI): read-only Telegram views for the owner behind one inline menu.
// Six HTML templates: tracker, gantt, load, my queue (owner-gated units), unit detail, latest room post.
// Renders are pure: data and `now` come in as arguments, and load numbers come only from computeTrackerLoad.
// Callback order: shape -> tgv: prefix (anything else is 'ignored' so the approval handler can take tga:) -> parse
// -> owner (callback_query.from.id == TELEGRAM_OWNER_USER_ID, t907u; the chat id never stands in) -> read -> render
// -> edit in place -> answer. Nothing here writes state.
import { computeTrackerLoad, isDoneStatus, normStatus, UNKNOWN_AGENT } from '../phase-contracts/tracker-load.ts';

export const TEXT_CAP = 3900; // Telegram allows 4096 per message
export const VIEW_IDS = ['tracker', 'gantt', 'load', 'myq', 'post', 'unit', 'menu'] as const;
type ListView = Exclude<(typeof VIEW_IDS)[number], 'unit'>;
export type ViewRequest = { view: ListView } | { view: 'unit'; id: string };
export interface ViewUnit { id: string; title?: string; worker?: string; verifier?: string; status: string; eta?: { best: string; likely: string; worst: string } }
export interface ViewPost { id: string; actor: string; createdAt: string; text: string }
type Button = { text: string; callback_data: string };
export interface Rendered { text: string; parse_mode: 'HTML'; reply_markup: { inline_keyboard: Button[][] } }
export interface RenderData { units: readonly ViewUnit[]; post: ViewPost | null; now: number; redact?: (text: string) => string }
export interface ViewDeps {
  units(): Promise<ViewUnit[]>;
  latestPost(): Promise<ViewPost | null>;
  redact(text: string): string;
  now(): number;
  edit(chatId: unknown, messageId: unknown, view: Rendered): Promise<void>;
  answer(callbackQueryId: string, text: string): Promise<void>;
  error(code: string): void;
}
// The chat id is listed only so callers can pass the whole Telegram env; identity never reads it (t907u).
export interface ViewEnv { TELEGRAM_OWNER_USER_ID?: string; TELEGRAM_OWNER_CHAT_ID?: string }
export type ViewOutcome = 'rendered' | 'unknown' | 'denied' | 'failed' | 'ignored';

const LIST_VIEWS = new Set<string>(VIEW_IDS.filter(v => v !== 'unit'));
const UNIT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const MAX_UNIT_BUTTONS = 8;
const GANTT_WIDTH = 20;
const KST_MS = 9 * 3_600_000;
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const kst = (ms: number) => new Date(ms + KST_MS).toISOString();
const hm = (ms: number) => kst(ms).slice(11, 16);
const mdhm = (ms: number) => `${kst(ms).slice(5, 10)} ${hm(ms)}`;

export function parseViewCallback(data: unknown): ViewRequest | null {
  // Telegram caps callback_data at 64 bytes; the longest legal value is tgv:unit: + 48 ASCII chars = 57.
  if (typeof data !== 'string' || !data.startsWith('tgv:')) return null;
  const [view, arg, ...rest] = data.slice(4).split(':');
  if (rest.length) return null;
  if (view === 'unit') return arg !== undefined && UNIT_ID.test(arg) ? { view, id: arg } : null;
  return arg === undefined && LIST_VIEWS.has(view!) ? { view: view as ListView } : null;
}

const callbackFor = (req: ViewRequest) => req.view === 'unit' ? `tgv:unit:${req.id}` : `tgv:${req.view}`;
const view = (text: string, rows: Button[][]): Rendered => ({ text, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
const nav = (req: ViewRequest): Button[] => [{ text: 'Refresh', callback_data: callbackFor(req) }, { text: 'Menu', callback_data: 'tgv:menu' }];

// Head, then as many lines as fit under TEXT_CAP, then "… N more" for the rest. Lines are already escaped.
function fit(head: string, lines: string[], wrap: (body: string) => string = b => b): string {
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const more = lines.length - i - 1 > 0 ? `\n… ${lines.length - i - 1} more` : '';
    if ((head + wrap([...kept, lines[i]].join('\n')) + more).length > TEXT_CAP) {
      return head + wrap(kept.join('\n')) + `\n… ${lines.length - i} more`;
    }
    kept.push(lines[i]!);
  }
  return head + wrap(kept.join('\n'));
}

export function menuView(): Rendered {
  return view('<b>Workroom</b>\nPick a view.', [
    [{ text: 'Tracker', callback_data: 'tgv:tracker' }, { text: 'Gantt', callback_data: 'tgv:gantt' }, { text: 'Load', callback_data: 'tgv:load' }],
    [{ text: 'My queue', callback_data: 'tgv:myq' }, { text: 'Room post', callback_data: 'tgv:post' }],
  ]);
}

const byId = (a: ViewUnit, b: ViewUnit) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const openUnits = (units: readonly ViewUnit[]) => units.filter(u => !isDoneStatus(u.status)).sort(byId);
const who = (cell: string | undefined) => esc(cell?.trim() || '-');
const titled = (u: ViewUnit) => (u.title ? ` — ${esc(u.title)}` : '');

function trackerView(units: readonly ViewUnit[]): Rendered {
  const open = openUnits(units);
  const lines = open.map(u => `<b>${esc(u.id)}</b> · ${who(u.worker)} · ${esc(normStatus(u.status) || u.status)}${titled(u)}`);
  const head = `<b>Tracker</b> — ${open.length} open, ${units.length - open.length} done\n`;
  return view(fit(head, lines), [nav({ view: 'tracker' })]);
}

type Eta = { best: number; likely: number; worst: number };
function parseEta(u: ViewUnit): Eta | null {
  const [best, likely, worst] = [u.eta?.best, u.eta?.likely, u.eta?.worst].map(s => (typeof s === 'string' ? Date.parse(s) : NaN));
  return Number.isFinite(best) && Number.isFinite(likely) && Number.isFinite(worst) && best! <= likely! && likely! <= worst!
    ? { best: best!, likely: likely!, worst: worst! } : null;
}

function ganttView(units: readonly ViewUnit[], now: number): Rendered {
  const rows: { u: ViewUnit; eta: Eta }[] = [];
  const noEta: string[] = [];
  for (const u of openUnits(units)) {
    const eta = parseEta(u);
    if (eta) rows.push({ u, eta }); else noEta.push(u.id);
  }
  rows.sort((a, b) => a.eta.likely - b.eta.likely || byId(a.u, b.u));
  const live = rows.filter(r => r.eta.worst >= now);
  const end = Math.max(now + 3_600_000, ...live.map(r => r.eta.worst));
  const label = Math.min(16, Math.max(4, ...rows.map(r => r.u.id.length)));
  const name = (id: string) => esc(id.length > label ? id.slice(0, label - 1) + '…' : id.padEnd(label));
  const lines = rows.map(({ u, eta }) => {
    if (eta.worst < now) return `${name(u.id)} LATE (worst ${mdhm(eta.worst)})`;
    let bar = '';
    for (let i = 0; i < GANTT_WIDTH; i++) {
      const t = now + ((i + 0.5) * (end - now)) / GANTT_WIDTH;
      bar += t <= eta.best ? '█' : t <= eta.likely ? '▓' : t <= eta.worst ? '░' : ' ';
    }
    return `${name(u.id)} ${bar} b ${hm(eta.best)} / l ${hm(eta.likely)} / w ${hm(eta.worst)}`;
  });
  const head = `<b>Gantt</b> KST ${mdhm(now)} → ${mdhm(end)} · █ best ▓ likely ░ worst\n`;
  const tail = noEta.length ? `\nno ETA: ${esc(noEta.join(', '))}` : '';
  const body = fit(head, lines, b => `<pre>${b}</pre>`);
  return view((body + tail).length <= TEXT_CAP ? body + tail : body, [nav({ view: 'gantt' })]);
}

function loadView(units: readonly ViewUnit[]): Rendered {
  const load = computeTrackerLoad(units);
  const claimed = load.agents.filter(a => a.agent !== UNKNOWN_AGENT);
  const total = claimed.reduce((s, a) => s + a.open_total, 0);
  const width = Math.max(5, ...claimed.map(a => a.agent.length));
  const lines = claimed.map(a => `${esc(a.agent.padEnd(width))} build ${a.build.open_total} review ${a.review.open_total} open ${a.open_total} ${total ? Math.round((100 * a.open_total) / total) : 0}%`);
  const unknown = load.agents.find(a => a.agent === UNKNOWN_AGENT);
  const rejected = load.rejected.map(r => `${r.id} (${r.reason})`).join(', ');
  const tail = `\nunclaimed ${unknown?.build.open_total ?? 0} · done ${load.excluded_done} · rejected ${load.rejected.length}${rejected ? `: ${esc(rejected)}` : ''}`;
  const head = '<b>Load</b> — open units per agent (share of claimed open slots)\n';
  const body = fit(head, lines, b => `<pre>${b}</pre>`);
  return view((body + tail).length <= TEXT_CAP ? body + tail : body, [nav({ view: 'load' })]);
}

function myQueueView(units: readonly ViewUnit[]): Rendered {
  const gated = openUnits(units).filter(u => normStatus(u.status) === 'GATED');
  if (!gated.length) return view('<b>My queue</b>: nothing waiting on you.', [nav({ view: 'myq' })]);
  const lines = gated.map(u => `<b>${esc(u.id)}</b> · ${who(u.worker)}${titled(u)}`);
  const buttons = gated.filter(u => UNIT_ID.test(u.id)).slice(0, MAX_UNIT_BUTTONS)
    .map(u => [{ text: u.id, callback_data: callbackFor({ view: 'unit', id: u.id }) }]);
  return view(fit(`<b>My queue</b> — ${gated.length} waiting on you\n`, lines), [...buttons, nav({ view: 'myq' })]);
}

function unitView(units: readonly ViewUnit[], id: string, now: number): Rendered {
  const u = units.find(x => x.id.trim() === id);
  const req: ViewRequest = { view: 'unit', id };
  if (!u) return view(`unknown unit ${esc(id)}`, [nav(req)]);
  const eta = parseEta(u);
  const etaLine = eta
    ? `ETA b ${mdhm(eta.best)} / l ${mdhm(eta.likely)} / w ${mdhm(eta.worst)} KST${eta.worst < now ? ' · LATE' : ''}`
    : 'ETA: none';
  const text = [`<b>${esc(u.id)}</b>${titled(u)}`, `worker: ${who(u.worker)}`, `verifier: ${who(u.verifier)}`, `status: ${esc(u.status)}`, etaLine].join('\n');
  return view(text.length <= TEXT_CAP ? text : text.slice(0, TEXT_CAP), [nav(req)]);
}

function postView(post: ViewPost | null, redact: ((text: string) => string) | undefined): Rendered {
  if (!redact) throw new Error('post view needs a redact function');
  if (!post) return view('There are no room posts yet.', [nav({ view: 'post' })]);
  const t = Date.parse(post.createdAt);
  const head = `<b>${esc(redact(post.actor))}</b> · ${Number.isFinite(t) ? `${mdhm(t)} KST` : '?'}\n`;
  // Redact first, then cut on the raw text so the escaped body never ends inside an entity.
  let text = redact(post.text);
  while ((head + esc(text)).length > TEXT_CAP) text = text.slice(0, Math.max(0, text.length - Math.ceil(((head + esc(text)).length - TEXT_CAP) / 6) - 1));
  return view(head + esc(text), [nav({ view: 'post' })]);
}

export function renderView(req: ViewRequest, data: RenderData): Rendered {
  switch (req.view) {
    case 'menu': return menuView();
    case 'tracker': return trackerView(data.units);
    case 'gantt': return ganttView(data.units, data.now);
    case 'load': return loadView(data.units);
    case 'myq': return myQueueView(data.units);
    case 'unit': return unitView(data.units, req.id, data.now);
    case 'post': return postView(data.post, data.redact);
  }
}

// Same identity rule as the approval cards (t907u option 2): from.id equals TELEGRAM_OWNER_USER_ID; unset denies.
function isOwner(from: unknown, env: ViewEnv): boolean {
  const owner = env.TELEGRAM_OWNER_USER_ID ?? '';
  const id = (from as { id?: unknown } | null | undefined)?.id;
  return /^\d+$/.test(owner) && (typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id))) && String(id) === owner;
}

export async function handleViewCallback(cq: unknown, env: ViewEnv, deps: ViewDeps): Promise<ViewOutcome> {
  const q = cq as { id?: unknown; from?: unknown; data?: unknown; message?: { message_id?: unknown; chat?: { id?: unknown } } } | null;
  if (!q || typeof q !== 'object' || typeof q.id !== 'string' || !q.id) return 'ignored';
  if (typeof q.data !== 'string' || !q.data.startsWith('tgv:')) return 'ignored';
  const reply = async (out: ViewOutcome, text: string) => {
    try { await deps.answer(q.id as string, text); } catch { deps.error('ANSWER_FAILED'); }
    return out;
  };
  const req = parseViewCallback(q.data);
  if (!req) return reply('unknown', 'unknown view');
  if (!isOwner(q.from, env)) return reply('denied', 'not allowed');
  const chatId = q.message?.chat?.id, messageId = q.message?.message_id;
  if (chatId === undefined || messageId === undefined) { deps.error('VIEW_NO_MESSAGE'); return reply('failed', 'failed, try again'); }
  let data: RenderData;
  try {
    const now = deps.now();
    if (!Number.isSafeInteger(now)) { deps.error('CLOCK_INVALID'); return reply('failed', 'failed, try again'); }
    const needsUnits = req.view !== 'post' && req.view !== 'menu';
    data = { units: needsUnits ? await deps.units() : [], post: req.view === 'post' ? await deps.latestPost() : null, now, redact: deps.redact };
  } catch { deps.error('VIEW_DATA_FAILED'); return reply('failed', 'failed, try again'); }
  let rendered: Rendered;
  try { rendered = renderView(req, data); } catch { deps.error('VIEW_RENDER_FAILED'); return reply('failed', 'failed, try again'); }
  try { await deps.edit(chatId, messageId, rendered); } catch { deps.error('VIEW_EDIT_FAILED'); return reply('failed', 'failed, try again'); }
  return reply('rendered', '');
}

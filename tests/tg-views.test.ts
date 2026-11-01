import assert from 'node:assert/strict';
import test from 'node:test';
import { computeTrackerLoad } from '../src/phase-contracts/tracker-load.ts';
import {
  TEXT_CAP, VIEW_IDS, handleViewCallback, menuView, parseViewCallback, renderView,
  type ViewDeps, type ViewPost, type ViewUnit,
} from '../src/server/tg-views.ts';

// TG-UI (owner t788u; tracker row TG-UI). Synthetic values only.
const NOW = Date.parse('2026-10-29T00:00:00Z'); // 09:00 KST
const h = (n: number) => new Date(NOW + n * 3_600_000).toISOString();
const units: ViewUnit[] = [
  { id: 'TG-UI', title: 'Telegram views', worker: 'claude', verifier: 'muse', status: 'CLAIMED', eta: { best: h(2), likely: h(4), worst: h(8) } },
  { id: 'SSU-GW-S2', title: 'SSU backend', worker: 'grok-cli', verifier: 'muse/dots', status: 'PUSHED', eta: { best: h(-6), likely: h(-4), worst: h(-2) } },
  { id: 'OWN-1', title: 'owner gate <b>x</b>', worker: 'grok', verifier: 'dots', status: 'GATED' },
  { id: 'BAD-ETA', worker: 'dots', verifier: 'muse', status: 'OPEN', eta: { best: h(5), likely: h(3), worst: h(4) } },
  { id: 'SELF', worker: 'claude', verifier: 'claude', status: 'OPEN' },
  { id: 'OLD', worker: 'muse', verifier: 'dots', status: 'MERGED' },
];
const buttons = (r: { reply_markup: { inline_keyboard: { callback_data: string }[][] } }) => r.reply_markup.inline_keyboard.flat().map(b => b.callback_data);

test('TG-UI menu: one button per view, every callback_data parses back to its view and fits 64 bytes', () => {
  const m = menuView();
  const data = buttons(m);
  assert.deepEqual(data.map(d => parseViewCallback(d)?.view).sort(), ['gantt', 'load', 'myq', 'post', 'tracker']);
  for (const d of data) assert.ok(new TextEncoder().encode(d).length <= 64, d);
  const longest = `tgv:unit:${'A'.repeat(48)}`;
  assert.deepEqual(parseViewCallback(longest), { view: 'unit', id: 'A'.repeat(48) });
  assert.ok(new TextEncoder().encode(longest).length <= 64);
  assert.equal(parseViewCallback(`tgv:unit:${'A'.repeat(49)}`), null);
  assert.equal(m.parse_mode, 'HTML');
});

test('TG-UI callback data: only the tgv: allowlist parses; approval data, junk and unsafe unit ids do not', () => {
  assert.deepEqual(parseViewCallback('tgv:unit:SSU-GW-S2'), { view: 'unit', id: 'SSU-GW-S2' });
  assert.deepEqual(parseViewCallback('tgv:menu'), { view: 'menu' });
  for (const bad of ['tga:abcdefghijklmnop:a', 'tgv:nope', 'tgv:tracker:x', 'tgv:unit:', 'tgv:unit:a b', 'tgv:unit:<b>', 'tgv:unit:' + 'A'.repeat(60), ' tgv:load', 'tgv:load\n', 42, null, undefined]) {
    assert.equal(parseViewCallback(bad), null, String(bad));
  }
  assert.deepEqual([...VIEW_IDS].sort(), ['gantt', 'load', 'menu', 'myq', 'post', 'tracker', 'unit']);
});

test('TG-UI tracker view: unit, owner and status per open unit, HTML-escaped, done units only counted', () => {
  const r = renderView({ view: 'tracker' }, { units, post: null, now: NOW });
  assert.match(r.text, /TG-UI.*claude.*CLAIMED/);
  assert.match(r.text, /SSU-GW-S2.*grok-cli.*PUSHED/);
  assert.doesNotMatch(r.text, /<b>x<\/b>/);
  assert.match(r.text, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(r.text, /\bOLD\b/);
  assert.match(r.text, /1 done/);
  assert.ok(buttons(r).includes('tgv:menu'));
});

test('TG-UI tracker view: 600 units stay under the text cap with a "more" line', () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ id: `U-${i}`, title: 'x'.repeat(40), worker: 'dots', verifier: 'muse', status: 'OPEN' }));
  const r = renderView({ view: 'tracker' }, { units: many, post: null, now: NOW });
  assert.ok(r.text.length <= TEXT_CAP, String(r.text.length));
  assert.match(r.text, /… \d+ more/);
});

test('TG-UI gantt view: deterministic bars at a fixed now, ETA best/likely/worst in KST, late and no-ETA units called out', () => {
  const r = renderView({ view: 'gantt' }, { units, post: null, now: NOW });
  assert.equal(r.text, renderView({ view: 'gantt' }, { units: [...units].reverse(), post: null, now: NOW }).text, 'input order must not matter');
  assert.match(r.text, /<pre>[\s\S]*<\/pre>/);
  assert.match(r.text, /TG-UI\s+[█▓░ ]+\s+b 11:00 \/ l 13:00 \/ w 17:00/);
  assert.match(r.text, /SSU-GW-S2.*LATE/);
  assert.match(r.text, /no ETA: BAD-ETA, OWN-1, SELF/);
  const bar = /TG-UI\s+([█▓░ ]+)/.exec(r.text)![1]!;
  assert.ok(bar.indexOf('█') < bar.indexOf('▓') && bar.indexOf('▓') < bar.indexOf('░'), bar);
});

test('TG-UI gantt view: rows run by likely ETA, not by id', () => {
  const two: ViewUnit[] = [
    { id: 'A-LATER', worker: 'dots', verifier: 'muse', status: 'OPEN', eta: { best: h(5), likely: h(6), worst: h(7) } },
    { id: 'Z-SOON', worker: 'dots', verifier: 'muse', status: 'OPEN', eta: { best: h(0.5), likely: h(1), worst: h(2) } },
  ];
  const t = renderView({ view: 'gantt' }, { units: two, post: null, now: NOW }).text;
  assert.ok(t.indexOf('Z-SOON') < t.indexOf('A-LATER'), t);
});

test('TG-UI load view: counts come from computeTrackerLoad (no guesses), percents over claimed agents, rejected rows reported', () => {
  const r = renderView({ view: 'load' }, { units, post: null, now: NOW });
  const load = computeTrackerLoad(units);
  for (const a of load.agents.filter(x => x.agent !== 'unknown')) {
    assert.match(r.text, new RegExp(`${a.agent}\\s+build ${a.build.open_total}\\s+review ${a.review.open_total}\\s+open ${a.open_total}\\s+\\d+%`));
  }
  const pct = [...r.text.matchAll(/(\d+)%/g)].map(m => Number(m[1]));
  const sum = pct.reduce((a, b) => a + b, 0);
  assert.ok(sum >= 98 && sum <= 102, String(pct));
  assert.match(r.text, /rejected 1/);
  assert.doesNotMatch(r.text, /\bSELF\b.*open/);
});

test('TG-UI my queue view: owner-gated units only, each with a unit-detail button', () => {
  const r = renderView({ view: 'myq' }, { units, post: null, now: NOW });
  assert.match(r.text, /OWN-1/);
  assert.doesNotMatch(r.text, /TG-UI|SSU-GW-S2/);
  assert.ok(buttons(r).includes('tgv:unit:OWN-1'));
  const empty = renderView({ view: 'myq' }, { units: units.filter(u => u.status !== 'GATED'), post: null, now: NOW });
  assert.match(empty.text, /nothing waiting on you/);
});

test('TG-UI unit detail view: fields of one unit; unknown id says so', () => {
  const r = renderView({ view: 'unit', id: 'TG-UI' }, { units, post: null, now: NOW });
  assert.match(r.text, /TG-UI/);
  assert.match(r.text, /worker: claude/);
  assert.match(r.text, /verifier: muse/);
  assert.match(r.text, /status: CLAIMED/);
  assert.match(r.text, /ETA b 10-29 11:00 \/ l 10-29 13:00 \/ w 10-29 17:00 KST/);
  assert.match(renderView({ view: 'unit', id: 'NOPE' }, { units, post: null, now: NOW }).text, /unknown unit NOPE/);
});

test('TG-UI room post view: text goes through the caller redactor before HTML escaping; no post says so', () => {
  const post: ViewPost = { id: 'm1', actor: 'agent:dots', createdAt: h(-1), text: 'pwd=hunter2 <i>hi</i>' };
  const r = renderView({ view: 'post' }, { units, post, now: NOW, redact: s => s.replace('hunter2', '[REDACTED]') });
  assert.doesNotMatch(r.text, /hunter2/);
  assert.match(r.text, /\[REDACTED\]/);
  assert.match(r.text, /&lt;i&gt;hi&lt;\/i&gt;/);
  assert.match(r.text, /agent:dots/);
  assert.match(renderView({ view: 'post' }, { units, post: null, now: NOW, redact: s => s }).text, /no room posts/);
  assert.throws(() => renderView({ view: 'post' }, { units, post, now: NOW }), /redact/);
});

test('TG-UI every view stays under the cap and carries the menu button', () => {
  for (const v of ['tracker', 'gantt', 'load', 'myq', 'post', 'menu'] as const) {
    const r = renderView({ view: v }, { units, post: null, now: NOW, redact: s => s });
    assert.ok(r.text.length <= TEXT_CAP, v);
    if (v !== 'menu') assert.ok(buttons(r).includes('tgv:menu'), v);
  }
});

// --- callback handler: parse -> owner (from.id only) -> load -> render -> edit -> answer ---
const env = { TELEGRAM_OWNER_USER_ID: '4242', TELEGRAM_OWNER_CHAT_ID: '9999' };
function deps(over: Partial<ViewDeps> = {}) {
  const calls = { units: 0, edits: [] as { chat: unknown; msg: unknown; text: string }[], answers: [] as string[], errors: [] as string[] };
  const d: ViewDeps = {
    units: async () => { calls.units++; return units; },
    latestPost: async () => null,
    redact: s => s,
    now: () => NOW,
    edit: async (chat, msg, r) => { calls.edits.push({ chat, msg, text: r.text }); },
    answer: async (_id, text) => { calls.answers.push(text); },
    error: code => { calls.errors.push(code); },
    ...over,
  };
  return { d, calls };
}
const cq = (from: unknown, data: unknown) => ({ id: 'cq1', from, data, message: { message_id: 7, chat: { id: 9999 } } });

test('TG-UI callback: owner tap renders the view in place and answers', async () => {
  const { d, calls } = deps();
  assert.equal(await handleViewCallback(cq({ id: 4242 }, 'tgv:load'), env, d), 'rendered');
  assert.equal(calls.edits.length, 1);
  assert.equal(calls.edits[0]!.chat, 9999);
  assert.equal(calls.edits[0]!.msg, 7);
  assert.match(calls.edits[0]!.text, /build \d+/);
  assert.equal(calls.answers.length, 1);
});

test('TG-UI callback: non-owner, chat-id-as-user and unset owner config are denied before any data is read', async () => {
  for (const [from, e] of [[{ id: 1 }, env], [{ id: 9999 }, env], [{ id: 4242 }, { TELEGRAM_OWNER_CHAT_ID: '4242' }], [{ id: '4242x' }, env], [undefined, env]] as const) {
    const { d, calls } = deps();
    assert.equal(await handleViewCallback(cq(from, 'tgv:tracker'), e, d), 'denied');
    assert.equal(calls.units, 0);
    assert.equal(calls.edits.length, 0);
    assert.deepEqual(calls.answers, ['not allowed']);
  }
});

test('TG-UI callback: unknown data is answered and nothing is read; approval data is ignored for the approval handler', async () => {
  const { d, calls } = deps();
  assert.equal(await handleViewCallback(cq({ id: 4242 }, 'tgv:nope'), env, d), 'unknown');
  assert.equal(calls.units, 0);
  assert.deepEqual(calls.answers, ['unknown view']);
  const second = deps();
  assert.equal(await handleViewCallback(cq({ id: 4242 }, 'tga:abcdefghijklmnop:a'), env, second.d), 'ignored');
  assert.equal(second.calls.answers.length, 0);
  assert.equal(await handleViewCallback(null, env, second.d), 'ignored');
});

test('TG-UI callback: a failing data read or edit is answered as failed and logged, never thrown', async () => {
  const a = deps({ units: async () => { throw new Error('d1 down'); } });
  assert.equal(await handleViewCallback(cq({ id: 4242 }, 'tgv:tracker'), env, a.d), 'failed');
  assert.deepEqual(a.calls.errors, ['VIEW_DATA_FAILED']);
  assert.deepEqual(a.calls.answers, ['failed, try again']);
  const b = deps({ edit: async () => { throw new Error('400'); } });
  assert.equal(await handleViewCallback(cq({ id: 4242 }, 'tgv:tracker'), env, b.d), 'failed');
  assert.deepEqual(b.calls.errors, ['VIEW_EDIT_FAILED']);
});

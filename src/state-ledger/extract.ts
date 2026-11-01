import type {
  DecisionRow,
  GateMention,
  PrState,
  RefEntry,
  RoomMessage,
  StateSnapshot,
  VerdictMention,
} from './types.ts';

// Extraction only. A verdict mention is recorded only for a *declared*
// verdict — this room's verdict posts declare PASS/FAIL, they do not bury it:
//
// - A post that leads with a PASS/FAIL declaration (after the "[Claude …]" /
//   "[Muse]" / "[Grok]" actor tag) verdicts the PR anchors in its lead
//   paragraph, with that polarity. Body text is then ignored for verdicts:
//   historical references and quoted verdicts later in the post never
//   override the lead declaration.
// - A token can also lead its anchor in the summary form
//   "FAIL on `1e5ea7e` (PR #7), PASS on `5e16268` (PR #8)": the token then
//   binds to the parenthesised anchor that follows it, with the sha named
//   in the same breath. This binding wins over a token after the anchor.
// - When every anchor in the lead segment carries its own summary-form
//   binding, the post IS a summary list even when it opens the post: the
//   per-anchor bindings (own polarity, own sha) win and the flat lead
//   polarity must not swallow the pair into the first token's verdict.
// - Otherwise a token counts only when it attaches to its own PR anchor —
//   directly after the anchor across separator characters only — and sits
//   before the next PR anchor. A bare anchor directly after "the"
//   ("the #90 FAIL") names an existing verdict record; it declares none.
// - A token followed by "requested" is a request, not a verdict, a
//   "PASS/FAIL" pair is a category label, not a verdict, and a token
//   followed by "멘션" is talk about a mention, not a verdict.
// - A token followed by "of record" names the verdict already on record —
//   a restatement, not a declaration — and a token inside a slash list
//   ("PASS/PARTIAL/FAIL") is a category enumeration, not a verdict.
// - An attached token inside a double-quoted span quotes another text (a
//   FAIL post quoting the headline it discusses declares nothing itself).
//   The summary form is exempt: quoted verbatim it still reproduces the
//   original declaration, and this room's reviewers restate verdicts that
//   way, so those duplicates stay — faithfully, polarity included.
// - An anchor and a token inside the same balanced-parenthesis span are
//   a parenthesised subject descriptor, not a declaration: the subject
//   "(PR #132 FAIL 잔여 1건 수리본)" names the unit under repair — the
//   repair OF one remaining FAIL item — it verdicts nothing.
// - The lead declaration may sit behind mention-only lines, the actor
//   tag and markdown emphasis: verdict posts open with a subject line
//   ("@dots @claude" on its own line, then "[Muse] **FAIL (scoped) —
//   PR #132 …**"), and that subject line carries the declaration.
// - An anchor directly after an indefinite article ("a PR #n TOKEN") names
//   a mention as a noun phrase, and an anchor directly after an arrow
//   ("x → PR #n TOKEN") states an extraction result; neither declares.
// - Posts that lead with PUSHED/DONE/CLAIM (author status), OWNER DECISION
//   or OWNER DIRECT, RETRACT, or an acknowledgement (ACK / 수신 확인 /
//   Receipt) never carry verdict mentions, and neither do thanks-led
//   relay posts, which record other agents' verdicts ("@claude thanks,
//   non-author PASS on … recorded").
// - A bare token whose own sentence disowns it declares nothing: a
//   question (the binding's sentence ends with '?'), a conditional (the
//   clause leads with If/만약, or the token is hedged "conditional on
//   …"), and a self-retraction ("no wait", "that is wrong", "not a
//   PASS") are the sentence itself saying the token is no declaration.
// - Relay and receipt framings never attribute a verdict to the relayer:
//   a receipt headline (수신 확인 / 접수 확인) anywhere in the first line,
//   a post that states it makes no new verdict, and a binding whose own
//   clause reports the verdict as received ("… FAIL … is received",
//   "… PASS — noted as received") all record another agent's verdict.
// - The recorded sha binds only near the declaration point — in the lead
//   segment for a lead declaration, in the "on `sha`" chain for the
//   summary form, or in a short window around a body anchor. A sha that
//   merely appears somewhere in the post (a message-reference ID, an
//   unrelated nearby head) is never attached to a verdict.
//
// The mention quotes the post; it is not a judgement by this tool, and a
// later post can supersede an earlier one — queries return every mention,
// newest first.

const PR_ANCHOR = /PR\s*#(\d+)/gi;
const BARE_ANCHOR = /#(\d+)\b/g;
const GATE_TOKEN = /\b(BLOCKED|HOLD)\b/;
const LOCAL_CI = /local CI|로컬 CI|test:all/i;
const FULL_SHA = /\b[0-9a-f]{40}\b/;
const SHORT_SHA = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,39}\b/;

const ACTOR_TAG = /^\s*\[(?:Claude[^\]]*|Muse|Grok)\]\s*/;
const NON_VERDICT_LEAD = /^\[?(PUSHED|DONE|CLAIM)\b/;
const OWNER_LEAD = /^\[?OWNER[ -](DECISION|DIRECT)\b/;
const RETRACT_LEAD = /^\[?RETRACT\b/;
const LEAD_VERDICT = /^\[?(PASS|FAIL)\b/;
// A body token attaches to its anchor only across separators (spaces,
// punctuation, markdown) — intervening words break the attachment.
const ATTACHED_TOKEN = /^[\s:;,.()\[\]"'`*·—–-]{0,32}(PASS|FAIL)\b/;
// The token-leading summary form: "FAIL on `1e5ea7e` (PR #7)" — the token,
// the word "on", the sha (backticked or bare), "(", then the anchor. The
// sha and the parenthesis are both required: a sha-less "PASS on PR #n"
// is how restatements and thanks are phrased ("thanks for the PASS on
// PR #28"), not how a verdict summary is written. Anchored at the end of
// the text before the anchor.
const PRECEDING_TOKEN = /\b(PASS|FAIL)\s+on\s+(?:`([0-9a-f]{7,40})`|([0-9a-f]{7,40}))\s*\(\s*$/;
// A token that is the second half of "PASS or FAIL on …" names a future
// or hypothetical outcome, not a declaration.
const PAIR_OR_BEFORE = /(PASS|FAIL)\s+or\s+$/i;
const PRECEDING_WINDOW = 64;
const DEFINITE_REF = /\bthe\s+$/i;
const LEAD_SEGMENT_CAP = 1200;
// sha binding windows around a declaration point (see header note).
const SHA_BEFORE = 120;
const SHA_AFTER = 200;
const LEAD_SHA_TAIL = 300;

export function excerpt(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function firstSha(text: string): string | null {
  const full = text.match(FULL_SHA);
  if (full) return full[0];
  const short = text.match(SHORT_SHA);
  return short ? short[0] : null;
}

// A verdict sha is read only inside the window around its declaration
// point, never from the post at large.
function shaNear(text: string, from: number, to: number): string | null {
  return firstSha(text.slice(Math.max(0, from), Math.min(text.length, to)));
}

function byTimeAsc(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

interface Anchor {
  pr: number;
  start: number;
  end: number; // index just past the anchor
  bare: boolean; // "#n" without the "PR" prefix
}

function findAnchors(text: string): Anchor[] {
  const out: Anchor[] = [];
  for (const match of text.matchAll(PR_ANCHOR)) {
    out.push({ pr: Number(match[1]), start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, bare: false });
  }
  for (const match of text.matchAll(BARE_ANCHOR)) {
    const start = match.index ?? 0;
    // a bare "#n" inside a "PR #n" anchor is the same anchor
    if (out.some((a) => start >= a.start && start < a.end)) continue;
    out.push({ pr: Number(match[1]), start, end: start + match[0].length, bare: true });
  }
  return out.sort((a, b) => a.start - b.start);
}

// A PASS/FAIL occurrence is a verdict token only when it is neither a
// request ("PASS requested"), nor half of a "PASS/FAIL" pair, nor part of
// a wider slash category list ("PASS/PARTIAL/FAIL"), nor a restatement of
// the verdict on record ("PASS of record stays"), nor meta-talk about a
// mention itself ("PASS 멘션으로 제시됨").
function tokenCounts(text: string, start: number, end: number): boolean {
  if (text[end] === '/' && /^(PASS|FAIL)\b/.test(text.slice(end + 1, end + 6))) return false;
  if (text[end] === '/') return false; // slash list continues: a category label
  if (text[start - 1] === '/') return false; // later item of a slash list
  if (/(PASS|FAIL)\/$/.test(text.slice(Math.max(0, start - 6), start))) return false;
  const after = text.slice(end, end + 12).replace(/^\]/, '');
  if (/^\s+requested/i.test(after)) return false;
  if (/^\s+of\s+record\b/i.test(after)) return false;
  if (/^\s*멘션/.test(after)) return false;
  return true;
}

function isAckHead(head: string): boolean {
  if (/^ACK\b/.test(head) || /^Receipt\b/i.test(head) || head.slice(0, 40).includes('수신 확인')) return true;
  // A receipt headline anywhere in the first line: a "[Muse watch] …
  // 접수 확인" headline sits behind the actor tag and @mentions, past
  // the 40-char prefix window the check above covers.
  const firstLine = head.split('\n', 1)[0] ?? '';
  return firstLine.includes('수신 확인') || firstLine.includes('접수 확인');
}

// A post that states it makes no new verdict declares none — the verdict
// tokens it carries are the other agents' verdicts it records.
const NO_NEW_VERDICT = /no new (?:review )?verdict/i;

// A binding whose own clause reports the verdict as received is a
// receipt of another agent's verdict, not the reporter's declaration.
function receiptTrailing(text: string, tokenEnd: number): boolean {
  const rest = text.slice(tokenEnd, tokenEnd + 96);
  const cut = rest.search(/[.!?\n]/);
  const clause = cut === -1 ? rest : rest.slice(0, cut);
  return /\b(?:is|as) received\b/i.test(clause);
}

// Whether the sentence carrying a body binding disowns its token (see
// the header note): interrogative, conditional or self-retracted. The
// sentence runs from the previous terminator before the anchor to the
// next terminator after the token.
function sentenceDisowns(text: string, anchorStart: number, tokenEnd: number): boolean {
  const before = text.slice(0, anchorStart);
  const start = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n')) + 1;
  const rest = text.slice(tokenEnd);
  const rel = rest.search(/[.!?]/);
  const terminator = rel === -1 ? '' : (rest[rel] as string);
  if (terminator === '?') return true;
  if (/^\s*(?:if|만약)\b/i.test(text.slice(start, anchorStart))) return true;
  const tail = rel === -1 ? rest : rest.slice(0, rel);
  return /\bconditional on\b/i.test(tail) || /\bno wait\b/i.test(tail) || /\bthat is wrong\b/i.test(tail) || /\bnot a (?:PASS|FAIL)\b/i.test(tail);
}

// A post that opens by thanking (after any leading @mentions) is a relay:
// it records verdicts other agents gave, it declares none itself. The
// ACK lead above is deliberately NOT extended the same way — this room's
// "@claude ACK" posts include the author's own logged verdicts (f867f287,
// self-described in the author's correction 28cb09f4), while its thanks
// posts only ever relay.
const MENTION_LEAD = /^(\s*@\S+\s+)+/;
function isThanksHead(head: string): boolean {
  return /^thanks\b/i.test(head.replace(MENTION_LEAD, ''));
}

// Double-quoted spans, paired in order, capped in length: an unpaired or
// runaway quote does not swallow the rest of the post.
const QUOTE_SPAN_CAP = 500;
function quotedSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"') continue;
    if (open === -1) {
      open = i;
    } else {
      if (i - open <= QUOTE_SPAN_CAP) spans.push({ start: open, end: i });
      open = -1;
    }
  }
  return spans;
}

// Balanced-parenthesis spans (nested spans included; an unclosed paren
// opens no span).
function parenSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const open: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') open.push(i);
    else if (text[i] === ')') {
      const start = open.pop();
      if (start !== undefined) spans.push({ start, end: i });
    }
  }
  return spans;
}

const MENTION_ONLY_LINE = /^\s*(@\S+\s*)+$/;

// The text the lead declaration is read from: the raw head first (current
// behaviour), then the subject line — the post with leading mention-only
// lines dropped and the actor tag, leading @mentions and markdown
// emphasis stripped from the first content line.
function subjectLine(text: string): string {
  const lines = text.replace(ACTOR_TAG, '').split('\n');
  let i = 0;
  while (i < lines.length && MENTION_ONLY_LINE.test(lines[i] ?? '')) i++;
  return lines
    .slice(i)
    .join('\n')
    .replace(ACTOR_TAG, '')
    .replace(MENTION_LEAD, '')
    .replace(ACTOR_TAG, '')
    .replace(/^\*+/, '');
}

function matchLead(s: string): RegExpMatchArray | null {
  const m = s.match(LEAD_VERDICT);
  if (!m) return null;
  const at = m.index ?? 0;
  return tokenCounts(s, at, at + m[0].length) ? m : null;
}

interface SummaryBinding {
  verdict: 'PASS' | 'FAIL';
  sha: string | null;
  tokenStart: number;
  tokenEnd: number;
}

// The token-leading summary binding for one anchor — "FAIL on `1e5ea7e`
// (PR #7)" — or null when the text before the anchor has no such form.
function summaryBinding(text: string, a: Anchor): SummaryBinding | null {
  const sliceStart = Math.max(0, a.start - PRECEDING_WINDOW);
  const before = text.slice(sliceStart, a.start);
  const pm = before.match(PRECEDING_TOKEN);
  if (!pm || !pm[1]) return null;
  const tokenStart = sliceStart + (pm.index ?? 0);
  if (PAIR_OR_BEFORE.test(before.slice(0, pm.index ?? 0))) return null;
  if (!tokenCounts(text, tokenStart, tokenStart + pm[1].length)) return null;
  const sha = pm[2] ?? pm[3] ?? shaNear(text, a.start - SHA_BEFORE, a.end + SHA_AFTER);
  return { verdict: pm[1] as 'PASS' | 'FAIL', sha, tokenStart, tokenEnd: tokenStart + pm[1].length };
}

export function extractVerdicts(messages: RoomMessage[]): VerdictMention[] {
  const out: VerdictMention[] = [];
  for (const m of messages) {
    const head = m.text.replace(ACTOR_TAG, '');
    if (NON_VERDICT_LEAD.test(head) || OWNER_LEAD.test(head) || RETRACT_LEAD.test(head) || isAckHead(head) || isThanksHead(head) || NO_NEW_VERDICT.test(m.text)) continue;
    const anchors = findAnchors(m.text);
    if (anchors.length === 0) continue;
    const found = new Map<number, { verdict: 'PASS' | 'FAIL'; sha: string | null }>(); // pr -> first declaration wins
    const lead = matchLead(head) ?? matchLead(subjectLine(m.text));
    const blank = m.text.search(/\n\s*\n/);
    const leadEnd = Math.min(blank === -1 ? m.text.length : blank, LEAD_SEGMENT_CAP);
    // A post whose lead segment is entirely summary-form bindings is a
    // summary list, not a lead declaration (see the header note).
    const summaryLed =
      lead !== null &&
      anchors.some((a) => a.start < leadEnd) &&
      anchors.filter((a) => a.start < leadEnd).every((a) => summaryBinding(m.text, a) !== null);
    if (lead && !summaryLed) {
      // Lead declaration: verdicts the PR anchors in the lead paragraph
      // (first paragraph, capped) with the declared polarity, and nothing
      // else in the post — body references never override it.
      const sha = shaNear(m.text, 0, leadEnd + LEAD_SHA_TAIL);
      for (const a of anchors) {
        if (a.start < leadEnd && !found.has(a.pr)) found.set(a.pr, { verdict: lead[1] as 'PASS' | 'FAIL', sha });
      }
    } else {
      // Body declarations: a token counts for its own anchor only, either
      // leading it in the summary form or attached directly after it, and
      // sitting before the next anchor.
      const spans = quotedSpans(m.text);
      const parens = parenSpans(m.text);
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i] as Anchor;
        if (found.has(a.pr)) continue;
        // "the #90 FAIL" names an existing verdict record; it is a
        // reference inside a sentence, not a fresh declaration.
        if (a.bare && DEFINITE_REF.test(m.text.slice(Math.max(0, a.start - 8), a.start))) continue;
        // "a PR #160 PASS" names a mention as a noun phrase (the object of
        // "produces", "gives", …), and "x → PR #60 PASS" states what an
        // extraction yields; neither is the post declaring a verdict.
        const beforeAnchor = m.text.slice(Math.max(0, a.start - 24), a.start);
        if (/\b(?:a|an)\s+$/i.test(beforeAnchor) || /(?:→|->)\s*$/.test(beforeAnchor)) continue;
        // Token-leading summary form: "FAIL on `1e5ea7e` (PR #7)".
        const sb = summaryBinding(m.text, a);
        if (sb && !receiptTrailing(m.text, sb.tokenEnd) && !sentenceDisowns(m.text, a.start, sb.tokenEnd)) {
          found.set(a.pr, { verdict: sb.verdict, sha: sb.sha });
          continue;
        }
        // An attached token inside a quoted span quotes another text; the
        // summary form above still counts there (see header note).
        if (spans.some((s) => a.start > s.start && a.start < s.end)) continue;
        const boundary = i + 1 < anchors.length ? (anchors[i + 1] as Anchor).start : m.text.length;
        const gap = m.text.slice(a.end, boundary);
        const t = gap.match(ATTACHED_TOKEN);
        if (!t) continue;
        const tokenText = t[1] ?? '';
        if (!tokenText) continue;
        const tokenStart = a.end + (t[0] ?? '').length - tokenText.length;
        // Anchor and token inside the same parenthesis span are a
        // parenthesised subject descriptor (the unit under repair), not
        // a declaration — see the header note.
        if (parens.some((s) => a.start > s.start && tokenStart < s.end)) continue;
        if (!tokenCounts(m.text, tokenStart, tokenStart + tokenText.length)) continue;
        if (receiptTrailing(m.text, tokenStart + tokenText.length)) continue;
        if (sentenceDisowns(m.text, a.start, tokenStart + tokenText.length)) continue;
        const sha = shaNear(m.text, a.start - SHA_BEFORE, tokenStart + tokenText.length + SHA_AFTER);
        found.set(a.pr, { verdict: tokenText as 'PASS' | 'FAIL', sha });
      }
    }
    for (const [pr, entry] of found) {
      out.push({
        pr,
        verdict: entry.verdict,
        messageId: m.id,
        actor: m.actor_id,
        at: m.created_at,
        sha: entry.sha,
        localCi: LOCAL_CI.test(m.text),
        excerpt: excerpt(m.text),
      });
    }
  }
  // Within one post the mentions are emitted in PR order, so the output
  // is canonical and does not depend on the order bindings happened to
  // be found in (a summary pair binds in text order either way).
  return out.sort(
    (a, b) =>
      byTimeAsc(a.at, b.at) ||
      (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0) ||
      a.pr - b.pr,
  );
}

// A gate mention counts only when BLOCKED/HOLD leads the post (first
// GATE_LEAD_WINDOW chars): status posts in this room open with their state,
// while the same words quoted mid-text (scope notes, recaps) are not gates.
const GATE_LEAD_WINDOW = 120;

export function extractGates(messages: RoomMessage[], decisions: DecisionRow[]): GateMention[] {
  const out: GateMention[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    const g = m.text.slice(0, GATE_LEAD_WINDOW).match(GATE_TOKEN);
    if (!g) continue;
    const kind = g[1] as 'BLOCKED' | 'HOLD';
    const key = `room:${m.id}:${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const prMatch = m.text.match(/PR\s*#(\d+)/i);
    out.push({
      kind,
      source: 'room',
      ref: m.id,
      actor: m.actor_id,
      at: m.created_at,
      pr: prMatch ? Number(prMatch[1]) : null,
      excerpt: excerpt(m.text),
    });
  }
  for (const d of decisions) {
    const g = `${d.decision} ${d.reason}`.slice(0, GATE_LEAD_WINDOW).match(GATE_TOKEN);
    if (!g) continue;
    const kind = g[1] as 'BLOCKED' | 'HOLD';
    const key = `decisions:${d.ts}:${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind,
      source: 'decisions',
      ref: d.ts,
      actor: d.owner,
      at: d.ts,
      pr: null,
      excerpt: excerpt(d.decision),
    });
  }
  // newest first; decision timestamps carry +09:00 offsets, so compare parsed times
  return out.sort((a, b) => byTimeAsc(b.at ?? '', a.at ?? '') || (a.ref < b.ref ? 1 : -1));
}

// ---------- queries over a built snapshot ----------

export interface PrAnswer {
  number: number;
  pr: PrState | null;
  evidence: { prSource: 'gh'; headSha: string | null };
  branch: RefEntry | null;
  verdicts: VerdictMention[];
  localCi: VerdictMention[];
}

export function queryPr(snap: StateSnapshot, n: number): PrAnswer {
  const pr = snap.prs.find((p) => p.number === n) ?? null;
  const verdicts = snap.verdicts
    .filter((v) => v.pr === n)
    .sort((a, b) => byTimeAsc(b.at, a.at) || (a.messageId < b.messageId ? 1 : -1));
  const branch = pr
    ? (snap.refs.find((r) => r.name === `refs/heads/${pr.headRefName}`) ?? null)
    : null;
  return {
    number: n,
    pr,
    evidence: { prSource: 'gh', headSha: pr?.headRefOid ?? null },
    branch,
    verdicts,
    localCi: verdicts.filter((v) => v.localCi),
  };
}

export interface BranchAnswer {
  name: string; // short branch name
  ref: RefEntry | null;
  prs: PrState[];
  evidence: { refSource: 'git-ls-remote'; sha: string | null };
}

export function queryBranch(snap: StateSnapshot, name: string): BranchAnswer {
  const full = name.startsWith('refs/') ? name : `refs/heads/${name}`;
  const short = full.replace(/^refs\/heads\//, '');
  const ref = snap.refs.find((r) => r.name === full) ?? null;
  return {
    name: short,
    ref,
    prs: snap.prs.filter((p) => p.headRefName === short),
    evidence: { refSource: 'git-ls-remote', sha: ref?.sha ?? null },
  };
}

export function queryOpenGates(snap: StateSnapshot): GateMention[] {
  return [...snap.gates];
}

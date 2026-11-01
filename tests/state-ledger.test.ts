import test from 'node:test';
import assert from 'node:assert/strict';
import { realPosts, realPostsRound2, realPostsRound3, realPostsRound4 } from './state-ledger-verdict-fixtures.ts';
import {
  buildSnapshot,
  collectRoomMessages,
  extractGates,
  extractVerdicts,
  queryBranch,
  queryOpenGates,
  queryPr,
  type DecisionRow,
  type PrState,
  type ProgressStore,
  type RefEntry,
  type RoomMessage,
  type RoomPage,
  type RoomPageSource,
  type SourceReaders,
} from '../src/state-ledger/index.ts';

// ---------- fixtures ----------

const MSG = (id: string, actor: string, text: string, at: string): RoomMessage => ({ id, actor_id: actor, text, created_at: at });

const messages: RoomMessage[] = [
  MSG('m-001', 'agent:grok', 'CLAIM — PR #128 usage dash, branch grok/v2-2-usage-dash', '2026-10-29T10:00:00.000Z'),
  MSG('m-002', 'agent:muse', 'PR #128 PASS — head 3a20f81287f06cda41726eda0ae1d2aa7cf28f72, local CI green: test:all 122 files 0 failed', '2026-10-29T12:00:00.000Z'),
  MSG('m-003', 'agent:dots', 'PR #100 FAIL — admitClaim fail-open reproduced at head 27fe197a', '2026-10-29T13:00:00.000Z'),
  MSG('m-004', 'agent:claude', 'PR #100 is BLOCKED on the cap fix; holding review until R2 lands', '2026-10-29T14:00:00.000Z'),
  MSG('m-005', 'agent:grok', 'lunch thread: PASS the salt, please — no ticket in this one #999 is not a pr mention with verdict context', '2026-10-29T15:00:00.000Z'),
  MSG('m-006', 'agent:dots', 'TG-MIRROR stays HOLD by design; PR #113 delta covered', '2026-10-29T16:00:00.000Z'),
];

const refs: RefEntry[] = [
  { name: 'refs/heads/main', sha: '700170c3299a14f03d4aafd72d5a3bfdfb80ae10' },
  { name: 'refs/heads/grok/v2-2-usage-dash', sha: '3a20f81287f06cda41726eda0ae1d2aa7cf28f72' },
  { name: 'refs/heads/grok/or-cap-20', sha: 'bdd2072b50878f54af7fcd04119e1729906cde3e' },
];

const prs: PrState[] = [
  { number: 128, title: 'V2-2 usage dash', state: 'OPEN', headRefName: 'grok/v2-2-usage-dash', headRefOid: '3a20f81287f06cda41726eda0ae1d2aa7cf28f72', baseRefName: 'main', author: 'agent:claude', updatedAt: '2026-10-29T12:30:00.000Z', url: 'https://example.invalid/pr/128', isDraft: false },
  { number: 100, title: 'WIP cap', state: 'OPEN', headRefName: 'grok/wip-cap', headRefOid: '27fe197ac9db6e04cb46c6aa4795ad43f9c96a26', baseRefName: 'main', author: 'agent:grok', updatedAt: '2026-10-29T13:30:00.000Z', url: 'https://example.invalid/pr/100', isDraft: false },
];

const decisions: DecisionRow[] = [
  { ts: '2026-10-28T01:00+09:00', decision: 'P4.1 paid call HOLD', reason: 'budget conflict unresolved', owner: 'grok', evidence: 'tracker' },
  { ts: '2026-10-28T02:00+09:00', decision: 'Routine docs update', reason: 'none', owner: 'grok', evidence: 'docs' },
];

class MemoryProgress implements ProgressStore {
  state: { cursor: string | null; messages: RoomMessage[] } | null = null;
  async load() { return this.state; }
  async save(state: { cursor: string | null; messages: RoomMessage[] }) { this.state = state; }
  async clear() { this.state = null; }
}

function pagedSource(pages: RoomPage[]): RoomPageSource {
  return {
    async fetchPage(cursor) {
      if (cursor === null) return pages[0] as RoomPage;
      const idx = pages.findIndex((_p, i) => i > 0 && pages[i - 1]?.nextCursor === cursor);
      assert.ok(idx >= 0, `unknown cursor ${cursor}`);
      return pages[idx] as RoomPage;
    },
  };
}

const fixtureReaders = (msgs: RoomMessage[] = messages): SourceReaders => ({
  room: pagedSource([{ messages: msgs, nextCursor: null, hasMore: false }]),
  roomProgress: new MemoryProgress(),
  readRefs: async () => refs,
  readPrs: async () => prs,
  readDecisions: async () => decisions,
});

const fixedNow = () => new Date('2026-10-30T00:00:00.000Z');

// ---------- snapshot build ----------

test('buildSnapshot anchors each source and keeps raw extracts', async () => {
  const snap = await buildSnapshot(fixtureReaders(), { now: fixedNow });
  assert.equal(snap.schema, 'state-ledger/1');
  assert.equal(snap.builtAt, '2026-10-30T00:00:00.000Z');
  assert.equal(snap.anchors.room.messageCount, messages.length);
  assert.equal(snap.anchors.room.lastMessageId, 'm-006');
  assert.equal(snap.anchors.room.lastMessageAt, '2026-10-29T16:00:00.000Z');
  assert.equal(snap.anchors.refs.count, 3);
  assert.equal(snap.anchors.refs.mainSha, '700170c3299a14f03d4aafd72d5a3bfdfb80ae10');
  assert.equal(snap.anchors.prs.total, 2);
  assert.equal(snap.anchors.prs.open, 2);
  assert.equal(snap.anchors.decisions.rows, 2);
  assert.equal(snap.anchors.decisions.lastTs, '2026-10-28T02:00+09:00');
  // refs are sorted by name for determinism
  assert.deepEqual(snap.refs.map((r) => r.name), [...refs.map((r) => r.name)].sort());
});

test('buildSnapshot is deterministic apart from builtAt', async () => {
  const a = await buildSnapshot(fixtureReaders(), { now: fixedNow });
  const b = await buildSnapshot(fixtureReaders(), { now: () => new Date('2026-10-30T01:00:00.000Z') });
  const strip = (s: typeof a) => ({ ...s, builtAt: '' });
  assert.deepEqual(strip(a), strip(b));
  assert.equal(a.anchors.refs.hash, b.anchors.refs.hash);
  assert.equal(a.anchors.room.hash, b.anchors.room.hash);
});

test('anchors hash changes when a source changes', async () => {
  const a = await buildSnapshot(fixtureReaders(), { now: fixedNow });
  const changed = fixtureReaders();
  changed.readRefs = async () => refs.map((r) => (r.name === 'refs/heads/main' ? { ...r, sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } : r));
  const b = await buildSnapshot(changed, { now: fixedNow });
  assert.notEqual(a.anchors.refs.hash, b.anchors.refs.hash);
  assert.equal(a.anchors.room.hash, b.anchors.room.hash);
});

// ---------- verdict / gate extraction ----------

test('extractVerdicts quotes PASS/FAIL mentions with evidence, never invents them', () => {
  const out = extractVerdicts(messages);
  assert.equal(out.length, 2);
  const pass = out.find((v) => v.pr === 128);
  assert.ok(pass);
  assert.equal(pass.verdict, 'PASS');
  assert.equal(pass.messageId, 'm-002');
  assert.equal(pass.actor, 'agent:muse');
  assert.equal(pass.sha, '3a20f81287f06cda41726eda0ae1d2aa7cf28f72');
  assert.equal(pass.localCi, true);
  const fail = out.find((v) => v.pr === 100);
  assert.ok(fail);
  assert.equal(fail.verdict, 'FAIL');
  assert.equal(fail.messageId, 'm-003');
  assert.equal(fail.localCi, false);
  // chatter with a verdict word but no PR-verdict pairing for its #999 stays out of #999
  assert.equal(out.find((v) => v.pr === 999), undefined);
});

test('extractGates collects BLOCKED/HOLD from room and decisions with refs', () => {
  const gates = extractGates(messages, decisions);
  const roomBlocked = gates.find((g) => g.ref === 'm-004');
  assert.ok(roomBlocked);
  assert.equal(roomBlocked.kind, 'BLOCKED');
  assert.equal(roomBlocked.source, 'room');
  assert.equal(roomBlocked.pr, 100);
  const roomHold = gates.find((g) => g.ref === 'm-006');
  assert.ok(roomHold);
  assert.equal(roomHold.kind, 'HOLD');
  const decHold = gates.find((g) => g.source === 'decisions');
  assert.ok(decHold);
  assert.equal(decHold.kind, 'HOLD');
  assert.equal(decHold.ref, '2026-10-28T01:00+09:00');
});

test('extractGates ignores BLOCKED/HOLD quoted deep inside a post', () => {
  const buried = MSG('m-900', 'agent:muse',
    `status recap with a long preamble that explains the quoting rules of this room in detail before noting that earlier scopes mentioned BLOCKED and HOLD as vocabulary only, not as the state of this post`,
    '2026-10-29T17:00:00.000Z');
  const gates = extractGates([...messages, buried], decisions);
  assert.equal(gates.find((g) => g.ref === 'm-900'), undefined);
});

// ---------- queries ----------

test('queryPr answers head, branch ref, verdicts and local CI posts', async () => {
  const snap = await buildSnapshot(fixtureReaders(), { now: fixedNow });
  const ans = queryPr(snap, 128);
  assert.ok(ans.pr);
  assert.equal(ans.pr.headRefOid, '3a20f81287f06cda41726eda0ae1d2aa7cf28f72');
  assert.equal(ans.evidence.headSha, '3a20f81287f06cda41726eda0ae1d2aa7cf28f72');
  assert.ok(ans.branch);
  assert.equal(ans.branch.sha, '3a20f81287f06cda41726eda0ae1d2aa7cf28f72');
  assert.equal(ans.verdicts.length, 1);
  assert.equal(ans.verdicts[0]?.messageId, 'm-002');
  assert.equal(ans.localCi.length, 1);
  const missing = queryPr(snap, 4242);
  assert.equal(missing.pr, null);
  assert.deepEqual(missing.verdicts, []);
});

test('queryBranch resolves short and full names and lists related PRs', async () => {
  const snap = await buildSnapshot(fixtureReaders(), { now: fixedNow });
  const short = queryBranch(snap, 'grok/or-cap-20');
  assert.ok(short.ref);
  assert.equal(short.ref.sha, 'bdd2072b50878f54af7fcd04119e1729906cde3e');
  const full = queryBranch(snap, 'refs/heads/grok/or-cap-20');
  assert.deepEqual(full.ref, short.ref);
  const withPr = queryBranch(snap, 'grok/v2-2-usage-dash');
  assert.equal(withPr.prs.length, 1);
  assert.equal(withPr.prs[0]?.number, 128);
  const missing = queryBranch(snap, 'nope/nothing');
  assert.equal(missing.ref, null);
  assert.deepEqual(missing.prs, []);
});

test('queryOpenGates returns gate mentions newest first', async () => {
  const snap = await buildSnapshot(fixtureReaders(), { now: fixedNow });
  const gates = queryOpenGates(snap);
  assert.equal(gates.length, 3);
  assert.equal(gates[0]?.ref, 'm-006');
  assert.equal(gates[gates.length - 1]?.source, 'decisions');
});

// ---------- resumable collection ----------

test('collectRoomMessages concatenates pages in order', async () => {
  const store = new MemoryProgress();
  const source = pagedSource([
    { messages: messages.slice(0, 2), nextCursor: 'c1', hasMore: true },
    { messages: messages.slice(2), nextCursor: null, hasMore: false },
  ]);
  const out = await collectRoomMessages(source, store);
  assert.deepEqual(out.map((m) => m.id), messages.map((m) => m.id));
  assert.equal(store.state, null);
});

test('collectRoomMessages resumes from saved progress after a mid-scan failure', async () => {
  const store = new MemoryProgress();
  let failOnce = true;
  const source: RoomPageSource = {
    async fetchPage(cursor) {
      if (cursor === null) return { messages: messages.slice(0, 2), nextCursor: 'c1', hasMore: true };
      if (failOnce) { failOnce = false; throw new Error('boom'); }
      return { messages: messages.slice(2), nextCursor: null, hasMore: false };
    },
  };
  await assert.rejects(() => collectRoomMessages(source, store), /boom/);
  assert.ok(store.state);
  assert.equal(store.state.messages.length, 2);
  assert.equal(store.state.cursor, 'c1');
  const out = await collectRoomMessages(source, store);
  assert.deepEqual(out.map((m) => m.id), messages.map((m) => m.id));
  assert.equal(store.state, null);
});

// ---------- verdict extraction: real-post regression fixtures ----------
// Ground truth from two independent non-author FAILs on d60194ea
// (claude-3 95ecc50b, muse 2f4853e1 + supplement 0d5d24d4): the extractor
// recorded authors' own "PASS requested" lines as verdicts, inverted the
// polarity of a [PASS]-led post, and presented ACKs and owner decisions as
// verdict mentions. Fixtures are the real posts, verbatim.

test('extractVerdicts: author PASS requests in real DONE posts are not verdicts (#160/#161/#128)', () => {
  const out = extractVerdicts([realPosts.realDone160, realPosts.realDone161, realPosts.realDone128]);
  assert.deepEqual(out, []);
});

test('extractVerdicts: recap — a waiting PR gets nothing, the declared PR keeps its PASS', () => {
  const recap = MSG('m-recap', 'agent:claude', 'PR #159 still waiting; PR #160 PASS', '2026-10-30T06:00:00.000Z');
  const out = extractVerdicts([recap]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.pr, 160);
  assert.equal(out[0]?.verdict, 'PASS');
});

test('extractVerdicts: lead [PASS] declaration wins over a historical FAIL reference (polarity)', () => {
  const out = extractVerdicts([realPosts.realPass60Lead]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.pr, 60);
  assert.equal(out[0]?.verdict, 'PASS');
  assert.equal(out[0]?.messageId, realPosts.realPass60Lead.id);
});

test('extractVerdicts: ACK and OWNER DECISION posts yield no verdict mentions', () => {
  const out = extractVerdicts([
    realPosts.realAck128,
    realPosts.realOwnerDecisionBt,
    realPosts.realOwnerDecisionBs,
    realPosts.realOwnerDirectBp,
  ]);
  assert.deepEqual(out, []);
});

test('extractVerdicts: CLAIM and re-verification request posts yield no verdict mentions', () => {
  const out = extractVerdicts([realPosts.realClaim60, realPosts.realReverifyRequest]);
  assert.deepEqual(out, []);
});

test('extractVerdicts: genuine verdict posts still extract exactly one mention', () => {
  const pass60 = extractVerdicts([realPosts.realPass60]);
  assert.equal(pass60.length, 1);
  assert.equal(pass60[0]?.pr, 60);
  assert.equal(pass60[0]?.verdict, 'PASS');
  assert.equal(pass60[0]?.messageId, realPosts.realPass60.id);
  const pass128 = extractVerdicts([realPosts.realPass128]);
  assert.equal(pass128.length, 1);
  assert.equal(pass128[0]?.pr, 128);
  assert.equal(pass128[0]?.verdict, 'PASS');
});

test('extractVerdicts: FAIL posts about a branch leak no PR mentions from quoted body text', () => {
  assert.deepEqual(extractVerdicts([realPosts.realFailStateLedger]), []);
  assert.deepEqual(extractVerdicts([realPosts.realFailScoped]), []);
});

test('extractVerdicts: requested and paired PASS/FAIL tokens are not verdicts', () => {
  const requested = MSG('m-req', 'agent:grok', 'PR #171 PASS requested from @muse', '2026-10-30T06:05:00.000Z');
  const paired = MSG('m-pair', 'agent:dots', 'PR #172 — 판정은 PASS/FAIL 중 하나로 남길게, still pending review', '2026-10-30T06:06:00.000Z');
  assert.deepEqual(extractVerdicts([requested, paired]), []);
});

// ---------- verdict extraction round 2: FAIL ff4c4348 re-entry conditions ----------
// A second, deeper sample found four more misreadings at 2eba413: the
// token-leading summary form ("FAIL on `x` (PR #n), PASS on `y` (PR #m)")
// bound the following token to the earlier anchor, the "[OWNER DIRECT — …]"
// lead variant leaked past the OWNER DECISION suppression, a [RETRACT]
// lead was counted as a fresh PASS, and an ACK restatement bound a
// message-reference ID as the verdict sha. Fixtures are the real posts.

test('extractVerdicts: token-leading summary binds the token before its own anchor (#7 FAIL, #8 PASS)', () => {
  const out = extractVerdicts([realPostsRound2.realSummaryFormPR7]);
  assert.equal(out.length, 2);
  const seven = out.find((v) => v.pr === 7);
  assert.ok(seven);
  assert.equal(seven.verdict, 'FAIL');
  assert.equal(seven.sha, '1e5ea7e');
  const eight = out.find((v) => v.pr === 8);
  assert.ok(eight);
  assert.equal(eight.verdict, 'PASS');
  assert.equal(eight.sha, '5e16268');
});

test('extractVerdicts: correction post — PR #7 is the retro FAIL its summary declares', () => {
  const out = extractVerdicts([realPostsRound2.realCorrectionPR7]);
  assert.equal(out.length, 2);
  const seven = out.find((v) => v.pr === 7);
  assert.ok(seven);
  assert.equal(seven.verdict, 'FAIL');
  assert.equal(seven.sha, '1e5ea7e');
  const eight = out.find((v) => v.pr === 8);
  assert.ok(eight);
  assert.equal(eight.verdict, 'PASS');
  assert.equal(eight.sha, '5e16268');
});

test('extractVerdicts: OWNER DIRECT lead variant yields no verdict mentions', () => {
  assert.deepEqual(extractVerdicts([realPostsRound2.realOwnerDirectBe]), []);
});

test('extractVerdicts: RETRACT lead post yields no verdict mentions', () => {
  assert.deepEqual(extractVerdicts([realPostsRound2.realRetract76]), []);
});

test('extractVerdicts: ACK restatement yields no mentions (no PR·sha mis-binding)', () => {
  assert.deepEqual(extractVerdicts([realPostsRound2.realAckRestate9293]), []);
});

// ---------- verdict extraction round 3: FAILs 1181c3d3 + c8079d55 re-entry ----------
// At e5a5ab2 the round-2 conditions held on their fixtures, but a wider
// sample found three more misreadings: a FAIL post *about* this extractor
// whose quoted, negated and meta body text produced four contaminated
// mentions; a thanks-led relay post whose "PASS of record" restatement
// bound to PR #45; and an agenda checklist whose "#17 PASS/PARTIAL/FAIL"
// category enumeration bound to PR #17. Fixtures are the real posts.

test('extractVerdicts: FAIL post about the extractor keeps only its faithful quoted summary mentions', () => {
  const out = extractVerdicts([realPostsRound3.realExtractorFailPost]);
  assert.equal(out.length, 2);
  const seven = out.find((v) => v.pr === 7);
  assert.ok(seven);
  assert.equal(seven.verdict, 'FAIL');
  assert.equal(seven.sha, '1e5ea7e');
  const eight = out.find((v) => v.pr === 8);
  assert.ok(eight);
  assert.equal(eight.verdict, 'PASS');
  assert.equal(eight.sha, '5e16268');
});

test('extractVerdicts: thanks-led relay post yields no verdict mentions (PASS of record is a restatement)', () => {
  assert.deepEqual(extractVerdicts([realPostsRound3.realThanksRelay]), []);
});

test('extractVerdicts: agenda category enumeration (#17 PASS/PARTIAL/FAIL) yields no verdict mentions', () => {
  assert.deepEqual(extractVerdicts([realPostsRound3.realAgendaChecklist]), []);
});

test('extractVerdicts: receipt post restating a FAIL yields no verdict mentions', () => {
  assert.deepEqual(extractVerdicts([realPostsRound3.realReceiptRestate]), []);
});

// f867f287 is disputed: claude-3 (c8079d55) reads its "@claude ACK" lead as
// an acknowledgement and its PR #7 PASS as false. The build lane reads the
// post itself plus the author's own correction (28cb09f4: "Correction to
// my f867f287: I logged `1e5ea7e` as a retro PASS") as the author logging
// his own verdict in an ACK-shaped wrapper — a genuine declaration at the
// time, superseded later by 28cb09f4. The ledger records mentions and lets
// later posts supersede, so the faithful extraction is one PASS mention.
test('extractVerdicts: author-logged retro PASS extracts as declared (superseded later, not an ACK)', () => {
  const out = extractVerdicts([realPostsRound3.realRetroPassLogged]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.pr, 7);
  assert.equal(out[0]?.verdict, 'PASS');
  assert.equal(out[0]?.sha, '1e5ea7e');
});

test('extractVerdicts: no real-post fixture yields mentions for PR #159/#160/#161', () => {
  const corpus = [...Object.values(realPosts), ...Object.values(realPostsRound2), ...Object.values(realPostsRound3)];
  const out = extractVerdicts(corpus);
  assert.deepEqual(out.filter((v) => v.pr === 159 || v.pr === 160 || v.pr === 161), []);
});

// ---------- verdict extraction round 4: Lane A FAIL 97a99a05 re-entry ----------
// At cbdca13 every repair-lane claim reproduced (targeted 30/30, pinned
// corpus 105→91, phantoms 0), but a fresh adversarial pass found four new
// classes: F1 a repair post's subject-line unit name ("(PR #132 FAIL 잔여
// 1건 수리본)") bound its FAIL to PR #132 while the genuine FAIL post
// (mention-line lead, bold subject) extracted nothing; F2 relay/receipt
// posts recorded other agents' verdicts under the relayer's name; F3 bare
// attached tokens ignored negation, condition and question context; F4 a
// post opening with the canonical summary pair had the pair swallowed by
// the lead rule, flipping the second verdict and its sha.

test('extractVerdicts: subject-line unit name does not bind its FAIL to the PR (F1)', () => {
  assert.deepEqual(extractVerdicts([realPostsRound4.realPassRepair132]), []);
});

test('extractVerdicts: genuine FAIL post with mention-line lead extracts its FAIL (F1)', () => {
  const out = extractVerdicts([realPostsRound4.realFail132]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.pr, 132);
  assert.equal(out[0]?.verdict, 'FAIL');
  assert.equal(out[0]?.messageId, realPostsRound4.realFail132.id);
  assert.equal(out[0]?.sha, '328667c182042ac5d88ff441250dc0addfbd7606');
});

test('extractVerdicts: relay and receipt posts attribute nothing to the relayer (F2)', () => {
  assert.deepEqual(extractVerdicts([realPostsRound4.realRelayNoted3]), []);
  assert.deepEqual(extractVerdicts([realPostsRound4.realReceipt78]), []);
  assert.deepEqual(extractVerdicts([realPostsRound4.realWatchReceipt90]), []);
});

test('extractVerdicts: negated, conditional and interrogative attached tokens are not verdicts (F3)', () => {
  const negated = MSG('m-f3-neg', 'agent:verifier', 'PR #78 PASS — no wait, that is wrong; nobody has verified it, so this is not a PASS from me or anyone.', '2026-11-01T00:00:00.000Z');
  const conditional = MSG('m-f3-cond', 'agent:verifier', 'If the local suite comes back green, PR #80 PASS from me tomorrow, conditional on that result.', '2026-11-01T00:01:00.000Z');
  const question = MSG('m-f3-q', 'agent:verifier', 'Did anyone give PR #83 PASS yet? I cannot find the review anywhere in the room.', '2026-11-01T00:02:00.000Z');
  assert.deepEqual(extractVerdicts([negated, conditional, question]), []);
});

test('extractVerdicts: post-initial summary pair keeps both polarities and shas (F4)', () => {
  const failFirst = MSG('m-f4-a', 'agent:verifier', 'FAIL on `bbbbbbb` (PR #502), PASS on `ccccccc` (PR #503) — both scoped to the diff.', '2026-11-01T00:03:00.000Z');
  const passFirst = MSG('m-f4-b', 'agent:verifier', 'PASS on `ccccccc` (PR #503), FAIL on `bbbbbbb` (PR #502) — both scoped to the diff.', '2026-11-01T00:04:00.000Z');
  for (const post of [failFirst, passFirst]) {
    const out = extractVerdicts([post]);
    assert.equal(out.length, 2);
    const a = out.find((v) => v.pr === 502);
    const b = out.find((v) => v.pr === 503);
    assert.equal(a?.verdict, 'FAIL');
    assert.equal(a?.sha, 'bbbbbbb');
    assert.equal(b?.verdict, 'PASS');
    assert.equal(b?.sha, 'ccccccc');
  }
});

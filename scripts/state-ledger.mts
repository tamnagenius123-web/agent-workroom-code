#!/usr/bin/env tsx
// state-ledger CLI — read-only "what is the state right now" tool.
//
//   state-ledger snapshot [--out state-ledger.snapshot.json]
//   state-ledger pr <number> [--snapshot <path>] [--json]
//   state-ledger branch <name> [--snapshot <path>] [--json]
//   state-ledger open-gates [--snapshot <path>] [--json]
//
// `snapshot` reads the four live sources (workroom room via the registered
// connector client, git ls-remote, gh pr list, decisions.tsv) and writes one
// JSON snapshot. Query commands read the snapshot file when it exists and
// otherwise build a fresh in-memory snapshot. Answers quote their evidence
// (message ids, SHAs); the tool never creates a verdict.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildSnapshot,
  liveReaders,
  queryBranch,
  queryOpenGates,
  queryPr,
  type StateSnapshot,
} from '../src/state-ledger/index.ts';

const argv = process.argv.slice(2);
const cmd = argv[0];
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));
const flag = (name: string): boolean => argv.includes(`--${name}`);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : fallback;
};

const snapshotPath = resolve(opt('snapshot', 'state-ledger.snapshot.json'));
const liveOpts = {
  clientPath: opt('client', join(homedir(), 'workspace/custom-connectors/custom.agent-workroom/bin/client.py')),
  room: opt('room', 'room_main'),
  repo: opt('repo', 'tamnagenius123-web/agent-workroom'),
  cwd: process.cwd(),
  decisionsPath: resolve(opt('decisions', 'decisions.tsv')),
  progressPath: resolve(opt('progress', '.state-ledger-progress.json')),
};

async function loadSnapshot(): Promise<StateSnapshot> {
  if (existsSync(snapshotPath)) {
    return JSON.parse(await readFile(snapshotPath, 'utf8')) as StateSnapshot;
  }
  return buildSnapshot(liveReaders(liveOpts), { room: liveOpts.room });
}

function printPr(n: number, snap: StateSnapshot): void {
  const ans = queryPr(snap, n);
  if (flag('json')) {
    console.log(JSON.stringify(ans, null, 2));
    return;
  }
  if (!ans.pr) {
    console.log(`PR #${n}: not in snapshot (gh list at ${snap.builtAt})`);
  } else {
    console.log(`PR #${n} ${ans.pr.state}${ans.pr.isDraft ? ' (draft)' : ''} — ${ans.pr.title}`);
    console.log(`  head: ${ans.pr.headRefName} @ ${ans.pr.headRefOid} (source: gh pr list)`);
    console.log(`  base: ${ans.pr.baseRefName}  author: ${ans.pr.author ?? '?'}  updated: ${ans.pr.updatedAt}`);
    console.log(`  url: ${ans.pr.url}`);
  }
  if (ans.branch) console.log(`  branch ref: ${ans.branch.name} @ ${ans.branch.sha} (source: git ls-remote)`);
  if (ans.verdicts.length === 0) {
    console.log('  verdict mentions: none extracted from room posts');
  }
  for (const v of ans.verdicts) {
    console.log(`  verdict mention: ${v.verdict} by ${v.actor} at ${v.at} — msg ${v.messageId}${v.localCi ? ' [local CI cited]' : ''}`);
    console.log(`    "${v.excerpt}"`);
  }
  console.log(`  local CI posts: ${ans.localCi.length}`);
}

function printBranch(name: string, snap: StateSnapshot): void {
  const ans = queryBranch(snap, name);
  if (flag('json')) {
    console.log(JSON.stringify(ans, null, 2));
    return;
  }
  if (!ans.ref) {
    console.log(`branch ${ans.name}: no ref in snapshot (git ls-remote at ${snap.builtAt})`);
  } else {
    console.log(`branch ${ans.name} @ ${ans.ref.sha} (source: git ls-remote)`);
  }
  for (const p of ans.prs) {
    console.log(`  PR #${p.number} ${p.state} — ${p.title} (head ${p.headRefOid})`);
  }
  if (ans.prs.length === 0) console.log('  related PRs: none in snapshot');
}

function printGates(snap: StateSnapshot): void {
  const gates = queryOpenGates(snap);
  if (flag('json')) {
    console.log(JSON.stringify(gates, null, 2));
    return;
  }
  console.log(`gate mentions (BLOCKED/HOLD as posted, newest first): ${gates.length}`);
  for (const g of gates) {
    const where = g.source === 'room' ? `room msg ${g.ref}` : `decisions.tsv @ ${g.ref}`;
    console.log(`  [${g.kind}] ${where} by ${g.actor ?? '?'}${g.pr ? ` (PR #${g.pr})` : ''}`);
    console.log(`    "${g.excerpt}"`);
  }
}

async function main(): Promise<number> {
  if (cmd === 'snapshot') {
    const snap = await buildSnapshot(liveReaders(liveOpts), { room: liveOpts.room });
    const out = resolve(opt('out', snapshotPath));
    await writeFile(out, `${JSON.stringify(snap, null, 2)}\n`);
    console.log(`snapshot written: ${out}`);
    console.log(`  builtAt ${snap.builtAt}`);
    console.log(`  room: ${snap.anchors.room.messageCount} messages, last ${snap.anchors.room.lastMessageId} @ ${snap.anchors.room.lastMessageAt}`);
    console.log(`  refs: ${snap.anchors.refs.count}, main ${snap.anchors.refs.mainSha}`);
    console.log(`  prs: ${snap.anchors.prs.total} total, ${snap.anchors.prs.open} open`);
    console.log(`  decisions: ${snap.anchors.decisions.rows} rows, last ${snap.anchors.decisions.lastTs}`);
    console.log(`  extracted: ${snap.verdicts.length} verdict mentions, ${snap.gates.length} gate mentions`);
    return 0;
  }
  if (cmd === 'pr') {
    const n = Number(positional[0]);
    if (!Number.isInteger(n) || n <= 0) {
      console.error('usage: state-ledger pr <number>');
      return 2;
    }
    printPr(n, await loadSnapshot());
    return 0;
  }
  if (cmd === 'branch') {
    const name = positional[0];
    if (!name) {
      console.error('usage: state-ledger branch <name>');
      return 2;
    }
    printBranch(name, await loadSnapshot());
    return 0;
  }
  if (cmd === 'open-gates') {
    printGates(await loadSnapshot());
    return 0;
  }
  console.error('usage: state-ledger <snapshot|pr <n>|branch <name>|open-gates> [--snapshot <path>] [--json]');
  return 2;
}

process.exit(await main());

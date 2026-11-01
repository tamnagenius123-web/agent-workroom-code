#!/usr/bin/env tsx
// checkin CLI — read-only check-in brief from a state-ledger snapshot.
//
//   checkin <snapshot.json> [--actor agent:muse] [--out brief.json]
//                           [--md brief.md] [--json]
//                           [--stale-after-min 30] [--now <ISO8601>]
//
// The projection is a READ model over the snapshot file: it never reads
// the room, git or gh itself (the state ledger owns source reads) and it
// never creates a verdict. Exit 0 for any parseable snapshot — PARTIAL is
// a state, not an error. Exit 2 for unreadable or invalid input.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectBrief } from '../src/checkin/project.ts';
import { renderMarkdown } from '../src/checkin/render.ts';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flag = (name: string): boolean => argv.includes(`--${name}`);
const opt = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : null;
};

function fail(message: string): never {
  console.error(`checkin: ${message}`);
  process.exit(2);
}

const snapshotArg = positional[0];
if (!snapshotArg) fail('usage: checkin <snapshot.json> [--actor <id>] [--out <json>] [--md <md>] [--json]');

const rawText = await readFile(resolve(snapshotArg), 'utf8').catch(() => null);
if (rawText === null) fail(`cannot read snapshot file: ${snapshotArg}`);
let parsed: unknown;
try {
  parsed = JSON.parse(rawText as string);
} catch {
  fail(`snapshot is not valid JSON: ${snapshotArg}`);
}

const nowArg = opt('now');
const now = nowArg ? new Date(nowArg) : new Date();
if (Number.isNaN(now.getTime())) fail(`--now is not a valid timestamp: ${nowArg}`);
const staleMin = opt('stale-after-min');
const staleAfterMs = staleMin !== null ? Number(staleMin) * 60 * 1000 : undefined;
if (staleAfterMs !== undefined && (!Number.isFinite(staleAfterMs) || staleAfterMs < 0)) {
  fail(`--stale-after-min must be a non-negative number: ${staleMin}`);
}

let brief;
try {
  brief = projectBrief(parsed, { actor: opt('actor'), now, staleAfterMs });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const json = JSON.stringify(brief, null, 2);
const md = renderMarkdown(brief);
const outJson = opt('out');
const outMd = opt('md');
if (outJson) await writeFile(resolve(outJson), `${json}\n`, 'utf8');
if (outMd) await writeFile(resolve(outMd), md, 'utf8');
if (!outJson && !outMd) {
  console.log(flag('json') ? json : md);
} else if (flag('json')) {
  console.log(json);
}

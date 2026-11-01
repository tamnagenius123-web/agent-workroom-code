// Presence / activity projection CLI — read model over exported files.
// Usage: npx tsx scripts/presence.mts --messages <export.json>
//          [--deliveries <deliveries.jsonl>] [--deliveries-agent <agent_id>]
//          [--as-of <iso>] [--active-min <n>] [--recent-min <n>]
//          [--format json|md] [--out <file>]
// Output carries basis="activity-evidence" and not_wake_proof=true. This is
// NOT wake proof: it shows observed activity, never that an agent woke.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildPresenceReport, parseDeliveriesJsonl, renderPresenceMarkdown } from '../src/presence/index.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function fail(msg: string): never {
  console.error(`presence: ${msg}`);
  process.exit(2);
}

const messagesPath = arg('--messages') ?? fail('--messages <export.json> is required');
let messagesText: string;
try {
  messagesText = readFileSync(messagesPath, 'utf8');
} catch {
  fail(`cannot read messages file: ${messagesPath}`);
}
let messages: unknown;
try {
  messages = JSON.parse(messagesText);
} catch {
  fail(`messages file is not valid JSON: ${messagesPath}`);
}
if (!Array.isArray(messages)) fail('messages file must be a JSON array of message objects');

let deliveryEntries: unknown[] = [];
let malformedLines = 0;
const deliveriesPath = arg('--deliveries');
if (deliveriesPath !== undefined) {
  let text: string;
  try {
    text = readFileSync(deliveriesPath, 'utf8');
  } catch {
    fail(`cannot read deliveries file: ${deliveriesPath}`);
  }
  const parsed = parseDeliveriesJsonl(text);
  deliveryEntries = parsed.entries;
  malformedLines = parsed.malformedLines;
}

const minutes = (name: string): number | undefined => {
  const raw = arg(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) fail(`${name} must be a non-negative number`);
  return n * 60_000;
};

const report = buildPresenceReport(
  { messages, deliveries: deliveryEntries },
  {
    asOf: arg('--as-of'),
    deliveriesAgent: arg('--deliveries-agent'),
    deliveryMalformedLines: malformedLines,
    activeWithinMs: minutes('--active-min'),
    recentWithinMs: minutes('--recent-min'),
  },
);

const format = arg('--format') ?? 'json';
if (format !== 'json' && format !== 'md') fail('--format must be json or md');
const out = format === 'md' ? renderPresenceMarkdown(report) : JSON.stringify(report, null, 2) + '\n';
const outPath = arg('--out');
if (outPath !== undefined) writeFileSync(outPath, out);
else process.stdout.write(out);

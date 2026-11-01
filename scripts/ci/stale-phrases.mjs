#!/usr/bin/env node
// Stale-rule lint (docs/OWNER_RULINGS.md R1/R2, owner t1034u-t1036u). Fails when a tracked file reintroduces
// the retired GitHub-review / per-agent-account gate wording. Owner ledgers, seeds, history, and tests are allowlisted.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const STALE = [/APPROVED review/i, /reviewDecision/i, /separate GitHub account/i, /per-agent GitHub/i, /one GitHub account cannot/i];
export const ALLOW = [/^docs\/OWNER_RULINGS\.md$/, /^docs\/OWNER_DECISIONS\.md$/, /^seeds\//, /^decisions\.tsv$/, /^tests\//, /^reports\//, /^docs\/audits\//, /^scripts\/ci\/stale-phrases\.mjs$/, /^REVIEW-[^/]*\.md$/];

export function staleHits(files, read) {
  const hits = [];
  for (const f of files) {
    if (ALLOW.some((re) => re.test(f)) || !/\.(md|mdx|mjs|mts|ts|tsx|js|ya?ml|json|txt|sh)$/.test(f)) continue;
    let text; try { text = read(f); } catch { continue; }
    text.split('\n').forEach((line, i) => { for (const re of STALE) if (re.test(line)) hits.push(`${f}:${i + 1}: ${re.source}`); });
  }
  return hits;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const hits = staleHits(files, (f) => readFileSync(f, 'utf8'));
  if (hits.length) { console.error('Stale merge-gate wording (see docs/OWNER_RULINGS.md):\n' + hits.join('\n')); process.exit(1); }
  console.log('stale-phrases: ok');
}

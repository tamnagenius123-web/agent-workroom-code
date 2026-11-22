#!/usr/bin/env node
// Job-level path filter for ci.yml. A pull request whose diff is only
// docs/, reports/, or markdown skips install, build, typecheck, lint, and
// tests. Any other path, an empty diff, or an event this script does not
// know runs the product checks. The required job still runs either way:
// a skipped workflow would not report it.
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Source-like files always run the product checks, including under docs/.
// Markdown, and non-source files under docs/ or reports/, do not.
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|yml|yaml|toml|sql|sh)$/;

export function productChange(files) {
  if (!Array.isArray(files) || files.length === 0) return true;
  const fast = (file) => {
    if (SOURCE.test(file)) return false;
    if (file.startsWith('docs/') || file.startsWith('reports/')) return true;
    return file.endsWith('.md') || file.endsWith('.mdx');
  };
  return files.some((file) => !fast(file));
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

function lines(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function changedFiles() {
  const event = process.env.GITHUB_EVENT_NAME ?? '';
  if (event === 'pull_request') {
    const baseRef = process.env.GITHUB_BASE_REF || 'main';
    if (!/^[A-Za-z0-9._/-]+$/.test(baseRef)) throw new Error('unexpected base ref');
    const base = `refs/remotes/origin/${baseRef}`;
    // Full base history: a depth-1 tip is not enough for the merge-base once main has moved.
    git(['fetch', '--no-tags', 'origin', `+refs/heads/${baseRef}:${base}`]);
    const head = git(['rev-parse', 'HEAD']).trim();
    const text = git(['diff', '--name-only', `${base}...${head}`]);
    return lines(text);
  }
  if (event === 'push') {
    const before = process.env.BEFORE_SHA ?? '';
    if (!/^[0-9a-f]{40}$/.test(before)) return null;
    git(['fetch', '--no-tags', '--depth=1', 'origin', before]);
    const head = git(['rev-parse', 'HEAD']).trim();
    return lines(git(['diff', '--name-only', before, head]));
  }
  return null;
}

function main() {
  const files = changedFiles();
  const product = productChange(files);
  const text = `product=${product ? 'true' : 'false'}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const listed = Array.isArray(files) ? files.map((file) => `- ${file}`).join('\n') : '- (diff unavailable; product checks run)';
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## path filter\n\nproduct=${product ? 'true' : 'false'}\n\n${listed}\n`);
  }
  process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

#!/usr/bin/env node
// Migration-number lint. A branch may add migrations/NNNN_*.sql only when that
// number is free on the base tree and a REGISTRY.md row names that file.
// Numbers are never reused; "next free" is one above the highest known number.
// migrationNumberErrors is pure: pass file lists in. The CLI and check.mjs do the git I/O.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Disk names and REGISTRY claims share this shape: ASCII, no control characters.
// A migrations/*.sql name outside it fails the lint and names the file
// (JSON-escaped). It is not skipped.
const MIGRATION_NAME = String.raw`\d{4}_[A-Za-z0-9_-]+\.sql`;
const MIGRATION_FILE = new RegExp(`^${MIGRATION_NAME}$`);
const SQL_CLAIM = new RegExp(String.raw`\b(${MIGRATION_NAME})\b`);
const REGISTRY_PATH = 'migrations/REGISTRY.md';
const BRANCH_CLAIM = /\b((?:grok|codex)\/[A-Za-z0-9][A-Za-z0-9._-]*)/;
const ROW = /^\| (\d{4}) \| (.*) \| ([a-z_]+) \|$/;

function migrationBaseName(path) {
  if (typeof path !== 'string') return null;
  const name = path.trim().split('/').pop() ?? '';
  return MIGRATION_FILE.test(name) ? name : null;
}

function uniqueMigrations(paths) {
  const out = [];
  const seen = new Set();
  for (const path of paths) {
    const name = migrationBaseName(path);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function groupByNumber(names) {
  const map = new Map();
  for (const name of names) {
    const number = name.slice(0, 4);
    const list = map.get(number);
    if (list) list.push(name);
    else map.set(number, [name]);
  }
  return map;
}

function nextFreeNumber(names, rows) {
  let max = 0;
  for (const name of names) max = Math.max(max, Number(name.slice(0, 4)));
  for (const row of rows) {
    if (row && typeof row.number === 'string' && /^\d{4}$/.test(row.number)) max = Math.max(max, Number(row.number));
  }
  return String(max + 1).padStart(4, '0');
}

function describeClaim(row) {
  const unit = String(row?.unit ?? '');
  const file = SQL_CLAIM.exec(unit)?.[1] ?? '';
  const branch = BRANCH_CLAIM.exec(unit)?.[1] ?? '';
  if (file && branch) return `${file} on ${branch}`;
  if (file) return file;
  if (branch) return branch;
  const text = unit.trim();
  return text ? `"${text}"` : 'another unit';
}

function sqlClaims(unit) {
  return [...String(unit ?? '').matchAll(new RegExp(SQL_CLAIM.source, 'g'))];
}

function jsonEscape(text) {
  return JSON.stringify(text).slice(1, -1);
}

// Top-level migrations/*.sql. The raw basename has to match MIGRATION_FILE.
// trim() drops a leading or trailing control character and would hide that name.
function unparsedMigrationFiles(paths) {
  const out = [];
  const seen = new Set();
  for (const path of paths) {
    if (typeof path !== 'string' || path.length === 0) continue;
    const body = path.startsWith('migrations/') ? path : (path.trim().startsWith('migrations/') ? path.trim() : '');
    if (!body.startsWith('migrations/')) continue;
    const rel = body.slice('migrations/'.length);
    if (rel.length === 0 || rel.includes('/') || rel === 'REGISTRY.md') continue;
    const sql = rel.endsWith('.sql') || rel.trim().endsWith('.sql');
    const control = /[\u0000-\u001F\u007F]/.test(rel);
    if (!sql && !control) continue;
    if (body === path && MIGRATION_FILE.test(rel)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

// Branch text is taken from this filename forward, and stops at the next SQL
// name, so an earlier file's branch is not attached to a later clash.
function describeSqlClaim(unit, match, nextIndex) {
  const text = String(unit ?? '');
  const start = match.index ?? 0;
  const window = text.slice(start, nextIndex ?? text.length);
  const file = match[1] ?? '';
  const branch = BRANCH_CLAIM.exec(window)?.[1] ?? '';
  if (file && branch) return `${file} on ${branch}`;
  if (file) return file;
  return describeClaim({ unit });
}

function mismatchedClaims(row, file) {
  const claims = sqlClaims(row?.unit);
  if (claims.length === 1) return claims[0][1] !== file ? [describeClaim(row)] : [];
  const out = [];
  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    if (!claim || claim[1] === file) continue;
    const next = claims[i + 1];
    out.push(describeSqlClaim(row.unit, claim, next ? next.index : undefined));
  }
  return out;
}

export function parseRegistryMarkdown(markdown) {
  const rows = [];
  for (const raw of String(markdown ?? '').split('\n')) {
    const match = ROW.exec(raw.replace(/\r$/, ''));
    if (!match) continue;
    rows.push({ number: match[1], unit: match[2], status: match[3] });
  }
  return rows;
}

// baseFiles and headFiles are migration paths (basename or migrations/NNNN_*.sql).
// rows are { number, unit, status } from parseRegistryMarkdown.
export function migrationNumberErrors(baseFiles, headFiles, rows) {
  const baseNames = uniqueMigrations(baseFiles);
  const headNames = uniqueMigrations(headFiles);
  const registry = Array.isArray(rows) ? rows : [];
  const errors = unparsedMigrationFiles([...baseFiles, ...headFiles]).map(
    (file) => `${jsonEscape(file)} cannot be parsed as a migration filename`,
  );
  const baseSet = new Set(baseNames);
  const added = headNames.filter((name) => !baseSet.has(name));
  let cursor = Number(nextFreeNumber([...baseNames, ...headNames], registry));
  const takeNext = () => {
    const value = String(cursor).padStart(4, '0');
    cursor += 1;
    return value;
  };
  const baseBy = groupByNumber(baseNames);
  const addedBy = groupByNumber(added);
  for (const number of [...addedBy.keys()].sort()) {
    const addedHere = (addedBy.get(number) ?? []).slice().sort();
    const onBase = (baseBy.get(number) ?? []).slice().sort();
    let blocked = false;
    if (onBase.length > 0) {
      errors.push(`${number} already used by ${onBase.join(', ')} on main; next free number is ${takeNext()}; add a REGISTRY row`);
      blocked = true;
    }
    if (addedHere.length > 1) {
      errors.push(`${number} already used by ${addedHere.join(', ')} on this branch; next free number is ${takeNext()}; add a REGISTRY row`);
      blocked = true;
    }
    if (blocked) continue;
    const file = addedHere[0];
    const claimed = registry.filter((row) => row && row.number === number);
    const mismatches = claimed.flatMap((row) => mismatchedClaims(row, file));
    if (mismatches.length > 0) {
      const described = [...new Set(mismatches)].join(', ');
      errors.push(`${number} claimed in REGISTRY for ${described}; next free number is ${takeNext()}; add a REGISTRY row`);
      continue;
    }
    if (claimed.some((row) => String(row.unit ?? '').includes(file))) continue;
    if (claimed.length === 0) {
      errors.push(`${file} has no REGISTRY row; add a REGISTRY row for ${number} naming ${file}`);
      continue;
    }
    const described = [...new Set(claimed.map(describeClaim))].join(', ');
    errors.push(`${number} claimed in REGISTRY for ${described}; next free number is ${takeNext()}; add a REGISTRY row`);
  }
  return errors;
}

// A missing base registry is ENOENT, or git's own line for migrations/REGISTRY.md:
//   fatal: path 'migrations/REGISTRY.md' does not exist in '<rev>'
//   fatal: path 'migrations/REGISTRY.md' exists on disk, but not in '<rev>'
// Any other read error fails closed, even when the text contains "does not exist".
function confirmedMissingPath(error) {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && error.code === 'ENOENT') return true;
  const stderr = 'stderr' in error && error.stderr != null ? String(error.stderr) : '';
  const message = 'message' in error && error.message != null ? String(error.message) : String(error);
  const text = `${message}\n${stderr}`;
  const quoted = REGISTRY_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = (middle) => new RegExp(`^fatal: path '${quoted}' ${middle} '[^']*'$`, 'm');
  return line('does not exist in').test(text) || line('exists on disk, but not in').test(text);
}

function showRegistry(io, rev, fail) {
  try {
    return { markdown: String(io.execGit(['show', `${rev}:${REGISTRY_PATH}`])) };
  } catch (error) {
    if (confirmedMissingPath(error)) return { markdown: '' };
    const detail = error instanceof Error ? error.message : error;
    const message = `base REGISTRY.md not readable; failing closed: ${detail}`;
    fail(message);
    return { failed: message };
  }
}

function resolvesOutsideCheckout(path) {
  try {
    const root = realpathSync(process.cwd());
    const resolved = realpathSync(path);
    const rel = relative(root, resolved);
    return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  } catch {
    return true;
  }
}

// -z output is NUL-terminated and unquoted, so a newline or a non-ASCII byte
// stays inside one path. A buffer with no NUL is the line-oriented form the
// in-process stubs still return; newlines there are separators.
function splitGitPaths(text) {
  const raw = String(text ?? '');
  const parts = raw.includes('\0') ? raw.split('\0') : raw.split('\n');
  return parts.filter(Boolean);
}

function listMigrationsAt(io, rev, fail) {
  try {
    return splitGitPaths(io.execGit(['ls-tree', '-r', '-z', '--name-only', rev, '--', 'migrations']));
  } catch (e) {
    fail(`migration list failed closed: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

// Lists migration paths at two revs. Rows come from the base rev's REGISTRY.md and
// the working tree's REGISTRY.md, so a claim on main still blocks a rewritten row.
// missing: 'skip' (check.mjs temp dirs have no registry) or 'fail' (the CLI).
// A symlink registry is not followed. A parent symlink that resolves outside
// the checkout is not followed either.
export function migrationErrorsAt(baseRev, headRev, io) {
  const registryPath = REGISTRY_PATH;
  const fail = io.fail;
  let headMarkdown = null;
  try {
    const st = io.lstat(registryPath);
    if (!st || st.isSymbolicLink() || !st.isFile()) {
      fail('REGISTRY.md is not a regular file; failing closed');
      return [];
    }
    if (resolvesOutsideCheckout(registryPath)) {
      fail('REGISTRY.md resolves outside the checkout; failing closed');
      return [];
    }
    headMarkdown = io.readFile(registryPath, 'utf8');
  } catch (e) {
    const missing = e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT';
    if (!(missing && io.missing !== 'fail')) {
      fail(missing ? 'migrations/REGISTRY.md is missing; add the reservation table back' : 'REGISTRY.md not readable; failing closed');
      return [];
    }
  }
  const headRows = headMarkdown === null ? [] : parseRegistryMarkdown(headMarkdown);
  if (headMarkdown !== null && headRows.length === 0) return ['migrations/REGISTRY.md has no reservation rows; add the reservation table back'];
  const shown = showRegistry(io, baseRev, fail);
  if (shown.failed) return [shown.failed];
  const baseRows = parseRegistryMarkdown(shown.markdown);
  return migrationNumberErrors(listMigrationsAt(io, baseRev, fail), listMigrationsAt(io, headRev, fail), [...baseRows, ...headRows]);
}

function gitEnv() {
  const env = { ...process.env };
  delete env.GIT_EXTERNAL_DIFF;
  return env;
}

function main() {
  const base = process.argv[2];
  const head = process.argv[3] || 'HEAD';
  if (!base) {
    console.error('usage: node scripts/ci/mig-num-lint.mjs <base-rev> [head-rev]');
    process.exit(1);
  }
  const fail = (message) => {
    console.error(message);
    process.exit(1);
  };
  const errs = migrationErrorsAt(base, head, {
    lstat: lstatSync,
    readFile: (path, encoding) => readFileSync(path, encoding),
    execGit: (args) => execFileSync('git', args, { encoding: 'utf8', env: gitEnv() }),
    fail,
    missing: 'fail',
  });
  if (errs.length) {
    for (const err of errs) console.error(err);
    process.exit(1);
  }
}

function invokedAsCli() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedAsCli()) main();

// CI-GATE policy (docs/verification-policy.md). Pure functions; scripts/ci/check.mjs wires them to git/GitHub.
export function duplicateMigrationNumbers(names) {
  const by = {};
  for (const n of names) { const m = /^(\d{4})_.*\.sql$/.exec(n); if (m) (by[m[1]] ??= []).push(n); }
  return Object.fromEntries(Object.entries(by).filter(([, v]) => v.length > 1).map(([k, v]) => [k, v.sort()]));
}

// Paths that force Tier L. Tier L needs green ci plus a ## Verification section.
export const TIER_L_RULES = [
  [/(^|\/)(auth|oauth|consent|scopes?|permissions?|acl|tokens?|session)[^/]*$|\/(auth|oauth)\//i, 'security/auth/permissions'],
  [/secret|\.env|egress|notify\.ts$|wake/i, 'secrets/egress'],
  [/spend|budget|billing|cost|meter|claude-runner/i, 'money/spend'],
  [/^wrangler\.(toml|jsonc?)$|^scripts\/(deploy|build)|^\.github\/(?!workflows\/ci\.yml)/, 'deploy config'],
  [/^\.github\/workflows\/|^scripts\/ci\/|^scripts\/test-(run|select)\.mjs$|^tests\/test-(deps|exclusive)\.json$|^docs\/verification-policy\.md$|^eslint\.config|^tsconfig/, 'verification/CI rules'],
  [/^src\/server\/(?:mcp|policy|domain|worker)\.ts$|^src\/worker\.ts$/, 'server authority boundary'],
  [/^src\/server\/dispatch-wire\.ts$/, 'money/spend'],
];
const DESTRUCTIVE_SQL = /\b(DELETE\s+FROM|DROP\s+(TABLE|COLUMN|INDEX)|UPDATE\s+\w+\s+SET|ALTER\s+TABLE\s+\w+\s+(DROP|RENAME)|TRUNCATE|INSERT\s+OR\s+REPLACE|REPLACE\s+INTO)\b/i;

export function classifyTier(files, contents = {}) {
  const reasons = [];
  for (const f of files) {
    for (const [re, why] of TIER_L_RULES) if (re.test(f)) reasons.push(`${f}: ${why}`);
    if (/^migrations\/.*\.sql$/.test(f) && DESTRUCTIVE_SQL.test(contents[f] ?? '')) reasons.push(`${f}: migration alters/deletes data`);
  }
  return { tier: reasons.length ? 'L' : 'D', reasons };
}

// git diff --name-status -M/-C. Renames and copies list the old path and the new path.
function unquoteGitPath(raw) {
  if (raw.length < 2 || raw[0] !== '"' || raw.at(-1) !== '"') return raw;
  try { return JSON.parse(raw); } catch { /* git also uses octal escapes */ }
  return raw.slice(1, -1).replace(/\\(\\|"|n|t|r|[0-7]{1,3})/g, (_, e) => {
    if (e === 'n') return '\n';
    if (e === 't') return '\t';
    if (e === 'r') return '\r';
    if (e === '\\' || e === '"') return e;
    return String.fromCharCode(Number.parseInt(e, 8));
  });
}

function splitNameStatus(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === '"') { j += 1; break; }
        j += 1;
      }
      fields.push(unquoteGitPath(line.slice(i, j)));
      if (line[j] === '\t') j += 1;
      i = j;
    } else {
      const tab = line.indexOf('\t', i);
      const end = tab === -1 ? line.length : tab;
      fields.push(line.slice(i, end));
      i = tab === -1 ? line.length : tab + 1;
    }
  }
  return fields;
}

export function pathsFromNameStatus(text) {
  const out = [];
  const seen = new Set();
  const add = (p) => { if (typeof p === 'string' && p.length > 0 && !seen.has(p)) { seen.add(p); out.push(p); } };
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const fields = splitNameStatus(line);
    const status = fields[0] ?? '';
    if (/^[RC]\d*$/.test(status)) { add(fields[1]); add(fields[2]); }
    else if (fields[1]) add(fields[1]);
  }
  return out;
}

const FULL_SHA = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;

// External diff drivers and textconv would execute whatever the PR tree names.
export function diffNameStatusArgs(base, head = 'HEAD') {
  if (typeof base !== 'string' || !FULL_SHA.test(base)) throw new Error('base must be a full sha');
  if (head !== 'HEAD' && (typeof head !== 'string' || !FULL_SHA.test(head))) throw new Error('head must be a full sha or HEAD');
  return ['-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=', 'diff', '--no-ext-diff', '--no-textconv', '--find-copies-harder', '--name-status', '-M', '-C', `${base}...${head}`];
}

// Operator Ryan, 2026-11-19: a room PASS is not a merge condition. Tier L is green ci
// plus a ## Verification section that records a command, a verify-skill run, or a link.
export const TIER_L_NOTE = 'Tier L: merge needs green ci at this head and a non-empty "## Verification" section that records the command or evidence. A room PASS is not a merge condition';
const VERIFICATION_HEADING = /^##[ \t]+Verification[ \t]*$/;
const PLACEHOLDER_WORD = /^(?:todo|tbd|wip|placeholder|pending|fixme|xxx+|n\/?a|none|later|soon|here|this|section|verification|add|fill|in|the|a|an|text|lorem|ipsum)$/i;
const VERIFY_MISS = 'Tier L requires a "## Verification" section naming a command or verify-skill run and its result, or a link to evidence';

export function verificationBody(body = '') {
  const lines = String(body).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => VERIFICATION_HEADING.test(line));
  if (start === -1) return null;
  const rest = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##[ \t]+/.test(lines[i])) break;
    rest.push(lines[i]);
  }
  return rest.join('\n').trim();
}

export function verificationErrors(body = '') {
  const section = verificationBody(body);
  if (section == null) return [VERIFY_MISS];
  const withoutPass = section.replace(/^\s*Workroom-PASS:.*$/gim, '').trim();
  if (!withoutPass) return ['Tier L "## Verification" section is empty'];
  const tokens = withoutPass
    .replace(/https?:\/\/\S+/g, ' evidence-link ')
    .replace(/[`*_>#()[\]|]/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^[^A-Za-z0-9/]+|[^A-Za-z0-9/]+$/g, ''))
    .filter(Boolean);
  const substantive = tokens.filter((word) => !PLACEHOLDER_WORD.test(word));
  if (substantive.length === 0 || substantive.join(' ').length < 12) {
    return ['Tier L "## Verification" section is only placeholder text'];
  }
  return [];
}

export function policyErrors({ files, body = '', contents = {} } = {}) {
  const errs = [];
  const claimed = /^\s*Tier:\s*([DL])\b/im.exec(body)?.[1]?.toUpperCase();
  if (!claimed) errs.push('PR body must declare "Tier: D" or "Tier: L" (docs/verification-policy.md)');
  const { tier: pathTier, reasons } = classifyTier(files, contents);
  // A declared Tier L raises the requirement. A declared Tier D never lowers a path rule.
  const tier = pathTier === 'L' || claimed === 'L' ? 'L' : pathTier;
  if (pathTier === 'L' && claimed === 'D') errs.push('path rules force Tier L (green ci and a ## Verification section required): ' + reasons.join('; '));
  if (files.some((f) => /^(src|migrations)\//.test(f))) {
    if (!files.includes('decisions.tsv')) errs.push('src/ or migrations/ changed: add a decisions.tsv row');
    if (!/^#+\s*Blast radius\s*$\s*\S/im.test(body)) errs.push('src/ or migrations/ changed: PR body needs a non-empty "## Blast radius" section');
  }
  if (tier === 'L') errs.push(...verificationErrors(body));
  return errs;
}

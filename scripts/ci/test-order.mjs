// V3-7 slice 1: static tests-before-src commit order in base..head. Advisory: check.mjs prints
// it and does not fail on it. Commit order is not RED evidence; RED needs a reproducible failing
// test run at the test commit. Anything the order cannot decide is 'uncertain', never a pass
// (Dots 16644c4f, a8af1a47). Pure functions; check.mjs runs git.
import { pathsFromNameStatus } from './policy.mjs';

const FULL_SHA = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;
const TEST_PATH = /^tests\/|(^|\/)__tests__\/|\.test\.[cm]?[jt]sx?$/;
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|sh|py|sql|rs|go)$/;
// Everything that is neither a test nor one of these counts as code. docs/ is non-code except source files.
const NON_CODE_PATH = /\.md$|^decisions\.tsv$/;

const isTest = (p) => TEST_PATH.test(p);
const isCode = (p) => !isTest(p) && !NON_CODE_PATH.test(p) && !(p.startsWith('docs/') && !SOURCE_EXT.test(p));
// A fixture under tests/ is a test path, but only a test source file is "a new test".
const isTestSource = (p) => isTest(p) && SOURCE_EXT.test(p);
const short = (k) => `${k.sha.slice(0, 7)} (${k.subject})`;

// Oldest first, merges kept so they can be flagged. Same diff-driver guards as diffNameStatusArgs.
export function testOrderLogArgs(base, head = 'HEAD') {
  if (typeof base !== 'string' || !FULL_SHA.test(base)) throw new Error('base must be a full sha');
  if (head !== 'HEAD' && (typeof head !== 'string' || !FULL_SHA.test(head))) throw new Error('head must be a full sha or HEAD');
  return ['-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=', 'log', '--reverse', '--no-ext-diff', '--no-textconv', '-M', '--name-status', '--format=%x00%H%x09%P%x09%s', `${base}..${head}`];
}

// Each record is "\0<sha>\t<parents>\t<subject>\n\n<name-status lines>". Text without a record yields [].
export function commitsFromLog(text) {
  const out = [];
  for (const rec of String(text ?? '').split('\0').slice(1)) {
    const nl = rec.indexOf('\n');
    const header = nl === -1 ? rec : rec.slice(0, nl);
    const m = /^([0-9a-fA-F]{40,64})\t([0-9a-fA-F ]*)\t(.*)$/.exec(header);
    if (!m) continue;
    const changes = [];
    for (const line of (nl === -1 ? '' : rec.slice(nl + 1)).split('\n')) {
      const tab = line.indexOf('\t');
      if (tab <= 0) continue;
      changes.push({ status: line.slice(0, tab), paths: pathsFromNameStatus(line) });
    }
    out.push({ sha: m[1], parents: m[2].split(' ').filter(Boolean), subject: m[3], changes });
  }
  return out;
}

// order: 'tests-before-src' | 'src-before-tests' | 'uncertain' | 'no-code'.
// opts.shallow: the clone is shallow. opts.diffFiles: files in the base...head diff.
export function testOrder(commits, { shallow = false, diffFiles = 0 } = {}) {
  const reasons = [];
  if (shallow) reasons.push('shallow clone: commits may be missing from the log');
  if (commits.length === 0 && diffFiles > 0) reasons.push(`git log is empty but the diff has ${diffFiles} file(s)`);
  for (const k of commits) {
    if (k.parents.length > 1) reasons.push(`merge commit ${short(k)}: its own changes are not in the per-commit order`);
    for (const ch of k.changes) {
      if (/^[DRC]/.test(ch.status) && isTest(ch.paths[0])) reasons.push(`commit ${short(k)} ${ch.status[0] === 'D' ? 'deletes' : 'renames or copies'} test ${ch.paths[0]}`);
    }
  }
  const touches = (k, pred) => k.changes.some((ch) => ch.paths.some(pred));
  const hasCode = commits.some((k) => touches(k, isCode));
  const first = commits.findIndex((k) => touches(k, isTest));
  const early = commits.slice(0, first === -1 ? commits.length : first).find((k) => touches(k, isCode));
  if (early) {
    // Shallow, merge or test delete/rename: the order itself is undecidable, so code-first is uncertain too.
    const lead = first === -1 ? `code commit ${short(early)} and no test commit in range` : `code commit ${short(early)} lands before the first test commit ${short(commits[first])}`;
    return { order: reasons.length ? 'uncertain' : 'src-before-tests', reasons: [lead, ...reasons] };
  }
  if (!hasCode) return { order: reasons.length ? 'uncertain' : 'no-code', reasons };
  const k = commits[first];
  if (touches(k, isCode)) reasons.push(`first test commit ${short(k)} also changes code; a stub and a full fix look the same`);
  if (!k.changes.some((ch) => ch.status === 'A' && isTestSource(ch.paths[0]))) reasons.push(`first test commit ${short(k)} adds no new test file`);
  return { order: reasons.length ? 'uncertain' : 'tests-before-src', reasons };
}

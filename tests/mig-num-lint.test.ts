import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrationErrorsAt, migrationNumberErrors, parseRegistryMarkdown } from '../scripts/ci/mig-num-lint.mjs';

function row(number: string, unit: string, status: string) {
  return { number, unit, status };
}

test('0055 clash: head adds 0055_a.sql while base has 0055_b.sql', () => {
  const errs = migrationNumberErrors(
    ['migrations/0055_b.sql'],
    ['migrations/0055_b.sql', 'migrations/0055_a.sql'],
    [row('0055', 'batch-a (0055_a.sql, grok/batch-a)', 'used')],
  );
  assert.deepEqual(errs, [
    '0055 already used by 0055_b.sql on main; next free number is 0056; add a REGISTRY row',
  ]);
});

test('head adds a migration with no REGISTRY row', () => {
  const errs = migrationNumberErrors(
    ['0053_claude_alias.sql'],
    ['0053_claude_alias.sql', '0054_batch_a.sql'],
    [row('0053', 'agent:claude aliases (0053_claude_alias.sql, grok/claude-agent)', 'used')],
  );
  assert.deepEqual(errs, [
    '0054_batch_a.sql has no REGISTRY row; add a REGISTRY row for 0054 naming 0054_batch_a.sql',
  ]);
});

test('REGISTRY row claims NNNN for a different file or branch', () => {
  const errs = migrationNumberErrors(
    [],
    ['0055_a.sql'],
    [row('0055', 'I2 (0055_i2.sql, grok/i2)', 'reserved')],
  );
  assert.deepEqual(errs, [
    '0055 claimed in REGISTRY for 0055_i2.sql on grok/i2; next free number is 0056; add a REGISTRY row',
  ]);
});

test('a matching REGISTRY row does not clear a different file claim', () => {
  const errs = migrationNumberErrors(
    [],
    ['0055_a.sql'],
    [
      row('0055', 'I4 (0055_intent_proposals.sql, grok/i4)', 'reserved'),
      row('0055', 'batch-a (0055_a.sql, grok/batch-a)', 'used'),
    ],
  );
  assert.deepEqual(errs, [
    '0055 claimed in REGISTRY for 0055_intent_proposals.sql on grok/i4; next free number is 0056; add a REGISTRY row',
  ]);
});

test('two added files on the branch share a number', () => {
  const errs = migrationNumberErrors([], ['0056_b.sql', '0056_a.sql'], []);
  assert.deepEqual(errs, [
    '0056 already used by 0056_a.sql, 0056_b.sql on this branch; next free number is 0057; add a REGISTRY row',
  ]);
});

test('clean branch with a new number and a matching row passes', () => {
  const errs = migrationNumberErrors(
    ['migrations/0053_claude_alias.sql'],
    ['migrations/0053_claude_alias.sql', 'migrations/0054_batch_a.sql'],
    [
      row('0053', 'agent:claude aliases (0053_claude_alias.sql, grok/claude-agent)', 'used'),
      row('0054', 'batch-a (0054_batch_a.sql, grok/batch-a)', 'reserved'),
    ],
  );
  assert.deepEqual(errs, []);
});

test('current repo state passes', () => {
  const sql = readdirSync('migrations').filter((name) => /^\d{4}_.+\.sql$/.test(name));
  const markdown = readFileSync('migrations/REGISTRY.md', 'utf8');
  const rows = parseRegistryMarkdown(markdown);
  assert.equal(rows.some((r) => r.number === '0053' && r.unit.includes('0053_claude_alias.sql') && r.status === 'used'), true);
  assert.equal(rows.some((r) => r.number === '0041' && r.unit.includes('0041_outbox_destination.sql') && r.unit.includes('grok/t2b-destination') && r.status === 'reserved'), true);
  assert.deepEqual(migrationNumberErrors(sql, sql, rows), []);
});

test('N05 a migrations directory symlink outside the checkout fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'mig-num-n05-'));
  const outside = mkdtempSync(join(tmpdir(), 'mig-num-n05-out-'));
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env });
  try {
    git(['init', '-q']);
    mkdirSync(join(root, 'migrations'));
    writeFileSync(join(root, 'migrations', 'REGISTRY.md'), '| 0090 | anchor (0090_anchor.sql) | used |\n');
    writeFileSync(join(root, 'migrations', '0090_anchor.sql'), '-- anchor\n');
    git(['add', '-A']);
    const baseTree = git(['write-tree']).trim();
    rmSync(join(root, 'migrations'), { recursive: true, force: true });
    writeFileSync(join(outside, 'REGISTRY.md'), '| 0090 | anchor (0090_anchor.sql) | used |\nSECRET_OUTSIDE\n');
    symlinkSync(outside, join(root, 'migrations'));
    git(['add', '-A']);
    const headTree = git(['write-tree']).trim();
    const lint = fileURLToPath(new URL('../scripts/ci/mig-num-lint.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [lint, baseTree, headTree], { cwd: root, encoding: 'utf8', env });
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(`${result.stderr}`, /outside the checkout/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /SECRET_OUTSIDE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('N06 a base registry read failure is not an empty registry', () => {
  const failures: string[] = [];
  const errors = migrationErrorsAt('base', 'head', {
    lstat: () => ({ isSymbolicLink: () => false, isFile: () => true }),
    readFile: () => '| 0091 | replacement (0091_new.sql) | reserved |\n',
    execGit: (args: readonly string[]) => {
      if (args[0] === 'show') throw new Error('synthetic base-registry transport/read failure');
      if (args.includes('base')) return 'migrations/0090_anchor.sql\n';
      return 'migrations/0090_anchor.sql\nmigrations/0091_new.sql\n';
    },
    fail: (message: string) => { failures.push(message); },
    missing: 'fail',
  });
  const signal = [...failures, ...errors].join('\n');
  assert.match(signal, /failing closed/);
  assert.match(signal, /synthetic base-registry transport\/read failure/);
});

test('N07 a later SQL claim in the same row is still a clash', () => {
  const rows = parseRegistryMarkdown('| 0091 | candidate (0091_new.sql), prior reservation (0091_prior.sql, grok/prior) | reserved |\n');
  const errs = migrationNumberErrors(['0090_anchor.sql'], ['0090_anchor.sql', '0091_new.sql'], rows);
  assert.deepEqual(errs, [
    '0091 claimed in REGISTRY for 0091_prior.sql on grok/prior; next free number is 0092; add a REGISTRY row',
  ]);
});

test('B02 a lookalike "does not exist" base-registry read error fails closed', () => {
  const failures: string[] = [];
  const detail = 'fatal: unable to read tree: object directory .git/objects does not exist';
  const closed = `base REGISTRY.md not readable; failing closed: ${detail}`;
  const errors = migrationErrorsAt('base', 'head', {
    lstat: () => ({ isSymbolicLink: () => false, isFile: () => true }),
    readFile: () => '| 0091 | replacement (0091_new.sql) | reserved |\n',
    execGit: (args: readonly string[]) => {
      if (args[0] === 'show') throw new Error(detail);
      if (args.includes('base')) return 'migrations/0090_anchor.sql\n';
      return 'migrations/0090_anchor.sql\nmigrations/0091_new.sql\n';
    },
    fail: (message: string) => { failures.push(message); },
    missing: 'fail',
  });
  assert.deepEqual({ failures, errors }, { failures: [closed], errors: [closed] });
});

test('B02 an exact git path-absent "does not exist in" message is a missing base registry', () => {
  const failures: string[] = [];
  const errors = migrationErrorsAt('base', 'head', {
    lstat: () => ({ isSymbolicLink: () => false, isFile: () => true }),
    readFile: () => '| 0091 | replacement (0091_new.sql) | reserved |\n',
    execGit: (args: readonly string[]) => {
      if (args[0] === 'show') throw new Error("fatal: path 'migrations/REGISTRY.md' does not exist in 'base'");
      if (args.includes('base')) return 'migrations/0090_anchor.sql\n';
      return 'migrations/0090_anchor.sql\nmigrations/0091_new.sql\n';
    },
    fail: (message: string) => { failures.push(message); },
    missing: 'fail',
  });
  assert.deepEqual({ failures, errors }, { failures: [], errors: [] });
});

test('B03 a hyphenated later SQL claim in the same row is still a clash', () => {
  const rows = parseRegistryMarkdown('| 0091 | candidate (0091_new.sql), prior reservation (0091_prior-v2.sql, grok/prior) | reserved |\n');
  const errs = migrationNumberErrors(['0090_anchor.sql'], ['0090_anchor.sql', '0091_new.sql'], rows);
  assert.deepEqual(errs, [
    '0091 claimed in REGISTRY for 0091_prior-v2.sql on grok/prior; next free number is 0092; add a REGISTRY row',
  ]);
});

test('C-B02 a repository object-store read error fails closed', () => {
  const failures: string[] = [];
  const detail = 'fatal: repository backing object store does not exist';
  const closed = `base REGISTRY.md not readable; failing closed: ${detail}`;
  const errors = migrationErrorsAt('base', 'head', {
    lstat: () => ({ isSymbolicLink: () => false, isFile: () => true }),
    readFile: () => '| 0091 | replacement (0091_new.sql) | reserved |\n',
    execGit: (args: readonly string[]) => {
      if (args[0] === 'show') {
        throw Object.assign(new Error('fatal: repository backing object store does not exist'), { code: 128, stderr: Buffer.from('fatal: repository backing object store does not exist\n') });
      }
      if (args.includes('base')) return 'migrations/0090_anchor.sql\n';
      return 'migrations/0090_anchor.sql\nmigrations/0091_new.sql\n';
    },
    fail: (message: string) => { failures.push(message); },
    missing: 'fail',
  });
  assert.notDeepEqual({ failures, errors }, { failures: [], errors: [] });
  assert.deepEqual({ failures, errors }, { failures: [closed], errors: [closed] });
});

test('C-B03 a hyphenated prior claim in the capsule row is still a clash', () => {
  const rows = parseRegistryMarkdown('| 0091 | candidate (0091_new.sql), prior (0091_prior-v2.sql, grok/prior) | reserved |\n');
  const errs = migrationNumberErrors(['0090_anchor.sql'], ['0090_anchor.sql', '0091_new.sql'], rows);
  assert.deepEqual(errs, [
    '0091 claimed in REGISTRY for 0091_prior-v2.sql on grok/prior; next free number is 0092; add a REGISTRY row',
  ]);
});

test('N04 an invalid base ref exits 1 and fails closed on the base registry read', () => {
  const lint = fileURLToPath(new URL('../scripts/ci/mig-num-lint.mjs', import.meta.url));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const result = spawnSync(process.execPath, [lint, 'not-a-real-ref', 'HEAD'], { cwd: root, encoding: 'utf8', env });
  assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(`${result.stderr}`, /base REGISTRY\.md not readable; failing closed/);
});

test('a migrations SQL file outside the shared filename pattern fails and names the file', () => {
  assert.deepEqual(
    migrationNumberErrors(['migrations/0090_anchor.sql'], ['migrations/0090_anchor.sql', 'migrations/notes.sql'], []),
    ['migrations/notes.sql cannot be parsed as a migration filename'],
  );
  assert.deepEqual(migrationNumberErrors(['A\tdocs/note.sql'], ['A\tdocs/note.sql'], []), []);
  assert.deepEqual(
    migrationNumberErrors(
      ['migrations/0090_anchor.sql'],
      ['migrations/0090_anchor.sql', 'migrations/0091_prior-v2.sql'],
      [row('0091', 'prior (0091_prior-v2.sql, grok/prior)', 'reserved')],
    ),
    [],
  );
});

// core.quotePath defaults to true. Pin it so an ambient false setting cannot hide C-quoting.
const EXPLICIT_MIGRATION_FAILURE = /cannot be parsed as a migration filename|already used by |has no REGISTRY row|unparseable|rejected/i;

function lintRealRepoAdding(prefix: string, fileName: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  env.GIT_AUTHOR_NAME = 'mig-num-lint';
  env.GIT_AUTHOR_EMAIL = 'mig-num-lint@example.com';
  env.GIT_COMMITTER_NAME = 'mig-num-lint';
  env.GIT_COMMITTER_EMAIL = 'mig-num-lint@example.com';
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env });
  try {
    git(['init', '-q']);
    git(['config', 'core.quotePath', 'true']);
    mkdirSync(join(root, 'migrations'));
    writeFileSync(join(root, 'migrations', 'REGISTRY.md'), '| 0090 | anchor (0090_anchor.sql) | used |\n');
    writeFileSync(join(root, 'migrations', '0090_anchor.sql'), '-- anchor\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);
    const base = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(join(root, 'migrations', fileName), '-- added\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'head']);
    const lint = fileURLToPath(new URL('../scripts/ci/mig-num-lint.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [lint, base, 'HEAD'], { cwd: root, encoding: 'utf8', env });
    return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('C03a a duplicate-or-unregistered migration named migrations/0092_테스트.sql is not silently dropped', () => {
  const result = lintRealRepoAdding('mig-num-c03a-', '0092_테스트.sql');
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(output.includes('0092_테스트') || output.includes('\\355\\205\\214'), true, output);
  assert.match(output, EXPLICIT_MIGRATION_FAILURE);
});

test('C03b a migration filename containing a newline is not silently dropped', () => {
  const result = lintRealRepoAdding('mig-num-c03b-', '0092_bad\nname.sql');
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(output.includes('0092_bad\nname.sql') || output.includes('0092_bad\\nname.sql'), true, output);
  assert.match(output, EXPLICIT_MIGRATION_FAILURE);
});

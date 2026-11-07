import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('composed runner preserves a signal failure across a build-gated locked duplicate', () => {
  mkdirSync(join(root, '.cache'), { recursive: true });
  const cwd = mkdtempSync(join(root, '.cache', 'composed-consumer-'));
  mkdirSync(join(cwd, 'scripts', 'ci'), { recursive: true });
  mkdirSync(join(cwd, 'tests'));
  mkdirSync(join(cwd, 'tmp'));
  const paths = ['scripts/test-run.mjs', 'scripts/ci/run-files.mjs'];
  for (const rel of paths) copyFileSync(join(root, rel), join(cwd, rel));
  symlinkSync(realpathSync(join(root, 'node_modules')), join(cwd, 'node_modules'), 'dir');
  writeFileSync(join(cwd, 'scripts', 'build.mjs'), `
import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync('events.jsonl', JSON.stringify({event:'build-start'})+'\\n');
await new Promise(resolve => setTimeout(resolve,40));
writeFileSync('build-ready.json', JSON.stringify({synthetic:true}));
appendFileSync('events.jsonl', JSON.stringify({event:'build-end'})+'\\n');
`);
  writeFileSync(join(cwd, 'tests', 'repeated.test.ts'), `
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { test } from 'node:test';
test('synthetic duplicate with first supervisor signal', async () => {
  assert.equal(JSON.parse(readFileSync('build-ready.json','utf8')).synthetic,true);
  const attempt = existsSync('attempt.txt') ? Number(readFileSync('attempt.txt','utf8'))+1 : 1;
  writeFileSync('attempt.txt',String(attempt));
  writeFileSync('active.lock','repeat-'+attempt,{flag:'wx'});
  appendFileSync('events.jsonl', JSON.stringify({event:'repeat-start',attempt})+'\\n');
  if (attempt===1) {
    const parentArgs = readFileSync('/proc/'+process.ppid+'/cmdline','utf8').split('\\0');
    assert.ok(parentArgs.includes('--test') && parentArgs.includes('tests/repeated.test.ts'));
    unlinkSync('active.lock');
    appendFileSync('events.jsonl', JSON.stringify({event:'repeat-kill',attempt,signal:'SIGKILL',verifiedOwnTestSupervisor:true})+'\\n');
    process.kill(process.ppid,'SIGKILL');
    process.exit(0);
  }
  await new Promise(resolve => setTimeout(resolve,40));
  appendFileSync('events.jsonl', JSON.stringify({event:'repeat-end',attempt})+'\\n');
  unlinkSync('active.lock');
});
`);
  writeFileSync(join(cwd, 'tests', 'competitor.test.ts'), `
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { test } from 'node:test';
test('synthetic competitor receives the released scheduler lock', async () => {
  assert.equal(JSON.parse(readFileSync('build-ready.json','utf8')).synthetic,true);
  writeFileSync('active.lock','competitor',{flag:'wx'});
  appendFileSync('events.jsonl',JSON.stringify({event:'competitor-start'})+'\\n');
  await new Promise(resolve => setTimeout(resolve,40));
  appendFileSync('events.jsonl',JSON.stringify({event:'competitor-end'})+'\\n');
  unlinkSync('active.lock');
});
`);
  writeFileSync(join(cwd, 'tests', 'test-exclusive.json'), JSON.stringify({ files: {
    'tests/repeated.test.ts': { locks: ['synthetic-shared-resource'] },
    'tests/competitor.test.ts': { locks: ['synthetic-shared-resource'] },
  } }));
  const protectedPaths = [...paths, 'scripts/build.mjs', 'tests/repeated.test.ts', 'tests/competitor.test.ts', 'tests/test-exclusive.json'];
  const before = Object.fromEntries(protectedPaths.map(rel => [rel, digest(join(cwd, rel))]));
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TZ: 'UTC', LC_ALL: 'C',
    TMPDIR: join(cwd, 'tmp'), TSX_DISABLE_CACHE: '1', TEST_CONCURRENCY: '2', TEST_FILE_TIMEOUT_MS: '5000',
  };
  const argv = ['scripts/ci/run-files.mjs', '--files',
    'tests/repeated.test.ts,tests/competitor.test.ts,tests/repeated.test.ts', '--build'];
  const child = spawnSync(process.execPath, argv, { cwd, env, encoding: 'utf8', timeout: 25_000 });
  const events = existsSync(join(cwd, 'events.jsonl'))
    ? readFileSync(join(cwd, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const after = Object.fromEntries(protectedPaths.map(rel => [rel, digest(join(cwd, rel))]));
  const result = {
    cwd, argv, env, wrapperStatus: child.status, wrapperSignal: child.signal, spawnError: child.error?.message ?? null,
    stdout: child.stdout, stderr: child.stderr, events,
    attempts: existsSync(join(cwd, 'attempt.txt')) ? Number(readFileSync(join(cwd, 'attempt.txt'), 'utf8')) : 0,
    activeLockRemains: existsSync(join(cwd, 'active.lock')),
    timingCache: existsSync(join(cwd, '.cache', 'test-timings.json'))
      ? JSON.parse(readFileSync(join(cwd, '.cache', 'test-timings.json'), 'utf8')) : null,
    fixtureBefore: before, fixtureAfter: after,
    productionBuild: false,
  };
  writeFileSync(join(root, 'NATIVE-OBSERVATION.json'), JSON.stringify(result, null, 2)+'\n');
  assert.equal(result.spawnError, null);
  assert.equal(result.wrapperSignal, null);
  assert.deepEqual(after, before);
  assert.equal(result.attempts, 2);
  assert.equal(result.activeLockRemains, false);
  assert.deepEqual(events.map(event => event.event), [
    'build-start', 'build-end', 'repeat-start', 'repeat-kill', 'competitor-start', 'competitor-end', 'repeat-start', 'repeat-end',
  ]);
  assert.deepEqual(events.filter(event => event.attempt).map(event => event.attempt), [1,1,2,2]);
  assert.match(result.stderr, /runner killed by SIGKILL/);
  assert.equal((result.stderr.match(/(?:FAIL|ok  ) tests\//g) ?? []).length, 3);
  assert.deepEqual(Object.keys(result.timingCache).sort(), ['tests/competitor.test.ts', 'tests/repeated.test.ts']);
  assert.equal(result.wrapperStatus, 1, 'a signal failure must survive the later successful attempt');
  assert.match(result.stderr, /2 file\(s\), 2 slots, wall .*1 failed/);
});

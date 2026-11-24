import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { acquireJournalLock } from '../scripts/orch/journal-lock.ts';

test('the OS lock excludes a concurrent host process and can be reacquired without deleting its file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-lock-'));
  try {
    const path = join(dir, 'journal.lock'), first = await acquireJournalLock(path);
    try { await assert.rejects(acquireJournalLock(path, 100), /journal_locked/); }
    finally { await first.release(); }
    const second = await acquireJournalLock(path);
    assert.equal(second.signal.aborted, false);
    await second.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an abruptly terminated parent releases its OS journal lock without stale-PID deletion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-crash-')), path = join(dir, 'journal.lock');
  const module = new URL('../scripts/orch/journal-lock.ts', import.meta.url).href;
  const script = `const {acquireJournalLock}=await import(${JSON.stringify(module)});await acquireJournalLock(${JSON.stringify(path)});process.stdout.write('READY\\n');process.stdin.resume();`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.once('exit', code => { if (code !== null && code !== 0) reject(new Error('fixture child failed')); });
    });
    await assert.rejects(acquireJournalLock(path, 100), /journal_locked/);
    child.kill('SIGKILL'); // This test owns the exact synthetic child process.
    await closed;
    const recovered = await acquireJournalLock(path);
    assert.equal(recovered.signal.aborted, false);
    await recovered.release();
  } finally { child.kill('SIGKILL'); child.stdin.destroy(); await rm(dir, { recursive: true, force: true }); }
});

test('a bounded OS waiter acquires only after the live owner releases its lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-wait-')), path = join(dir, 'journal.lock');
  const first = await acquireJournalLock(path);
  let firstReleased = false;
  try {
    await assert.rejects(acquireJournalLock(path, 5_001), /invalid_journal_lock_wait/);
    const waiting = acquireJournalLock(path);
    // Hold the real OS lock across a scheduled event-loop turn. The waiter
    // must tolerate contention, rather than unlinking or killing the owner.
    const releasing = (async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      await first.release();
      firstReleased = true;
    })();
    const [acquired] = await Promise.all([waiting, releasing]);
    assert.equal(acquired.signal.aborted, false);
    await acquired.release();
  } finally {
    if (!firstReleased) await first.release();
    await rm(dir, { recursive: true, force: true });
  }
});

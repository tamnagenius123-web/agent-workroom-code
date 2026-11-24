import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';

/** Linux/POSIX flock owns the lock, not the existence of a PID file. The helper
 * exits on stdin EOF, including when its parent crashes. No live PID is killed
 * and stale files need no unlink/takeover race. The bounded OS wait permits
 * the old helper to consume EOF after a parent crash without stealing a live
 * owner's lock. Missing flock fails closed. */
export async function acquireJournalLock(path: string, waitMs = 5_000): Promise<{ signal: AbortSignal; release(): Promise<void> }> {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 5_000) throw new Error('invalid_journal_lock_wait');
  const file = await open(path, 'a', 0o600);
  await file.close();
  const child = spawn('flock', ['-x', '-w', String(waitMs / 1_000), '-E', '75', path, process.execPath, '-e',
    'process.stdout.write("LOCKED\\n");process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'],
  { stdio: ['pipe', 'pipe', 'ignore'] });
  const lost = new AbortController();
  let released = false, ready = false;
  const closed = new Promise<void>(resolve => {
    child.once('close', () => { if (ready && !released) lost.abort(); resolve(); });
    child.once('error', () => { lost.abort(); resolve(); });
  });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output === 'LOCKED\n') { ready = true; resolve(); }
    });
    child.once('error', () => reject(new Error('journal_lock_unavailable')));
    child.once('close', code => { if (!ready) reject(new Error(code === 75 ? 'journal_locked' : 'journal_lock_unavailable')); });
  });
  return { signal: lost.signal, async release() { released = true; child.stdin.end(); await closed; } };
}

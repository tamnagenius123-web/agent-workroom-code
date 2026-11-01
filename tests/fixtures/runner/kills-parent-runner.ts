// Muse's probe: the test file SIGKILLs its parent `node --test` runner, so the runner exits with code null.
import test from 'node:test';
test('kills the runner', () => { process.kill(process.ppid, 'SIGKILL'); });

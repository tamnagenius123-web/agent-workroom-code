import { existsSync, readFileSync, rmSync } from 'node:fs';
import { EVIDENCE, readState } from './lib.mjs';

const state = readState();
if (state?.pid && existsSync('/proc/' + state.pid)) {
  try { process.kill(-state.pid, 'SIGTERM'); } catch { process.kill(state.pid, 'SIGTERM'); }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && existsSync('/proc/' + state.pid)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  if (existsSync('/proc/' + state.pid)) {
    try { process.kill(-state.pid, 'SIGKILL'); } catch { process.kill(state.pid, 'SIGKILL'); }
  }
}
if (existsSync('/tmp/verify-workroom')) rmSync('/tmp/verify-workroom', { recursive: true, force: true });
const kept = ['discovery.json', 'client-row.json', 'grant.json', 'whoami.json', 'transcript.txt'];
const missing = kept.filter((name) => !existsSync(EVIDENCE + '/' + name));
if (missing.length) throw new Error('cleanup removed evidence: ' + missing.join(','));
const grant = JSON.parse(readFileSync(EVIDENCE + '/grant.json', 'utf8'));
if (grant.access_token || grant.refresh_token || grant.has_access_token || grant.has_refresh_token) {
  throw new Error('evidence contains a token');
}
console.log('cleaned; evidence remains at ' + EVIDENCE);

import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { PINNED_HOST, PINNED_RESOURCE, ROOT, d1Name, pinnedFromWrangler, readState, spawnWrangler, workerdBins, wrangler, writeState } from './lib.mjs';

const resource = pinnedFromWrangler();
if (resource !== PINNED_RESOURCE) throw new Error('wrangler.jsonc WORKROOM_RESOURCE is not the pinned resource');
const prior = readState();
if (prior && existsSync('/proc/' + prior.pid)) throw new Error('a verification instance is already running as pid ' + prior.pid);
if (!existsSync(ROOT + '/dist/worker.mjs')) throw new Error('dist/worker.mjs is missing; run npm run build first');

const scratch = '/tmp/verify-workroom/run';
spawnSync('rm', ['-rf', scratch]);
mkdirSync(scratch + '/state', { recursive: true });
mkdirSync(scratch + '/cert', { recursive: true });

const src = readFileSync(ROOT + '/wrangler.jsonc', 'utf8');
const config = src
  .split('\n')
  .filter((line) => !line.includes('"artifacts"'))
  .join('\n')
  .replace('"main": "dist/worker.mjs"', `"main": "${ROOT}/dist/worker.mjs"`)
  .replace('"migrations_dir": "migrations"', `"migrations_dir": "${ROOT}/migrations"`);
if (config.includes('"artifacts"')) throw new Error('scratch config still names artifacts');
if (!config.includes('"WRGIT_ENABLED": "0"')) throw new Error('scratch config dropped WRGIT_ENABLED');
writeFileSync(scratch + '/wrangler.jsonc', config);

execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', scratch + '/cert/key.pem', '-out', scratch + '/cert/cert.pem', '-days', '1', '-nodes', '-subj', '/CN=' + PINNED_HOST], { stdio: 'ignore' });

const name = d1Name();
const common = ['--local', '--persist-to', scratch + '/state', '--config', scratch + '/wrangler.jsonc'];
wrangler(['d1', 'migrations', 'apply', name, ...common], { cwd: scratch });
wrangler(['d1', 'execute', name, ...common, '--command', "INSERT OR IGNORE INTO rooms(id) VALUES ('room_main');"], { cwd: scratch });

let setcap = false;
for (const bin of workerdBins()) {
  const caps = spawnSync('getcap', [bin], { encoding: 'utf8' }).stdout ?? '';
  if (!caps.includes('cap_net_bind_service')) {
    execFileSync('sudo', ['-n', 'setcap', 'cap_net_bind_service=+ep', bin], { stdio: 'ignore' });
    setcap = true;
  }
}

const logPath = scratch + '/wrangler.log';
closeSync(openSync(logPath, 'a'));
const args = ['dev', '--local', '--local-protocol', 'https', '--https-cert-path', scratch + '/cert/cert.pem', '--https-key-path', scratch + '/cert/key.pem', '--config', scratch + '/wrangler.jsonc', '--cwd', scratch, '--ip', '127.0.0.1', '--port', '443', '--inspector-port', '9231', '--persist-to', scratch + '/state', '--show-interactive-dev-session=false', '--log-level', 'info'];
const pid = spawnWrangler(args, logPath);
writeState({ pid, scratch, port: 443, setcap, logPath, d1: name });
const deadline = Date.now() + 45000;
let ready = false;
while (Date.now() < deadline) {
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  if (log.includes('Ready on https://127.0.0.1:443')) { ready = true; break; }
  if (!existsSync('/proc/' + pid)) throw new Error('wrangler exited before ready\n' + log.slice(-2000));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
}
if (!ready) {
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  throw new Error('wrangler did not become ready\n' + log.slice(-2000));
}
console.log('ready https://127.0.0.1:443 pid ' + pid);

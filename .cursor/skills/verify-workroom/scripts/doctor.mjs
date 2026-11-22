import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { PINNED_HOST, PINNED_RESOURCE, curl, pinnedFromWrangler, readState } from './lib.mjs';

const state = readState();
if (!state) throw new Error('no verification instance; run launch first');
if (!existsSync('/proc/' + state.pid)) throw new Error('pid ' + state.pid + ' is not running');
const cmd = readFileSync('/proc/' + state.pid + '/cmdline', 'utf8');
if (!cmd.includes('--local')) throw new Error('instance was not started with --local');
if (cmd.includes('--remote')) throw new Error('instance was started with --remote');
if (pinnedFromWrangler() !== PINNED_RESOURCE) throw new Error('product WORKROOM_RESOURCE drifted');
const config = readFileSync(state.scratch + '/wrangler.jsonc', 'utf8');
if (config.includes('"artifacts"')) throw new Error('scratch config still has the remote artifacts binding');
if (!config.includes('"WRGIT_ENABLED": "0"')) throw new Error('scratch config does not keep WRGIT_ENABLED=0');
const sqlite = [];
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = dir + '/' + name.name;
    if (name.isDirectory()) walk(p);
    else if (name.name.endsWith('.sqlite')) sqlite.push(p);
  }
}
walk(state.scratch + '/state');
if (!sqlite.length) throw new Error('local D1 sqlite file is missing');

function closed(path) {
  const hit = curl(['https://' + PINNED_HOST + path]);
  const code = hit.json?.error?.code;
  if (hit.status !== 503 || code !== 'AUTH_NOT_CONFIGURED') {
    throw new Error(path + ' returned ' + hit.status + ' ' + code);
  }
  return hit.status;
}

closed('/.well-known/oauth-authorization-server');
closed('/.well-known/oauth-protected-resource');
const report = {
  pid: state.pid, port: state.port, resource: pinnedFromWrangler(),
  oauth: 'AUTH_NOT_CONFIGURED', wrgit: '0', local_sqlite: sqlite.length, setcap: state.setcap,
};
console.log(JSON.stringify(report));

import { mkdirSync, writeFileSync } from 'node:fs';
import { EVIDENCE, PINNED_HOST, PINNED_RESOURCE, curl, pinnedFromWrangler, readState, redact } from './lib.mjs';

const state = readState();
if (!state) throw new Error('no verification instance; run launch and doctor first');
if (pinnedFromWrangler() !== PINNED_RESOURCE) throw new Error('product WORKROOM_RESOURCE drifted');

function closed(path, extra = []) {
  const hit = curl(['https://' + PINNED_HOST + path, ...extra]);
  const code = hit.json?.error?.code ?? null;
  if (hit.status !== 503 || code !== 'AUTH_NOT_CONFIGURED') {
    throw new Error(path + ' returned ' + hit.status + ' ' + code);
  }
  return { path, status: hit.status, code };
}

const discovery = closed('/.well-known/oauth-authorization-server');
const authorize = closed('/oauth/authorize');
const mcp = closed('/mcp', ['-X', 'POST', '-H', 'Content-Type: application/json', '-H', 'Accept: application/json, text/event-stream', '-H', 'MCP-Protocol-Version: 2026-07-28', '-H', 'Mcp-Method: tools/call', '-H', 'Mcp-Name: workroom_whoami', '--data', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workroom_whoami', arguments: {} } })]);
const git = closed('/git/merge', ['-X', 'POST', '-H', 'Content-Type: application/json', '--data', '{}']);

mkdirSync(EVIDENCE, { recursive: true });
writeFileSync(EVIDENCE + '/discovery.json', JSON.stringify(discovery, null, 2) + '\n');
writeFileSync(EVIDENCE + '/client-row.json', JSON.stringify({
  inserted: false,
  reason: 'OAuth client rows are provisioned in the gate MCP repo. This drive does not write a client.',
}, null, 2) + '\n');
writeFileSync(EVIDENCE + '/grant.json', JSON.stringify({
  status: authorize.status, has_access_token: false, has_refresh_token: false,
}, null, 2) + '\n');
writeFileSync(EVIDENCE + '/whoami.json', JSON.stringify({
  path: mcp.path, tool: 'workroom_whoami', status: mcp.status, code: mcp.code,
}, null, 2) + '\n');
writeFileSync(EVIDENCE + '/transcript.txt', redact([
  'GET /.well-known/oauth-authorization-server -> ' + discovery.status + ' ' + discovery.code,
  'GET /oauth/authorize -> ' + authorize.status + ' ' + authorize.code,
  'POST /mcp workroom_whoami -> ' + mcp.status + ' ' + mcp.code,
  'POST /git/merge -> ' + git.status + ' ' + git.code,
  'no client row inserted; no token issued',
].join('\n')) + '\n');
console.log('proved fail-closed discovery on ' + PINNED_RESOURCE);

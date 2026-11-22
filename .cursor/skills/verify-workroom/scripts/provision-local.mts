// OAuth client provisioning lives in the gate MCP repo (src/auth/provision.ts).
// This file stays so a copied command cannot fall through to the remote provision script.
const scratch = process.argv[2] ?? '';
if (scratch && !scratch.startsWith('/tmp/verify-workroom/')) {
  throw new Error('scratch must stay under /tmp/verify-workroom');
}
console.error('local OAuth provisioning is not in this repo');
process.exit(1);

import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
// Worker bundles have no node:crypto. The verifier evaluator hashes synchronously through this shim.
const cryptoShim = { name: 'node-crypto-shim', setup(b) { b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: resolve('src/server/node-crypto-shim.ts') })); } };
// or-harness/client.ts is imported by the Worker. Stub node builtins so the bundle loads;
// the dispatch path passes roster and ids and does not call them.
const workerdNodeStub = {
  name: 'workerd-node-stub',
  setup(b) {
    const files = {
      'node:fs': 'export function readFileSync(){throw new Error("node:fs is unused on the worker dispatch path")}',
      'node:path': 'export function dirname(p){const t=String(p);const i=t.lastIndexOf("/");return i<=0?".":t.slice(0,i)}export function join(...a){return a.map(p=>String(p)).join("/")}',
      'node:url': 'export function fileURLToPath(u){return typeof u==="string"?u:String(u)}',
    };
    b.onResolve({ filter: /^node:(fs|path|url)$/ }, args => ({ path: args.path, namespace: 'workerd-node-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'workerd-node-stub' }, args => ({ contents: files[args.path] ?? 'export {}', loader: 'js' }));
  },
};
const common = { bundle: true, target: 'es2023', format: 'esm', legalComments: 'external', logLevel: 'warning' };
const worker = { ...common, platform: 'browser', conditions: ['workerd'], plugins: [cryptoShim, workerdNodeStub] };
await mkdir('dist', { recursive: true });
await build({ ...worker, entryPoints: ['src/server/worker.ts'], outfile: 'dist/worker.mjs' });
await build({ ...worker, entryPoints: ['src/server/local.ts'], outfile: 'dist/local-worker.mjs' });
await build({ ...common, entryPoints: ['src/cli/main.ts'], outfile: 'dist/workroom.mjs', platform: 'node' });
await build({ ...common, entryPoints: ['src/cli/connection-plan.ts'], outfile: 'dist/workroom-connection-plan.mjs', platform: 'node' });
await writeFile('dist/BUILD-BOUNDARY.txt', 'worker.mjs: production fail-closed. local-worker.mjs: synthetic local testing only; never deploy.\n');

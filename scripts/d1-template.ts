// Migrate-once, clone-per-test D1. The first caller for a given (migrations content, through) builds a
// migrated template in .cache/d1-template/ (atomic rename, safe across parallel test processes); every
// test then gets a private copy in its own temp dir, so isolation is unchanged (no shared DB file).
import { Miniflare } from 'miniflare';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from './local-harness.ts';

export const D1_TEMPLATE_NAME = 'workroom-template';
const ROOT = resolve('.cache/d1-template');
const building = new Map<string, Promise<string>>();

function key(through: number) {
  const h = createHash('sha256').update(readFileSync(new URL('./local-harness.ts', import.meta.url)));
  for (const n of readdirSync('migrations').filter(n => /^\d+.*\.sql$/.test(n) && Number(n.slice(0, 4)) <= through).sort()) h.update(n).update(readFileSync('migrations/' + n));
  return through + '-' + h.digest('hex').slice(0, 16);
}

async function template(through: number) {
  const dir = join(ROOT, key(through));
  if (existsSync(dir)) return dir;
  if (!building.has(dir)) building.set(dir, (async () => {
    mkdirSync(ROOT, { recursive: true });
    const tmp = mkdtempSync(join(ROOT, '.build-'));
    const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null) } }', d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: tmp, cf: false });
    try { await migrate(await mf.getD1Database('DB'), through); } finally { await mf.dispose(); }
    try { renameSync(tmp, dir); } catch { rmSync(tmp, { recursive: true, force: true }); } // another process won
    return dir;
  })());
  return building.get(dir)!;
}

/** Fresh, already-migrated D1 persist dir for one test. Bind it as `{ DB: D1_TEMPLATE_NAME }` with `d1Persist: dir`. */
export async function cloneD1(through: number) {
  const dir = mkdtempSync(join(tmpdir(), 'workroom-d1-'));
  cpSync(await template(through), dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

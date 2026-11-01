import { Miniflare } from 'miniflare';
import { readFile,readdir } from 'node:fs/promises';
import { taskFixtures } from './task-fixtures.ts';
import { cloneD1, D1_TEMPLATE_NAME } from './d1-template.ts';

// Applies all pending migrations in ONE D1 batch (one round trip instead of ~2 per file).
// A batch is atomic, so a failing migration leaves the DB unchanged, as before for that file.
export async function migrate(db:Awaited<ReturnType<Miniflare['getD1Database']>>,through=3) {
  await db.prepare('CREATE TABLE IF NOT EXISTS local_migrations(name TEXT PRIMARY KEY)').run();
  const applied=new Set((await db.prepare('SELECT name FROM local_migrations').all<{name:string}>()).results.map((r:{name:string})=>r.name));
  const pending=(await readdir('migrations')).filter(n=>/^\d+.*\.sql$/.test(n)&&Number(n.slice(0,4))<=through&&!applied.has(n)).sort();
  if(!pending.length) return;
  const legacyPrincipals=!!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='principals'").first();
  const statements=[];
  for(const name of pending) {
    const legacy=name.startsWith('0001')&&legacyPrincipals;
    if(!legacy) for(const s of (await readFile('migrations/'+name,'utf8')).trim().split(/;\s*\n/).filter(s=>s.trim())) statements.push(db.prepare(s));
    statements.push(db.prepare('INSERT INTO local_migrations(name) VALUES (?)').bind(name));
  }
  if(!statements.length) return;
  await db.batch(statements);
}

export async function harness(options: { port?: number; persist?: string; production?: boolean; seed?: boolean; through?: number; bindings?: Record<string, string | number>; outboundService?: (request: Request) => Response | Promise<Response> } = {}) {
  const d1 = options.persist ? null : await cloneD1(options.through ?? 3);
  const mf = new Miniflare({ modules: true, scriptPath: options.production ? 'dist/worker.mjs' : 'dist/local-worker.mjs',
    compatibilityDate: '2026-07-28', host: '127.0.0.1', port: options.port ?? 0,
    d1Databases: { DB: d1 ? D1_TEMPLATE_NAME : 'workroom-local' }, r2Buckets: { FILES: 'workroom-local-files' }, d1Persist: options.persist ?? d1!.dir, cf: false,
    ...(options.bindings ? { bindings: options.bindings } : {}),
    ...(options.outboundService ? { outboundService: options.outboundService } : {}),
  });
  await mf.ready;
  const db = await mf.getD1Database('DB');
  await migrate(db,options.through??3);
  if (options.seed !== false) {
    await db.batch([
      db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
      ...['alpha','beta','reader','outsider'].map(name => db.prepare('INSERT INTO principals(id) VALUES (?)').bind('synthetic:' + name)),
      ...['alpha','beta','reader'].map(name => db.prepare('INSERT INTO memberships(principal_id,room_id,can_post) VALUES (?, ?, ?)')
        .bind('synthetic:' + name, 'room_main', name === 'reader' ? 0 : 1)),
    ]);
  }
  if((options.through??3)>=3 && await db.prepare("SELECT 1 FROM principals WHERE id='synthetic:alpha'").first())await taskFixtures(db);
  return { mf, db, url: String(await mf.ready), close: () => mf.dispose().then(() => d1?.cleanup()) };
}

import type { Miniflare } from 'miniflare';

// Explicit synthetic-only fixture upgrade, separate from schema migrations. Never restores revoked grants.
export async function taskFixtures(db:Awaited<ReturnType<Miniflare['getD1Database']>>) {
  await db.prepare('CREATE TABLE IF NOT EXISTS local_fixture_versions(name TEXT PRIMARY KEY)').run();
  if(await db.prepare("SELECT 1 FROM local_fixture_versions WHERE name='g3-v1'").first())return;
  await db.batch([
    db.prepare("INSERT INTO principals(id) VALUES ('synthetic:human') ON CONFLICT(id) DO NOTHING"),
    db.prepare("INSERT INTO memberships(principal_id,room_id,can_post) VALUES ('synthetic:human','room_main',1) ON CONFLICT(principal_id,room_id) DO NOTHING"),
    ...['alpha','beta','reader','outsider','human'].map(name=>db.prepare('INSERT INTO principal_roles(principal_id,kind) SELECT ?,? WHERE EXISTS (SELECT 1 FROM principals WHERE id=?) ON CONFLICT(principal_id) DO NOTHING').bind('synthetic:'+name,name==='human'?'user':'agent','synthetic:'+name)),
    db.prepare("INSERT INTO local_fixture_versions(name) VALUES ('g3-v1')"),
  ]);
}

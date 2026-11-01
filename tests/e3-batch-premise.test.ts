import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness } from '../scripts/local-harness.ts';

// E3 premise: one D1 batch is all-or-nothing, and a guard that raises names the op index.
test('E3 premise: a raising guard rolls back earlier batch statements and its error names the op index',async()=>{
  const app=await harness();
  try {
    await app.db.prepare('CREATE TABLE e3_probe(x TEXT)').run();
    const count=async()=>(await app.db.prepare('SELECT count(*) n FROM e3_probe').first<{n:number}>())!.n;
    await assert.rejects(app.db.batch([
      app.db.prepare("INSERT INTO e3_probe(x) VALUES ('applied')"),
      app.db.prepare("SELECT json_extract('{}',CASE WHEN 0 THEN '$' ELSE 'batch_abort:'||? END)").bind(3),
    ]),/batch_abort:3/);
    assert.equal(await count(),0);
    await app.db.batch([app.db.prepare("INSERT INTO e3_probe(x) VALUES ('applied')"),app.db.prepare("SELECT json_extract('{}',CASE WHEN 1 THEN '$' ELSE 'batch_abort:'||? END)").bind(0)]);
    assert.equal(await count(),1);
  } finally { await app.close(); }
});

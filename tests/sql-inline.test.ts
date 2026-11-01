import { test } from 'node:test'; import assert from 'node:assert/strict';
import { inline } from '../scripts/sql-inline.mts';
test('inline escapes quotes, numbers, null', () => {
  assert.equal(inline('INSERT INTO t VALUES (?,?,?)', ["a'b", 1, null]), "INSERT INTO t VALUES ('a''b',1,NULL)");
});

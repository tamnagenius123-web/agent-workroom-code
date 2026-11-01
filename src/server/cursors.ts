import { z } from 'zod';
import { Fault, ROOM } from './contracts.ts';
import { AUTH } from './policy.ts';
import type { Database } from './db.ts';

export class Cursors {
  constructor(private db: Database, private principal: string) {}
  async save(kind: string, scope: object, payload: object) {
    const id = crypto.randomUUID();
    const row = await this.db.prepare(`INSERT INTO page_tokens(id,principal_id,room_id,kind,scope_json,payload_json,created_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS (${AUTH}) RETURNING id`)
      .bind(id,this.principal,ROOM,kind,JSON.stringify(scope),JSON.stringify(payload),new Date().toISOString(),this.principal,ROOM)
      .first<{ id: string }>();
    if (!row) throw new Fault('FORBIDDEN','Room access denied.',403);
    return id;
  }
  async load<T>(id: string, kind: string, scope: object): Promise<T> {
    if (!z.uuid().safeParse(id).success) throw new Fault('INVALID_INPUT','Invalid cursor or receipt.');
    const row = await this.db.prepare('SELECT principal_id,room_id,kind,scope_json,payload_json FROM page_tokens WHERE id=?')
      .bind(id).first<{ principal_id: string; room_id: string; kind: string; scope_json: string; payload_json: string }>();
    if (!row || row.principal_id!==this.principal || row.room_id!==ROOM || row.kind!==kind || row.scope_json!==JSON.stringify(scope))
      throw new Fault('FORBIDDEN','Cursor or receipt access denied.',403);
    return JSON.parse(row.payload_json) as T;
  }
}

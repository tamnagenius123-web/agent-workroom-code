import { searchMessages } from './memory.ts';
import { proposeItem, proposePromotion, promotionChain, proposeSupersede, validView, type MemoryKind } from './memory-items.ts';
import { reviewItem, reviewEdge, prepareReview, reviewsAwaiting, unknownItem, unknownEdge } from './memory-review.ts';
import { contextPack } from './context-pack.ts';
import { roomBrief } from './room-brief.ts';
import { ownerMemory } from './memory-hook.ts';
import { proposeFold, reviewFold, reviewFoldEdge, foldView } from './fold.ts';
import { foldedContextPack } from './fold-pack.ts';
import { skillGrade, endorseSkill } from './skill-grade.ts';
import { proposeExperience, observeExperience, judgeExperience, experienceView } from './experience.ts';
import { recordReads, latencyStats } from './latency.ts';
import { ROOM, VERSION, Fault, type Message, type Post, type Read, type Stored, type WakeProofQuery, type WakeReportInput } from './contracts.ts';
import type { Database } from './db.ts';
import { AUTH } from './policy.ts';
import { Conversation } from './conversation.ts';
import { handoffsAddressedTo } from './receipts-wire.ts';
import { Tasks, type WrgitClaim } from './tasks.ts';
import { Webhooks, deliver, mentionsFor, planNotify, NO_WAKE_AUTH, type Defer, type WakeAuth } from './notify.ts';
import { WakeProofs } from './wake.ts';
import { run, sha256, type Plan, type Row } from './mutations.ts';

// Used both outside and inside the mutation transaction; no cached grants.

export class Workroom {
  readonly g2:Conversation;
  readonly tasks:Tasks;
  readonly webhooks:Webhooks;
  readonly wake:WakeProofs;
  constructor(private db: Database, readonly principal: string, private defer?: Defer, private wakeAuth: WakeAuth = NO_WAKE_AUTH, wrgit?: WrgitClaim) { this.webhooks=new Webhooks(db,principal,wakeAuth); this.wake=new WakeProofs(db,principal); this.g2=new Conversation(db,principal,(room,write)=>this.authorize(room,write)); this.tasks=new Tasks(db,principal,(room,write)=>this.authorize(room,write),wrgit); }

  get database(): Database { return this.db; }
  async authorize(room = ROOM, write = false): Promise<void> {
    if (room !== ROOM || !await this.db.prepare(AUTH + (write ? ' AND m.can_post=1' : ''))
      .bind(this.principal, room).first()) {
      throw new Fault('FORBIDDEN', 'Room access denied.', 403);
    }
  }

  async capabilities() {
    await this.authorize();
    return { schema_version: VERSION, room_id: ROOM, mode: 'synthetic-local',
      operations: ['capabilities', 'whoami', 'room.read', 'room.unread', 'room.mentions', 'webhook.set', 'webhook.get', 'webhook.delete', 'webhook.test', 'message.post', 'operation.get','thread.create','thread.read','message.revise','message.history','inbox.pull','inbox.ack','room.export','task.create','task.get','task.claim','task.renew','task.submit','task.cancel','task.approve','task.request_changes'],
      agents_connected: false, hosted_auth_verified: false,
      limits: { text_bytes: 32768, page_default: 50, page_max: 100, posts_per_minute: 60 } };
  }
  async whoami() {
    await this.authorize();
    const member = await this.db.prepare('SELECT can_post FROM memberships WHERE principal_id=? AND room_id=? AND active=1')
      .bind(this.principal, ROOM).first<{ can_post: number }>();
    return { principal_id: this.principal, synthetic: this.principal.startsWith('synthetic:'), room_id: ROOM, can_post: member?.can_post === 1 };
  }

  // Per-principal read cursor (D1 read_cursors). Returns messages after the cursor, oldest first; advances it
  // monotonically unless peek. Content is untrusted data.
  async withMentions<T extends { id: string }>(messages: T[]) {
    const map = await mentionsFor(this.db, messages.map(m => m.id));
    // Fields present only when a message has mentions, so plain messages keep their exact stored shape.
    return messages.map(m => { const ms = map.get(m.id); return ms?.length ? { ...m, mentions: ms, mentions_me: ms.includes(this.principal) } : m; });
  }
  // mentions_only uses a separate cursor (mention_cursors) so it never skips ordinary unread messages.
  async unread(input: { room: string; limit: number; peek: boolean; mentions_only?: boolean }) {
    await this.authorize(input.room);
    const table = input.mentions_only ? 'mention_cursors' : 'read_cursors';
    const cur = await this.db.prepare(`SELECT last_seq FROM ${table} WHERE principal_id=? AND room_id=?`).bind(this.principal, ROOM).first<{ last_seq: number }>();
    const after = cur?.last_seq ?? 0;
    const rows = (input.mentions_only
      ? await this.db.prepare('SELECT c.* FROM message_current c JOIN message_mentions mm ON mm.message_id=c.id AND mm.principal_id=? WHERE c.room_id=? AND c.seq>? ORDER BY c.seq LIMIT ?').bind(this.principal, ROOM, after, input.limit + 1)
      : this.db.prepare('SELECT * FROM message_current WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?').bind(ROOM, after, input.limit + 1)).all<Message & { seq: number }>();
    const rowsR = (await rows).results;
    const has_more = rowsR.length > input.limit, page = rowsR.slice(0, input.limit);
    const last = page.length ? page.at(-1)!.seq : after;
    if (!input.peek && last > after) await this.db.prepare('INSERT INTO '+table+'(principal_id,room_id,last_seq,updated_at) VALUES (?,?,?,?) ON CONFLICT(principal_id,room_id) DO UPDATE SET last_seq=MAX(last_seq,excluded.last_seq),updated_at=excluded.updated_at')
      .bind(this.principal, ROOM, last, Date.now()).all();
    if (!input.peek) await recordReads(this.db, this.principal, input.mentions_only ? 'mentions_only' : 'unread', page);
    return { data: { messages: await this.withMentions(page.map(({ seq: _, ...m }) => { void _; return m; })) },
      meta: { count: page.length, has_more, peek: input.peek, mentions_only: !!input.mentions_only, advanced: !input.peek && last > after, first_read: !cur } };
  }

  async read(input: Read) {
    await this.authorize(input.room);
    const scope={room:input.room};
    const after=input.cursor?(await this.g2.cursors.load<{after:number}>(input.cursor,'room',scope)).after:0;
    const rows = (await this.db.prepare(`SELECT *
      FROM message_current WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?`)
      .bind(ROOM, after, input.limit + 1).all<Message & { seq: number }>()).results;
    const has_more = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const next_cursor = has_more ? await this.g2.cursors.save('room',scope,{after:page.at(-1)!.seq}):null;
    return { data: { messages: await this.withMentions(page.map(({seq:_,...message})=>{void _;return message;})) },
      meta: { next_cursor, has_more } };
  }

  async memorySearch(input: { room: string; query: string; limit: number; before?: string }) { await this.authorize(input.room); return { data: { hits: await searchMessages(this.db as never, input.room, input.query, input.limit, input.before) } }; }
  async memoryPropose(i: { room: string; kind: MemoryKind; tier: number; title: string; body: string; source_message_id: string; valid_from: string; valid_until?: string }) {
    await this.authorize(i.room, true);
    return { data: { item: await proposeItem(this.db, this.principal, { room_id: i.room, kind: i.kind, tier: i.tier, title: i.title, body: i.body, source_message_id: i.source_message_id, valid_from: i.valid_from, valid_until: i.valid_until }) } };
  }
  async memorySupersede(i: { room: string; old_id: string; new_id: string }) { await this.authorize(i.room, true); await this.sameRoomItem(i.room, i.old_id); await this.sameRoomItem(i.room, i.new_id); return { data: { edge: await proposeSupersede(this.db, this.principal, i.old_id, i.new_id) } }; }
  async memoryPromote(i: { room: string; from_id: string; title: string; body: string }) {
    await this.authorize(i.room, true);
    await this.sameRoomItem(i.room, i.from_id);
    const p = await proposePromotion(this.db, this.principal, { from_id: i.from_id, title: i.title, body: i.body });
    return { data: { ...p, chain: await promotionChain(this.db, p.item.id) } };
  }
  async reviewPrepare(i: { room: string; target: 'item' | 'edge'; id: string }) { await this.authorize(i.room); if (i.target === 'item') await this.sameRoomItem(i.room, i.id); else await this.sameRoomEdge(i.room, i.id); return { data: await prepareReview(this.db, i.target, i.id) }; }
  async memoryReview(i: { room: string; target: 'item' | 'edge'; id: string; verdict: 'approve' | 'reject'; reason: string; content_digest: string }) { await this.authorize(i.room, true); if (i.target === 'item') await this.sameRoomItem(i.room, i.id); else await this.sameRoomEdge(i.room, i.id); const f = i.target === 'item' ? reviewItem : reviewEdge; return { data: { [i.target]: await f(this.db, this.principal, i.id, i.verdict, i.reason, i.content_digest) } }; }
  async memoryView(i: { room: string; kinds?: MemoryKind[]; at?: string; include_pending: boolean }) { await this.authorize(i.room); return { data: { items: await validView(this.db, i.room, { kinds: i.kinds, at: i.at, includePending: i.include_pending }) } }; }
  async contextPack(i: { room: string; task: string; budget_chars: number; at?: string; folds?: boolean }) { await this.authorize(i.room); const pack = i.folds ? await foldedContextPack(this.db, i.room, i.task, i.budget_chars, i.at) : await contextPack(this.db, i.room, i.task, i.budget_chars, i.at); const om = await ownerMemory(this.db, { kind: 'handoff', text: i.task }); return { data: om ? { owner_memory: om, ...pack } : pack }; }
  async foldPropose(i: { room: string; id?: string; summary: string; valid_from: string; message_ids?: string[]; child_fold_ids?: string[]; supersedes?: string }) { await this.authorize(i.room, true); return { data: await proposeFold(this.db, this.principal, { id: i.id, room_id: i.room, summary: i.summary, valid_from: i.valid_from, message_ids: i.message_ids, child_fold_ids: i.child_fold_ids, supersedes: i.supersedes }) }; }
  async foldReview(i: { room: string; target: 'fold' | 'edge'; id: string; verdict: 'approve' | 'reject'; reason: string; content_digest: string }) { await this.authorize(i.room, true); return { data: i.target === 'fold' ? { fold: await reviewFold(this.db, this.principal, i.room, i.id, i.verdict, i.reason, i.content_digest) } : { edge: await reviewFoldEdge(this.db, this.principal, i.room, i.id, i.verdict, i.reason, i.content_digest) } }; }
  async foldView(i: { room: string; at?: string; include_pending: boolean }) { await this.authorize(i.room); return { data: await foldView(this.db, i.room, { at: i.at, includePending: i.include_pending }) }; }
  async briefGet(i: { room: string; at?: string; max_chars?: number; task?: string; kind?: 'handoff' | 'question' | 'decision' }) { await this.authorize(i.room); return { data: await roomBrief(this.db, i.room, { at: i.at, maxChars: i.max_chars, task: i.task, kind: i.kind }) }; }
  // MEM-HOOK: question/decision points. Same block as the brief; null owner_memory when 0045 is absent.
  async memoryRecall(i: { room: string; kind: 'handoff' | 'question' | 'decision'; text: string }) { await this.authorize(i.room); return { data: { owner_memory: await ownerMemory(this.db, { kind: i.kind, text: i.text }) } }; }
  async skillGrade(i: { room: string; id: string }) { await this.authorize(i.room); await this.sameRoomItem(i.room, i.id); return { data: await skillGrade(this.db, i.id) }; }
  async skillEndorse(i: { room: string; id: string; reason: string; content_digest: string }) { await this.authorize(i.room, true); await this.sameRoomItem(i.room, i.id); return { data: await endorseSkill(this.db, this.principal, i.id, i.reason, i.content_digest) }; }
  async experiencePropose(i: { room: string; component: string; change: string; prediction: string; source_message_id: string }) { await this.authorize(i.room, true); return { data: { entry: await proposeExperience(this.db, this.principal, { room_id: i.room, component: i.component, change: i.change, prediction: i.prediction, source_message_id: i.source_message_id }) } }; }
  async experienceObserve(i: { room: string; id: string; outcome: string; outcome_message_id: string }) { await this.authorize(i.room, true); await this.sameRoomExperience(i.room, i.id); return { data: { entry: await observeExperience(this.db, this.principal, i.id, i.outcome, i.outcome_message_id) } }; }
  async experienceVerdict(i: { room: string; id: string; verdict: 'keep' | 'revert'; reason: string; content_digest: string }) { await this.authorize(i.room, true); await this.sameRoomExperience(i.room, i.id); return { data: { entry: await judgeExperience(this.db, this.principal, i.id, i.verdict, i.reason, i.content_digest) } }; }
  async experienceView(i: { room: string; states?: string[]; component?: string; limit: number }) { await this.authorize(i.room); return { data: { entries: await experienceView(this.db, i.room, { states: i.states, component: i.component, limit: i.limit }) } }; }
  // rev2 (Codex 576d5575): every ID-addressed memory call is bound to the authorized room; an ID from another room reads as unknown.
  private async sameRoomItem(room: string, id: string) { const r = await this.db.prepare('SELECT room_id FROM memory_items WHERE id=?').bind(id).first<{ room_id: string }>(); if (!r || r.room_id !== room) throw unknownItem(); }
  private async sameRoomEdge(room: string, id: string) { const r = await this.db.prepare('SELECT s.room_id AS src_room, d.room_id AS dst_room FROM memory_edges e JOIN memory_items s ON s.id=e.src_id JOIN memory_items d ON d.id=e.dst_id WHERE e.id=?').bind(id).first<{ src_room: string; dst_room: string }>(); if (!r || r.src_room !== room || r.dst_room !== room) throw unknownEdge(); }
  private async sameRoomExperience(room: string, id: string) { const r = await this.db.prepare('SELECT room_id FROM experience_entries WHERE id=?').bind(id).first<{ room_id: string }>(); if (!r || r.room_id !== room) throw new Fault('INVALID_INPUT', 'Unknown experience entry in this room'); }
  async latency(input: { room: string; hours: number }) { await this.authorize(input.room); return { data: await latencyStats(this.db, input.hours * 3600_000) }; }
  // Messages that mention this principal, newest first (does not move any cursor).
  async wakeReport(input: WakeReportInput) { await this.authorize(input.room, true); return this.wake.report(input); }
  async wakeProof(input: WakeProofQuery) { await this.authorize(input.room); return this.wake.proof(input); }
  async myQueue(input: { room: string }) {
    await this.authorize(input.room);
    const tasks = await this.tasks.mine(input);
    const reviews = await reviewsAwaiting(this.db, this.principal, input.room);
    const handoffs = await handoffsAddressedTo(this.db, this.principal, input.room);
    // MEM-HOOK: queue pickup is a handoff point; recall is keyed on the queued work's text.
    const om = await ownerMemory(this.db, { kind: 'handoff', text: JSON.stringify(tasks).slice(0, 2000) });
    return { data: { ...(om ? { owner_memory: om } : {}), tasks, reviews, handoffs }, meta: {} };
  }
  async mentions(input: { room: string; limit: number }) {
    await this.authorize(input.room);
    const rows = (await this.db.prepare('SELECT c.*, mm.via FROM message_current c JOIN message_mentions mm ON mm.message_id=c.id AND mm.principal_id=? WHERE c.room_id=? ORDER BY c.seq DESC LIMIT ?')
      .bind(this.principal, ROOM, input.limit).all<Message & { seq: number; via: string }>()).results;
    return { data: { messages: await this.withMentions(rows.map(({ seq: _, ...m }) => { void _; return m; })) }, meta: { count: rows.length } };
  }

  async post(input: Post) { return run(this.db, await this.planPost(input)); }
  async planPost(input: Post): Promise<Plan<{ data: Stored; meta: { idempotency_key: string; replayed: boolean } }>> {
    await this.authorize(input.room, true);
    const link=await this.g2.postLink(input.room,input.thread_id,input.reply_to_message_id);
    const hash = await sha256(JSON.stringify({ schema_version: VERSION, room: input.room, text: input.text, format: input.format,
      ...(input.thread_id?{thread_id:input.thread_id,reply_to_message_id:input.reply_to_message_id??null}:{}) }));
    const now = new Date().toISOString();
    const minute = now.slice(0, 16) + ':00.000Z';
    const id = crypto.randomUUID();
    const data: Stored = { message: { id, room_id: ROOM, actor_id: this.principal,
      text: input.text, format: input.format, created_at: now },
      operation: { type: 'message.post', idempotency_key: input.idempotency_key } };
    const args = [this.principal, 'message.post', input.idempotency_key];
    const notify = await planNotify(this.db, data.message);
    // Conditional inserts keep the operation result, message and audit atomic.
    // A replay has the old generated message ID, so cannot create another message.
    const statements = [
      this.db.prepare(`INSERT INTO operations(principal_id,operation,key,room_id,request_hash,result_json,created_at)
        SELECT ?,?,?,?,?,?,? WHERE EXISTS (${AUTH} AND m.can_post=1) AND (${link.sql})
        AND (SELECT count(*) FROM operations WHERE principal_id=? AND created_at>=?) < 60
        ON CONFLICT(principal_id,operation,key) DO NOTHING`)
        .bind(...args, ROOM, hash, JSON.stringify(data), now, this.principal, ROOM,...link.args, this.principal, minute),
      this.db.prepare(`INSERT INTO messages(id,room_id,actor_id,text,format,created_at)
        SELECT ?,?,?,?,?,? FROM operations WHERE principal_id=? AND operation=? AND key=?
        AND json_extract(result_json,'$.message.id')=?`)
        .bind(id, ROOM, this.principal, input.text, input.format, now, ...args, id),
      ...(input.thread_id?[this.db.prepare(`INSERT INTO message_links(message_id,thread_id,reply_to_message_id)
        SELECT ?,?,? FROM messages WHERE id=?`).bind(id,input.thread_id,input.reply_to_message_id??null,id)]:[]),
      this.db.prepare(`INSERT INTO audit(id,principal_id,room_id,action,message_id,created_at)
        SELECT ?,?,?,'message.post',?,? FROM messages WHERE id=?`)
        .bind(crypto.randomUUID(), this.principal, ROOM, id, now, id),
      ...notify.statements,
      this.db.prepare(`SELECT request_hash,result_json FROM operations
        WHERE principal_id=? AND operation=? AND key=? AND EXISTS (${AUTH} AND m.can_post=1)`)
        .bind(...args, this.principal, ROOM),
    ];
    const applied = { sql: `EXISTS (SELECT 1 FROM operations WHERE principal_id=? AND operation=? AND key=? AND request_hash=? AND EXISTS (${AUTH} AND m.can_post=1))`,
      args: [...args, hash, this.principal, ROOM] };
    const finish = async (row: Row | undefined) => {
      if (!row) {
        await this.authorize(input.room, true);
        throw new Fault('RATE_LIMITED', 'Post limit reached; retry the same key later.', 429, 'not_applied', true,
          { retry_after: 60 - new Date().getUTCSeconds() });
      }
      if (row.request_hash !== hash) throw new Fault('IDEMPOTENCY_CONFLICT', 'Key already has different content.', 409,
        'not_applied', false, { operation: 'message.post', idempotency_key: input.idempotency_key,
          lookup: `/api/v1/operations/message.post/${input.idempotency_key}` });
      const stored = JSON.parse(row.result_json) as Stored;
      const replayed = stored.message.id !== id;
      let mentions: string[];
      if (!replayed) {
        const r = notify;
        mentions = r.mentions;
        if (r.deliveries.length) { const p = deliver(this.db, r.deliveries, this.wakeAuth).catch(() => 0); if (this.defer) this.defer(p); else await p; }
      } else mentions = (await mentionsFor(this.db, [stored.message.id])).get(stored.message.id) ?? [];
      return { data: mentions.length ? { ...stored, message: { ...stored.message, mentions } } : stored, meta: { idempotency_key: input.idempotency_key, replayed } };
    };
    return { statements, applied, finish };
  }

  async operation(key: string,operation='message.post') {
    await this.authorize();
    const row = await this.db.prepare('SELECT result_json FROM operations WHERE principal_id=? AND operation=? AND key=?')
      .bind(this.principal, operation, key).first<{ result_json: string }>();
    if (!row) throw new Fault('NOT_FOUND', 'No recorded operation for this principal and key.', 404);
    return { data: JSON.parse(row.result_json) as Stored, meta: { idempotency_key: key, replayed: true } };
  }
}

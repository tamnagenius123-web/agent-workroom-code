import { Fault } from './contracts.ts';

// OCG-W rev2 (Codex 576d5575): instants and content digests.
// Instants are stored as UTC 'YYYY-MM-DDTHH:MM:SS.sssZ', so SQLite text order is time order.
// Digests hash a versioned JSON array, so no field can borrow a delimiter from its neighbour.

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const utf8 = new TextEncoder();

/** Parse an ISO-8601 instant with a timezone and return it as UTC with millisecond precision. */
export function instant(value: unknown, field: string): string {
  const bad = (): never => { throw new Fault('INVALID_INPUT', `${field} must be an ISO-8601 timestamp with a timezone`); };
  if (typeof value !== 'string') return bad();
  const m = ISO.exec(value);
  if (!m) return bad();
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  const frac = m[7] ?? '';
  if (/[1-9]/.test(frac.slice(3))) throw new Fault('INVALID_INPUT', `${field} has sub-millisecond precision, which is not stored`);
  const ms = Number((frac + '000').slice(0, 3));
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return bad();
  const local = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const check = new Date(local);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return bad();
  let offset = 0;
  if (m[8] !== 'Z') {
    const oh = Number(m[10]);
    const om = Number(m[11]);
    if (oh > 23 || om > 59) return bad();
    offset = (oh * 60 + om) * 60_000 * (m[9] === '-' ? -1 : 1);
  }
  const utc = new Date(local - offset);
  const year = utc.getUTCFullYear();
  if (year < 0 || year > 9999) return bad();
  return utc.toISOString();
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export interface ItemCanonFields { id: string; room_id: string; kind: string; tier: number; title: string; body: string; valid_from: string; source_message_id: string; source_version: number | null }
export interface EdgeCanonFields { id: string; src_id: string; dst_id: string; type: string }
export interface ExperienceCanonFields { id: string; room_id: string; component: string; change: string; prediction: string; source_message_id: string; source_version: number | null; outcome: string | null; outcome_message_id: string | null; outcome_message_version: number | null }

/** JSON.stringify(["workroom.memory_item.v2", id, room_id, kind, tier, title, body, valid_from, source_message_id, source_version]). valid_until is not bound: closing a window is the edge review's job. */
export function itemCanonical(i: ItemCanonFields): string {
  return JSON.stringify(['workroom.memory_item.v2', i.id, i.room_id, i.kind, Number(i.tier), i.title, i.body, i.valid_from, i.source_message_id, i.source_version === null ? null : Number(i.source_version)]);
}

/** JSON.stringify(["workroom.memory_edge.v2", id, src_id, dst_id, type]). */
export function edgeCanonical(e: EdgeCanonFields): string {
  return JSON.stringify(['workroom.memory_edge.v2', e.id, e.src_id, e.dst_id, e.type]);
}

/** JSON.stringify(["workroom.experience.v2", id, room_id, component, change, prediction, source_message_id, source_version, outcome, outcome_message_id, outcome_message_version]). */
export function experienceCanonical(e: ExperienceCanonFields): string {
  const n = (v: number | null) => (v === null ? null : Number(v));
  return JSON.stringify(['workroom.experience.v2', e.id, e.room_id, e.component, e.change, e.prediction, e.source_message_id, n(e.source_version), e.outcome, e.outcome_message_id, n(e.outcome_message_version)]);
}

/** Pre-rev2 item preimage (title \n body \n valid_from). Only used to keep counting reviews stored before 0018. */
export function legacyItemCanonical(title: string, body: string, validFrom: string): string {
  return `${title}\n${body}\n${validFrom}`;
}

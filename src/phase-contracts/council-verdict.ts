// P2 council verdict. The record executes immediately and stays advisory: it cannot grant
// release, security, or budget authority. owner_accepted is the owner's bit, separate from that.
// dissent and unknowns are kept. Corrections only append.
// The roadmap's "executes immediately" and the authority fence are both kept. W0 does not reconcile them.

import {
  Problems, checkKeys, defined, readArray, readEnvelope, readEnum, readId, readIso, readObject, readText,
  type PhaseCheck, type PhaseEnvelope,
} from './check.ts';

/** Explicit until an owner reconciles council policy. Not resolved from peer assertions. */
export const COUNCIL_AUTHORITY_CONFLICT = 'unresolved' as const;

export const FORBIDDEN_AUTHORITY = ['release', 'security', 'budget'] as const;
export type ForbiddenAuthority = typeof FORBIDDEN_AUTHORITY[number];

export const ROUND_NAMES = ['blind_r1', 'cross_r2'] as const;
export type RoundName = typeof ROUND_NAMES[number];

export interface CouncilRound {
  name: RoundName;
  record_ref: string;
}

export interface ChairRecord {
  chair_id: string;
  record_ref: string;
  summary: string;
}

export interface DissentEntry {
  member_id: string;
  text: string;
}

export interface UnknownEntry {
  topic: string;
  note: string;
}

export interface CouncilCorrection {
  correction_id: string;
  seq: number;
  text: string;
  at: string;
}

export interface CouncilVerdict extends PhaseEnvelope {
  agenda_id: string;
  rounds: CouncilRound[];
  chair: ChairRecord;
  dissent: DissentEntry[];
  unknowns: UnknownEntry[];
  executes_immediately: true;
  owner_report_ref: string;
  owner_accepted: boolean | null;
  corrections: CouncilCorrection[];
  authority: [];
}

const VERDICT_KEYS = [
  'schema_version', 'consumer', 'provenance', 'proof_mode',
  'agenda_id', 'rounds', 'chair', 'dissent', 'unknowns', 'executes_immediately',
  'owner_report_ref', 'owner_accepted', 'corrections', 'authority',
] as const;
const ROUND_KEYS = ['name', 'record_ref'] as const;
const CHAIR_KEYS = ['chair_id', 'record_ref', 'summary'] as const;
const DISSENT_KEYS = ['member_id', 'text'] as const;
const UNKNOWN_KEYS = ['topic', 'note'] as const;
const CORRECTION_KEYS = ['correction_id', 'seq', 'text', 'at'] as const;

function readRounds(problems: Problems, obj: Record<string, unknown>): CouncilRound[] | undefined {
  const rows = readArray(problems, obj, 'rounds', 'council_verdict');
  if (!rows) return undefined;
  const rounds: CouncilRound[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const path = `council_verdict.rounds[${i}]`;
    const row = readObject(problems, rows[i], path);
    if (!row) continue;
    checkKeys(problems, row, ROUND_KEYS, path);
    const name = readEnum(problems, row, 'name', path, ROUND_NAMES);
    const record_ref = readId(problems, row, 'record_ref', path);
    if (defined(name) && defined(record_ref)) rounds.push({ name, record_ref });
  }
  if (rounds.length !== 2 || rounds[0]?.name !== 'blind_r1' || rounds[1]?.name !== 'cross_r2') {
    problems.add('council_verdict.rounds', 'expected blind_r1 then cross_r2');
  }
  return rounds;
}

function readChair(problems: Problems, obj: Record<string, unknown>): ChairRecord | undefined {
  const path = 'council_verdict.chair';
  const row = readObject(problems, obj.chair, path);
  if (!row) return undefined;
  checkKeys(problems, row, CHAIR_KEYS, path);
  const chair_id = readId(problems, row, 'chair_id', path);
  const record_ref = readId(problems, row, 'record_ref', path);
  const summary = readText(problems, row, 'summary', path);
  if (!defined(chair_id) || !defined(record_ref) || !defined(summary)) return undefined;
  return { chair_id, record_ref, summary };
}

function readEntries<T>(
  problems: Problems, obj: Record<string, unknown>, key: 'dissent' | 'unknowns', fields: readonly [string, string],
): T[] | undefined {
  const rows = readArray(problems, obj, key, 'council_verdict');
  if (!rows) return undefined;
  const keys = key === 'dissent' ? DISSENT_KEYS : UNKNOWN_KEYS;
  const entries: T[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const path = `council_verdict.${key}[${i}]`;
    const row = readObject(problems, rows[i], path);
    if (!row) continue;
    checkKeys(problems, row, keys, path);
    const left = key === 'dissent' ? readId(problems, row, fields[0], path) : readText(problems, row, fields[0], path, 200);
    const right = readText(problems, row, fields[1], path);
    if (defined(left) && defined(right)) entries.push({ [fields[0]]: left, [fields[1]]: right } as T);
  }
  return entries;
}

function readCorrections(problems: Problems, obj: Record<string, unknown>): CouncilCorrection[] | undefined {
  const rows = readArray(problems, obj, 'corrections', 'council_verdict');
  if (!rows) return undefined;
  const corrections: CouncilCorrection[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    const path = `council_verdict.corrections[${i}]`;
    const row = readObject(problems, rows[i], path);
    if (!row) continue;
    checkKeys(problems, row, CORRECTION_KEYS, path);
    const correction_id = readId(problems, row, 'correction_id', path);
    const seqRaw = row.seq;
    const text = readText(problems, row, 'text', path);
    const at = readIso(problems, row, 'at', path);
    if (typeof seqRaw !== 'number' || !Number.isSafeInteger(seqRaw) || seqRaw !== i + 1) {
      problems.add(`${path}.seq`, `append-only seq must be ${i + 1}`);
    }
    if (defined(correction_id) && seen.has(correction_id)) problems.add(path, 'duplicate correction_id');
    if (defined(correction_id)) seen.add(correction_id);
    if (defined(correction_id) && defined(text) && defined(at) && typeof seqRaw === 'number' && seqRaw === i + 1) {
      corrections.push({ correction_id, seq: seqRaw, text, at });
    }
  }
  return corrections;
}

function readAuthority(problems: Problems, obj: Record<string, unknown>): [] | undefined {
  const rows = readArray(problems, obj, 'authority', 'council_verdict');
  if (!rows) return undefined;
  if (rows.length === 0) return [];
  for (let i = 0; i < rows.length; i += 1) {
    const item = rows[i];
    const name = typeof item === 'string' ? item : JSON.stringify(item);
    if (typeof item === 'string' && (FORBIDDEN_AUTHORITY as readonly string[]).includes(item)) {
      problems.add(`council_verdict.authority[${i}]`, `${item} is a forbidden authority`);
    } else {
      problems.add(`council_verdict.authority[${i}]`, `${name} is not grantable; council authority stays empty`);
    }
  }
  return undefined;
}

function readOwnerAccepted(problems: Problems, obj: Record<string, unknown>): boolean | null | undefined {
  if (!('owner_accepted' in obj)) {
    problems.add('council_verdict.owner_accepted', 'required (boolean or null), independent of executes_immediately');
    return undefined;
  }
  const value = obj.owner_accepted;
  if (value === null) return null;
  if (typeof value !== 'boolean') {
    problems.add('council_verdict.owner_accepted', 'expected a boolean or null');
    return undefined;
  }
  return value;
}

export function validateCouncilVerdict(input: unknown): PhaseCheck<CouncilVerdict> {
  const problems = new Problems();
  const obj = readObject(problems, input, 'council_verdict');
  if (!obj) return problems.fail();
  checkKeys(problems, obj, VERDICT_KEYS, 'council_verdict');
  const envelope = readEnvelope(problems, obj, 'council_verdict');
  const agenda_id = readId(problems, obj, 'agenda_id', 'council_verdict');
  const rounds = readRounds(problems, obj);
  const chair = readChair(problems, obj);
  const dissent = readEntries<DissentEntry>(problems, obj, 'dissent', ['member_id', 'text']);
  const unknowns = readEntries<UnknownEntry>(problems, obj, 'unknowns', ['topic', 'note']);
  if (obj.executes_immediately !== true) {
    problems.add('council_verdict.executes_immediately', 'must be true; owner_accepted is a separate bit');
  }
  const owner_report_ref = readId(problems, obj, 'owner_report_ref', 'council_verdict');
  const owner_accepted = readOwnerAccepted(problems, obj);
  const corrections = readCorrections(problems, obj);
  const authority = readAuthority(problems, obj);
  if (!defined(envelope) || !defined(agenda_id) || !defined(rounds) || !defined(chair) || !defined(dissent) || !defined(unknowns)
    || obj.executes_immediately !== true || !defined(owner_report_ref) || owner_accepted === undefined
    || !defined(corrections) || authority === undefined || problems.bad) {
    return problems.fail();
  }
  const value: CouncilVerdict = {
    ...envelope,
    agenda_id, rounds, chair, dissent, unknowns, executes_immediately: true, owner_report_ref,
    owner_accepted, corrections, authority,
  };
  return { ok: true, value };
}

/** Append one correction. Prior corrections, dissent, and unknowns are copied, not rewritten. */
export function appendCorrection(verdict: CouncilVerdict, correction: unknown): PhaseCheck<CouncilVerdict> {
  return validateCouncilVerdict({
    schema_version: verdict.schema_version,
    consumer: verdict.consumer,
    provenance: { ...verdict.provenance },
    proof_mode: verdict.proof_mode,
    agenda_id: verdict.agenda_id,
    rounds: verdict.rounds.map(round => ({ ...round })),
    chair: { ...verdict.chair },
    dissent: verdict.dissent.map(entry => ({ ...entry })),
    unknowns: verdict.unknowns.map(entry => ({ ...entry })),
    executes_immediately: verdict.executes_immediately,
    owner_report_ref: verdict.owner_report_ref,
    owner_accepted: verdict.owner_accepted,
    corrections: [...verdict.corrections.map(entry => ({ ...entry })), correction],
    authority: verdict.authority,
  });
}

// P2 council record. Pure: no clock, no I/O, no migration.
// Migration 0030 stays reserved. src/phase-contracts/ is not edited.
// The chair seal executes immediately and still grants no release, security, or budget authority.
// owner_accepted is a separate bit. Corrections append and link to the prior snapshot.
// COUNCIL_AUTHORITY_CONFLICT stays unresolved; this module does not close it.

import {
  Problems, SCHEMA_VERSION, checkKeys, defined, distinctIds, isRecord, readArray, readEnum, readEnvelope,
  readId, readIso, readObject, readText,
  type PhaseCheck, type PhaseConsumer, type ProofMode, type Provenance,
} from '../phase-contracts/check.ts';
import {
  COUNCIL_AUTHORITY_CONFLICT, FORBIDDEN_AUTHORITY, appendCorrection, validateCouncilVerdict,
  type CouncilVerdict, type DissentEntry, type UnknownEntry,
} from '../phase-contracts/council-verdict.ts';

const STANCES = ['assent', 'dissent', 'unknown'] as const;
const NOTE_KEYS = ['member_id', 'stance', 'text', 'topic'] as const;

export interface SeatNote {
  member_id: string;
  stance: typeof STANCES[number];
  text: string;
  topic?: string;
}

export interface AgendaInput {
  agenda_id: string;
  consumer: PhaseConsumer;
  provenance: Provenance;
  proof_mode: ProofMode;
  owner_report_ref: string;
}

export interface AgendaRecord {
  stage: 'agenda';
  agenda_id: string;
  consumer: PhaseConsumer;
  provenance: Provenance;
  proof_mode: ProofMode;
  owner_report_ref: string;
}

export interface RoundInput {
  record_ref: string;
  notes: readonly SeatNote[];
}

export interface BlindRoundRecord {
  stage: 'blind_r1';
  agenda: AgendaRecord;
  record_ref: string;
  notes: readonly SeatNote[];
}

export interface CrossRoundRecord {
  stage: 'cross_r2';
  blind: BlindRoundRecord;
  record_ref: string;
  notes: readonly SeatNote[];
}

export interface ChairInput {
  chair_id: string;
  record_ref: string;
  summary: string;
  executed_at: string;
}

/** Chair seal, or a later correction snapshot. The W0 verdict stays inside `verdict`. */
export interface CouncilRecord {
  verdict: CouncilVerdict;
  /** Caller-supplied instant of the chair seal. Not a W0 verdict field. */
  executed_at: string;
  /** Prior snapshot id. Null on the chair seal. */
  corrects: string | null;
  record_id: string;
}

export interface CorrectionInput {
  correction_id: string;
  text: string;
  at: string;
}

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
}

function rejectAuthority(problems: Problems, input: object, path: string): void {
  if (!isRecord(input) || !('authority' in input)) return;
  const value = input.authority;
  if (!Array.isArray(value)) {
    problems.add(`${path}.authority`, `${JSON.stringify(value)} is not grantable; council authority stays empty`);
    return;
  }
  if (value.length === 0) {
    problems.add(`${path}.authority`, 'council authority stays empty');
    return;
  }
  for (const item of value) {
    if (typeof item === 'string' && (FORBIDDEN_AUTHORITY as readonly string[]).includes(item)) {
      problems.add(`${path}.authority`, `${item} is a forbidden authority`);
    } else {
      problems.add(`${path}.authority`, `${JSON.stringify(item)} is not grantable; council authority stays empty`);
    }
  }
}

function readNotes(problems: Problems, notes: unknown, path: string): SeatNote[] | undefined {
  const rows = readArray(problems, { notes }, 'notes', path);
  if (!rows) return undefined;
  const parsed: SeatNote[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const notePath = `${path}.notes[${i}]`;
    const row = readObject(problems, rows[i], notePath);
    if (!row) continue;
    checkKeys(problems, row, NOTE_KEYS, notePath);
    const member_id = readId(problems, row, 'member_id', notePath);
    const stance = readEnum(problems, row, 'stance', notePath, STANCES);
    const text = readText(problems, row, 'text', notePath);
    if (!defined(member_id) || !defined(stance) || !defined(text)) continue;
    if (stance === 'unknown') {
      const topic = readText(problems, row, 'topic', notePath, 200);
      if (defined(topic)) parsed.push({ member_id, stance, text, topic });
      continue;
    }
    if ('topic' in row) problems.add(`${notePath}.topic`, 'topic is only kept for an unknown');
    else parsed.push({ member_id, stance, text });
  }
  if (problems.bad) return undefined;
  return parsed;
}

function project(notes: readonly SeatNote[]): { dissent: DissentEntry[]; unknowns: UnknownEntry[] } {
  const dissent: DissentEntry[] = [];
  const unknowns: UnknownEntry[] = [];
  for (const note of notes) {
    if (note.stance === 'dissent') dissent.push({ member_id: note.member_id, text: note.text });
    else if (note.stance === 'unknown' && note.topic !== undefined) unknowns.push({ topic: note.topic, note: note.text });
  }
  return { dissent, unknowns };
}

function seal(verdict: CouncilVerdict, executed_at: string, record_id: string, corrects: string | null): CouncilRecord {
  return freeze({ verdict, executed_at, corrects, record_id });
}

export function openAgenda(input: AgendaInput): PhaseCheck<AgendaRecord> {
  const problems = new Problems();
  rejectAuthority(problems, input, 'council_record.agenda');
  const agenda_id = readId(problems, { agenda_id: input.agenda_id }, 'agenda_id', 'council_record.agenda');
  const owner_report_ref = readId(problems, { owner_report_ref: input.owner_report_ref }, 'owner_report_ref', 'council_record.agenda');
  const envelope = readEnvelope(problems, {
    schema_version: SCHEMA_VERSION,
    consumer: input.consumer,
    provenance: input.provenance,
    proof_mode: input.proof_mode,
  }, 'council_record.agenda');
  if (problems.bad || !defined(agenda_id) || !defined(owner_report_ref) || !defined(envelope)) return problems.fail();
  return {
    ok: true,
    value: freeze({
      stage: 'agenda',
      agenda_id,
      consumer: envelope.consumer,
      provenance: envelope.provenance,
      proof_mode: envelope.proof_mode,
      owner_report_ref,
    }),
  };
}

export function sealBlindRound(agenda: AgendaRecord, input: RoundInput): PhaseCheck<BlindRoundRecord> {
  const problems = new Problems();
  rejectAuthority(problems, input, 'council_record.blind_r1');
  if (agenda.stage !== 'agenda') problems.add('council_record.stage', 'expected an open agenda before blind_r1');
  const record_ref = readId(problems, { record_ref: input.record_ref }, 'record_ref', 'council_record.blind_r1');
  const notes = readNotes(problems, input.notes, 'council_record.blind_r1');
  if (defined(record_ref) && record_ref === agenda.agenda_id) {
    problems.add('council_record.blind_r1.record_ref', 'record_ref duplicates agenda_id');
  }
  if (problems.bad || !defined(record_ref) || !defined(notes)) return problems.fail();
  return { ok: true, value: freeze({ stage: 'blind_r1', agenda, record_ref, notes }) };
}

export function sealCrossRound(blind: BlindRoundRecord, input: RoundInput): PhaseCheck<CrossRoundRecord> {
  const problems = new Problems();
  rejectAuthority(problems, input, 'council_record.cross_r2');
  const sealedBlind = blind.stage === 'blind_r1' && blind.agenda?.stage === 'agenda';
  if (!sealedBlind) problems.add('council_record.stage', 'expected a sealed blind_r1 round');
  const record_ref = readId(problems, { record_ref: input.record_ref }, 'record_ref', 'council_record.cross_r2');
  const notes = readNotes(problems, input.notes, 'council_record.cross_r2');
  if (sealedBlind && defined(record_ref) && (record_ref === blind.record_ref || record_ref === blind.agenda.agenda_id)) {
    problems.add('council_record.cross_r2.record_ref', 'record_ref duplicates a prior id');
  }
  if (problems.bad || !defined(record_ref) || !defined(notes)) return problems.fail();
  return { ok: true, value: freeze({ stage: 'cross_r2', blind, record_ref, notes }) };
}

export function sealChair(cross: CrossRoundRecord, input: ChairInput): PhaseCheck<CouncilRecord> {
  const problems = new Problems();
  rejectAuthority(problems, input, 'council_record.chair');
  const blind = cross.blind;
  const sealed = cross.stage === 'cross_r2' && blind?.stage === 'blind_r1' && blind.agenda?.stage === 'agenda';
  if (!sealed) problems.add('council_record.stage', 'expected blind_r1 then cross_r2');
  const chair_id = readId(problems, { chair_id: input.chair_id }, 'chair_id', 'council_record.chair');
  const record_ref = readId(problems, { record_ref: input.record_ref }, 'record_ref', 'council_record.chair');
  const summary = readText(problems, { summary: input.summary }, 'summary', 'council_record.chair');
  const executed_at = readIso(problems, { executed_at: input.executed_at }, 'executed_at', 'council_record.chair');
  if (sealed && blind?.agenda) {
    distinctIds(problems, [
      ['agenda_id', blind.agenda.agenda_id],
      ['blind_r1', blind.record_ref],
      ['cross_r2', cross.record_ref],
      ['chair', record_ref],
      ['owner_report_ref', blind.agenda.owner_report_ref],
    ], 'council_record');
  }
  if (problems.bad || !sealed || !blind?.agenda || !defined(chair_id) || !defined(record_ref) || !defined(summary) || !defined(executed_at)) {
    return problems.fail();
  }
  const fromBlind = project(blind.notes);
  const fromCross = project(cross.notes);
  const agenda = blind.agenda;
  const checked = validateCouncilVerdict({
    schema_version: SCHEMA_VERSION,
    consumer: agenda.consumer,
    provenance: { ...agenda.provenance },
    proof_mode: agenda.proof_mode,
    agenda_id: agenda.agenda_id,
    rounds: [
      { name: 'blind_r1', record_ref: blind.record_ref },
      { name: 'cross_r2', record_ref: cross.record_ref },
    ],
    chair: { chair_id, record_ref, summary },
    dissent: [...fromBlind.dissent, ...fromCross.dissent],
    unknowns: [...fromBlind.unknowns, ...fromCross.unknowns],
    executes_immediately: true,
    owner_report_ref: agenda.owner_report_ref,
    owner_accepted: null,
    corrections: [],
    authority: [],
  });
  if (!checked.ok) return { ok: false, errors: checked.errors };
  return { ok: true, value: seal(checked.value, executed_at, record_ref, null) };
}

export function appendCouncilCorrection(record: CouncilRecord, input: CorrectionInput): PhaseCheck<CouncilRecord> {
  const problems = new Problems();
  rejectAuthority(problems, input, 'council_record.correction');
  const correction_id = readId(problems, { correction_id: input.correction_id }, 'correction_id', 'council_record.correction');
  const text = readText(problems, { text: input.text }, 'text', 'council_record.correction');
  const at = readIso(problems, { at: input.at }, 'at', 'council_record.correction');
  if (problems.bad || !defined(correction_id) || !defined(text) || !defined(at)) return problems.fail();
  const corrections = record.verdict.corrections;
  const tail = corrections.length > 0 ? corrections[corrections.length - 1] : undefined;
  if (tail && tail.correction_id === correction_id && tail.text === text && tail.at === at) {
    return { ok: true, value: record };
  }
  if (corrections.some(entry => entry.correction_id === correction_id)) {
    problems.add('council_record.correction', 'duplicate correction_id');
    return problems.fail();
  }
  if (correction_id === record.record_id) {
    problems.add('council_record.correction', 'correction_id equals the record_id it corrects (self-reference)');
    return problems.fail();
  }
  const appended = appendCorrection(record.verdict, { correction_id, seq: corrections.length + 1, text, at });
  if (!appended.ok) return { ok: false, errors: appended.errors };
  return { ok: true, value: seal(appended.value, record.executed_at, correction_id, record.record_id) };
}

export function setOwnerAccepted(record: CouncilRecord, accepted: boolean): PhaseCheck<CouncilRecord> {
  if (typeof accepted !== 'boolean') {
    return { ok: false, errors: ['council_record.owner_accepted: expected a boolean; the bit stays separate from execution'] };
  }
  if (record.verdict.owner_accepted === accepted) return { ok: true, value: record };
  const verdict = record.verdict;
  const checked = validateCouncilVerdict({
    schema_version: verdict.schema_version,
    consumer: verdict.consumer,
    provenance: { ...verdict.provenance },
    proof_mode: verdict.proof_mode,
    agenda_id: verdict.agenda_id,
    rounds: verdict.rounds.map(round => ({ ...round })),
    chair: { ...verdict.chair },
    dissent: verdict.dissent.map(entry => ({ ...entry })),
    unknowns: verdict.unknowns.map(entry => ({ ...entry })),
    executes_immediately: true,
    owner_report_ref: verdict.owner_report_ref,
    owner_accepted: accepted,
    corrections: verdict.corrections.map(entry => ({ ...entry })),
    authority: [],
  });
  if (!checked.ok) return { ok: false, errors: checked.errors };
  return { ok: true, value: seal(checked.value, record.executed_at, record.record_id, record.corrects) };
}

/** A grant attempt never changes the record. Release, security, and budget are forbidden. */
export function claimCouncilAuthority(record: CouncilRecord, claim: string): PhaseCheck<CouncilRecord> {
  void record.verdict.authority;
  const problems = new Problems();
  if ((FORBIDDEN_AUTHORITY as readonly string[]).includes(claim)) {
    problems.add('council_record.authority', `${claim} is a forbidden authority`);
  } else {
    problems.add('council_record.authority', `${JSON.stringify(claim)} is not grantable; council authority stays empty`);
  }
  return problems.fail();
}

/** No council snapshot grants a claim. owner_accepted and a smuggled list do not change this. */
export function councilGrantsAuthority(record: CouncilRecord, claim: string): boolean {
  void record.verdict.executes_immediately;
  void record.verdict.owner_accepted;
  void record.verdict.authority;
  void claim;
  void COUNCIL_AUTHORITY_CONFLICT;
  return false;
}

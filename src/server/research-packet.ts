// P3 research packet. Pure: no clock, no random ids, no I/O, no migration.
// Migration 0031 stays reserved in src/phase-contracts/migrations.ts.
// The task body is the W0 ResearchTask. This module does not redefine it.
// W0 stores incorporated_by as the consuming message id, or null until then.
// Incorporation cites {msg_id, intent_rev} and counts only when intent_rev is
// the revision the packet was opened under. A changed intent is not incorporation.
// not_applicable is the deterministic path: a reason, and no EDV fields.

import {
  ID_RE, Problems, checkKeys, defined, isRecord, readId, readObject, type PhaseCheck,
} from '../phase-contracts/check.ts';
import { validateResearchTask, type ResearchTask } from '../phase-contracts/research-task.ts';

export interface IncorporationRef {
  msg_id: string;
  intent_rev: string;
}

export interface ResearchPacket {
  task: ResearchTask;
  /** Owner intent revision the packet was opened under. */
  intent_rev: string;
  /** Null until a later turn incorporates the packet under the same intent_rev. */
  incorporated_by: IncorporationRef | null;
}

const OPEN_COMMON = [
  'schema_version', 'consumer', 'provenance', 'proof_mode',
  'task_id', 'applicability', 'incorporated_by', 'intent_rev',
] as const;
const OPEN_REQUIRED_KEYS = [
  ...OPEN_COMMON, 'hypothesis', 'discriminator', 'edv_band', 'frontier_class',
] as const;
const OPEN_NA_KEYS = [...OPEN_COMMON, 'reason'] as const;
const INCORP_KEYS = ['msg_id', 'intent_rev'] as const;

function failWith(problems: Problems, more: readonly string[] = []): PhaseCheck<never> {
  if (more.length === 0) return problems.fail();
  return { ok: false, errors: [...problems.errors, ...more] };
}

export function openResearchPacket(input: unknown): PhaseCheck<ResearchPacket> {
  const problems = new Problems();
  const obj = readObject(problems, input, 'research_packet');
  if (!obj) return problems.fail();

  const applicability = obj.applicability;
  if (applicability !== 'required' && applicability !== 'not_applicable') {
    problems.add('research_packet.applicability', 'expected required|not_applicable');
    if (!('consumer' in obj)) problems.add('research_packet.consumer', 'required');
    return problems.fail();
  }

  checkKeys(problems, obj, applicability === 'required' ? OPEN_REQUIRED_KEYS : OPEN_NA_KEYS, 'research_packet');
  const intent_rev = readId(problems, obj, 'intent_rev', 'research_packet');
  if ('incorporated_by' in obj && obj.incorporated_by !== null) {
    problems.add('research_packet.incorporated_by', 'stays null until a later turn incorporates the packet');
  }

  const taskInput: Record<string, unknown> = { ...obj };
  delete taskInput.intent_rev;
  const task = validateResearchTask(taskInput);
  if (!defined(intent_rev) || problems.bad || !task.ok) {
    return failWith(problems, task.ok ? [] : task.errors);
  }
  return {
    ok: true,
    value: { task: task.value, intent_rev, incorporated_by: null },
  };
}

export function incorporateResearchPacket(packet: ResearchPacket, incorporatedBy: unknown): PhaseCheck<ResearchPacket> {
  const problems = new Problems();
  if (!isRecord(packet) || !isRecord(packet.task)) {
    problems.add('research_packet', 'expected an object');
    return problems.fail();
  }
  const openedUnder = packet.intent_rev;
  if (typeof openedUnder !== 'string' || !ID_RE.test(openedUnder)) {
    problems.add('research_packet.intent_rev', 'expected an id of 1..128 characters [A-Za-z0-9_.:-]');
  }

  let msg_id: string | undefined;
  let intent_rev: string | undefined;
  if (incorporatedBy === null || incorporatedBy === undefined) {
    problems.add('research_packet.incorporated_by', 'required');
  } else {
    const ref = readObject(problems, incorporatedBy, 'research_packet.incorporated_by');
    if (ref) {
      checkKeys(problems, ref, INCORP_KEYS, 'research_packet.incorporated_by');
      msg_id = readId(problems, ref, 'msg_id', 'research_packet.incorporated_by');
      intent_rev = readId(problems, ref, 'intent_rev', 'research_packet.incorporated_by');
    }
  }

  const task = validateResearchTask(packet.task);
  if (!task.ok) return failWith(problems, task.errors);
  if (!defined(msg_id) || !defined(intent_rev) || problems.bad) return problems.fail();
  if (intent_rev !== openedUnder) {
    problems.add(
      'research_packet.incorporated_by.intent_rev',
      'incorporation requires the intent revision the packet was opened under',
    );
    return problems.fail();
  }

  const cited: IncorporationRef = { msg_id, intent_rev };
  const current = isIncorporationRef(packet.incorporated_by) ? packet.incorporated_by : null;
  if (task.value.incorporated_by !== null || packet.incorporated_by !== null) {
    const same = current !== null
      && current.msg_id === msg_id
      && current.intent_rev === intent_rev
      && task.value.incorporated_by === msg_id;
    if (same) {
      return { ok: true, value: { task: task.value, intent_rev: openedUnder, incorporated_by: cited } };
    }
    problems.add('research_packet.incorporated_by', 'already incorporated');
    return problems.fail();
  }

  const next = validateResearchTask({ ...task.value, incorporated_by: msg_id });
  if (!next.ok) return next;
  return { ok: true, value: { task: next.value, intent_rev: openedUnder, incorporated_by: cited } };
}

function isIncorporationRef(value: unknown): value is IncorporationRef {
  return isRecord(value) && typeof value.msg_id === 'string' && typeof value.intent_rev === 'string';
}

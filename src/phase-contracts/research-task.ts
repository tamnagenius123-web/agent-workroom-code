// P3 research task. EDV fields plus a named consumer, or an explicit not-applicable path.
// Every packet still names consumer and incorporated_by. incorporated_by stays null until consumed.

import {
  Problems, checkKeys, defined, readEnvelope, readId, readNullableId, readObject, readText,
  type PhaseCheck, type PhaseEnvelope,
} from './check.ts';

export const APPLICABILITY = ['required', 'not_applicable'] as const;
export type Applicability = typeof APPLICABILITY[number];

interface ResearchTaskBase extends PhaseEnvelope {
  task_id: string;
  incorporated_by: string | null;
}

export interface ResearchTaskRequired extends ResearchTaskBase {
  applicability: 'required';
  hypothesis: string;
  discriminator: string;
  edv_band: string;
  frontier_class: string;
}

export interface ResearchTaskNotApplicable extends ResearchTaskBase {
  applicability: 'not_applicable';
  reason: string;
}

export type ResearchTask = ResearchTaskRequired | ResearchTaskNotApplicable;

const REQUIRED_KEYS = [
  'schema_version', 'consumer', 'provenance', 'proof_mode',
  'task_id', 'applicability', 'hypothesis', 'discriminator', 'edv_band', 'frontier_class', 'incorporated_by',
] as const;
const NA_KEYS = [
  'schema_version', 'consumer', 'provenance', 'proof_mode',
  'task_id', 'applicability', 'reason', 'incorporated_by',
] as const;

export function validateResearchTask(input: unknown): PhaseCheck<ResearchTask> {
  const problems = new Problems();
  const obj = readObject(problems, input, 'research_task');
  if (!obj) return problems.fail();
  const applicability = obj.applicability;
  if (applicability !== 'required' && applicability !== 'not_applicable') {
    problems.add('research_task.applicability', 'expected required|not_applicable');
    checkKeys(problems, obj, ['schema_version', 'consumer', 'provenance', 'proof_mode', 'task_id', 'applicability', 'incorporated_by'], 'research_task');
    return problems.fail();
  }
  checkKeys(problems, obj, applicability === 'required' ? REQUIRED_KEYS : NA_KEYS, 'research_task');
  const envelope = readEnvelope(problems, obj, 'research_task');
  const task_id = readId(problems, obj, 'task_id', 'research_task');
  const incorporated_by = readNullableId(problems, obj, 'incorporated_by', 'research_task');
  if (!defined(envelope) || !defined(task_id) || incorporated_by === undefined) return problems.fail();
  if (applicability === 'not_applicable') {
    const reason = readText(problems, obj, 'reason', 'research_task');
    if (!defined(reason) || problems.bad) return problems.fail();
    const value: ResearchTaskNotApplicable = { ...envelope, task_id, applicability, reason, incorporated_by };
    return { ok: true, value };
  }
  const hypothesis = readText(problems, obj, 'hypothesis', 'research_task');
  const discriminator = readText(problems, obj, 'discriminator', 'research_task');
  const edv_band = readText(problems, obj, 'edv_band', 'research_task', 200);
  const frontier_class = readText(problems, obj, 'frontier_class', 'research_task', 200);
  if (!defined(hypothesis) || !defined(discriminator) || !defined(edv_band) || !defined(frontier_class) || problems.bad) {
    return problems.fail();
  }
  const value: ResearchTaskRequired = {
    ...envelope, task_id, applicability, hypothesis, discriminator, edv_band, frontier_class, incorporated_by,
  };
  return { ok: true, value };
}

// P3.1 MCP wire for checkResearchApplicability (origin/grok/p3-research-applicability @ 8f30f59).
// The pure module is the only validator. A deterministic task is applicability
// not_applicable plus a reason, and the response is that value with no EDV fields.
// A research task is applicability required and is rejected without EDV fields.
// Nothing is stored. This is not the W0 research-packet path (snake_case edv_band).

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  checkResearchApplicability, type ResearchApplicability,
} from './plan/research-applicability.ts';
import { Fault, baseSchema } from './contracts.ts';
import type { Workroom } from './domain.ts';

const NOTE = 'checkResearchApplicability is the validator. A deterministic task uses applicability not_applicable and a reason, and returns that path with no EDV fields. A research task uses applicability required and is rejected without consumer, hypothesis, discriminator, edvBand, and frontierClass. R(t) is never a reward or selector. Nothing is stored.';

export const APPLICABILITY_TOOL = {
  name: 'workroom_research_applicability',
  readOnly: true,
  description: 'Check one task for research applicability. ' + NOTE,
} as const;
export const RESEARCH_APPLICABILITY_READ_TOOLS = [APPLICABILITY_TOOL.name] as const;

const roomField = z.string().min(1).max(128);
export const applicabilitySchema = baseSchema.extend({
  room: roomField,
  task: z.unknown(),
}).strict();
export type ApplicabilityInput = z.infer<typeof applicabilitySchema>;

function checked(task: unknown): ResearchApplicability {
  const result = checkResearchApplicability(task);
  if (!result.ok) throw new Fault('INVALID_INPUT', result.errors.join(' '));
  return result.value;
}

async function check(service: Workroom, input: ApplicabilityInput): Promise<{ data: ResearchApplicability; meta: { note: string } }> {
  await service.authorize(input.room);
  const value = checked(input.task);
  const note = value.applicability === 'not_applicable'
    ? 'Deterministic task: research is not applicable.'
    : 'Research task accepted with EDV fields.';
  return { data: value, meta: { note } };
}

export function registerResearchApplicabilityTools(
  server: McpServer,
  service: Workroom,
  result: (call: () => Promise<{ data: unknown; meta: object }>, wrapped?: boolean) => Promise<{ content: { type: 'text'; text: string }[]; structuredContent: object; isError: boolean }>,
  hints: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean },
): void {
  server.registerTool(APPLICABILITY_TOOL.name, {
    description: APPLICABILITY_TOOL.description,
    inputSchema: applicabilitySchema,
    annotations: { ...hints, idempotentHint: true },
  }, input => result(() => check(service, input), true));
}

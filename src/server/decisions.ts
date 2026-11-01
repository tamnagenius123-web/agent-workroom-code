// BOUNDARY CONTRACT — mirrors src/server/decisions.ts in the gate MCP repo
// (agent-workroom-gate-mcp), split out under owner decision D5-cm (2026-11-01).
// Decision data moves to the decision data server in the multi-server split
// (D5-cn); this repo keeps only the contract surface.
//
// Tool descriptors, weight ranks, and the tools' zod input schemas are the
// public contract of the decision tools and are declared here (the schemas
// are declarative field contracts, mirrored from the gate module).
// Runtime behavior fails closed: the /v1/decisions route throws
// BoundaryUnavailableError, and the two registered MCP tools keep their
// contract surface (so discovery/list work) while every call returns the
// boundary error — decision data is served by the gate MCP server in
// Phase 2, never simulated here.
import { z } from 'zod';
import { boundaryUnavailable } from '../boundary.ts';
import { baseSchema, keySchema, ROOM } from './contracts.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Workroom } from './domain.ts';

export const WEIGHT_RANK = { USER_STATED: 3, relay: 2, inferred: 1 } as const;
export type Weight = keyof typeof WEIGHT_RANK;

export const DECISION_CITE_TOOL = {
  name: 'workroom_decision_cite',
  description: 'Look up one weighted decision by id or by directive_id. A directive lookup returns the highest weight: USER_STATED, then relay, then inferred. Cite that decision id instead of asking the owner again. Requires room membership.',
} as const;
export const DECISION_RECORD_TOOL = {
  name: 'workroom_decision_record',
  description: 'Record a weighted decision linked to an owner directive and an intent version. Agents may set weight to relay or inferred. USER_STATED is rejected. Owner text is never stored as approval when relayed. The idempotency key replays the same payload and conflicts when it differs. Identity is the caller.',
} as const;
export const DECISION_READ_TOOLS = [DECISION_CITE_TOOL.name] as const;

type Hit = { data: unknown; meta?: Record<string, unknown> };
type Hints = { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
type ResultFn = (call: () => Promise<unknown>, wrapped?: boolean) => Promise<unknown>;

// Input contract of the two decision tools (declarative schema definitions,
// mirrored from the gate module; they describe the tools' public inputs).
const prose = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && value.isWellFormed() && !value.includes('\0'), 'Invalid text');
const directiveId = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);
const decisionId = z.string().regex(/^dec_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const shortId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const weightSchema = z.enum(['USER_STATED', 'relay', 'inferred']);
const provenanceSchema = z.string().regex(/^(directive:[A-Za-z0-9_.:-]{1,80}|msg:[A-Za-z0-9_.:-]{1,80}|file:[A-Za-z0-9_./:-]{1,180}|commit:[0-9a-f]{7,64})$/);
const finiteUnit = (min: number) => z.number().refine(value => Number.isFinite(value) && value >= min && value <= 1, 'Number out of range');
const criterionSchema = z.object({ id: shortId, label: prose(200), weight: finiteUnit(Number.MIN_VALUE).refine(value => value > 0) }).strict();
const alternativeSchema = z.object({
  id: shortId, label: prose(200), scores: z.record(z.string(), finiteUnit(0)),
}).strict();
const approvalFields = {
  owner_text: prose(4000).optional(),
  approval: z.boolean().optional(),
  owner_approved: z.boolean().optional(),
  approved: z.boolean().optional(),
  approval_text: prose(4000).optional(),
  owner_quote: prose(4000).optional(),
};
const coreFields = {
  directive_id: directiveId,
  intent_version: z.number().int().positive().refine(value => Number.isSafeInteger(value)),
  statement: prose(4000),
  criteria: z.array(criterionSchema).min(1).max(12),
  alternatives: z.array(alternativeSchema).min(1).max(12),
  best_choice: shortId,
  weight: weightSchema,
  provenance: provenanceSchema,
  ...approvalFields,
};
export const decisionCiteSchema = baseSchema.extend({
  room: z.literal(ROOM), id: decisionId.optional(), directive_id: directiveId.optional(),
}).strict();
export const decisionRecordSchema = baseSchema.extend({
  room: z.literal(ROOM), idempotency_key: keySchema, ...coreFields,
}).strict();

export async function decisionAgentRoute(_service: Workroom, _request: Request, _url: URL, _readJSON: () => Promise<unknown>): Promise<Hit> {
  return boundaryUnavailable('src/server/decisions.ts', 'decisionAgentRoute', _service, _request, _url, _readJSON);
}

// The tools stay discoverable with their real contract surface, but every
// call fails closed with the boundary error: no decision is read or recorded
// from this repo.
export function registerDecisionTools(server: McpServer, _service: Workroom, result: ResultFn, hints: Hints): void {
  void _service;
  server.registerTool(DECISION_CITE_TOOL.name, {
    description: DECISION_CITE_TOOL.description, inputSchema: decisionCiteSchema, annotations: hints,
  }, (() => result(() => boundaryUnavailable('src/server/decisions.ts', DECISION_CITE_TOOL.name), true)) as never);
  server.registerTool(DECISION_RECORD_TOOL.name, {
    description: DECISION_RECORD_TOOL.description, inputSchema: decisionRecordSchema,
    annotations: { ...hints, readOnlyHint: false, idempotentHint: true },
  }, (() => result(() => boundaryUnavailable('src/server/decisions.ts', DECISION_RECORD_TOOL.name), true)) as never);
}

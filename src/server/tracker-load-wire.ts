// MCP wiring for TRACKER-LOAD-QUERY (contract: room posts 813426ae /
// 59eac605; tracker row quoted verbatim in room post 63628aa1).
// Read-only tool workroom_tracker_load: room membership required via
// service.authorize(room). The aggregation itself is the pure
// computeTrackerLoad in phase-contracts/tracker-load.ts — no D1, no
// writes, no state. Same input -> same output.

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { computeTrackerLoad, type TrackerUnitInput } from '../phase-contracts/tracker-load.ts';
import { baseSchema } from './contracts.ts';
import type { Workroom } from './domain.ts';

export const TRACKER_LOAD_TOOL = {
  name: 'workroom_tracker_load',
  readOnly: true,
  description: 'Read-only per-agent open load computed from tracker unit rows supplied in the call: counts by role (build = worker, review = verifier) and open status (OPEN/CLAIMED/PUSHED/FAIL/BLOCKED/GATED). Expects agent ids in worker/verifier cells (cells are canonicalized: case, whitespace, worker:/verifier: labels and agent: prefixes are normalized; a "/"-separated verifier cell is a set). Only clean status values are bucketed; any other status comes back as an unknown_status rejection. Done units are excluded; rows whose worker equals their verifier are rejected (author must differ from acceptor); rows blank on exactly one side are rejected as missing_agent, rows blank on both sides count as unclaimed under unknown, and duplicate unit ids are rejected as duplicate_unit. Deterministic: agents and rejections sorted by id, same input gives the same output. Requires room membership. Nothing is written.',
} as const;

const unitSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  worker: z.string().max(256).optional(),
  verifier: z.string().max(256).optional(),
  status: z.string().min(1).max(128),
});

export const trackerLoadSchema = baseSchema.extend({
  room: z.string().min(1).max(128),
  units: z.array(unitSchema).max(1000),
}).strict();

export type TrackerLoadInput = z.infer<typeof trackerLoadSchema>;

type Hit = { data: unknown; meta?: Record<string, unknown> };
type Hints = { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
type ResultFn = (call: () => Promise<unknown>, wrapped?: boolean) => Promise<unknown>;

async function trackerLoad(service: Workroom, input: TrackerLoadInput): Promise<Hit> {
  await service.authorize(input.room);
  const result = computeTrackerLoad(input.units as TrackerUnitInput[]);
  return {
    data: result,
    meta: { counted_units: result.counted_units, excluded_done: result.excluded_done, rejected: result.rejected.length },
  };
}

export function registerTrackerLoadTools(
  server: McpServer,
  service: Workroom,
  result: ResultFn,
  hints: Hints,
): void {
  server.registerTool(TRACKER_LOAD_TOOL.name, {
    description: TRACKER_LOAD_TOOL.description,
    inputSchema: trackerLoadSchema,
    annotations: hints,
  }, ((input: TrackerLoadInput) => result(() => trackerLoad(service, input), true)) as never);
}

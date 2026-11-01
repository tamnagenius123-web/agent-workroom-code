import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  DecisionRow,
  PrState,
  ProgressState,
  ProgressStore,
  RefEntry,
  RoomMessage,
  RoomPage,
  RoomPageSource,
  SourceReaders,
} from './types.ts';

const run = promisify(execFile);

// ---------- room via the registered connector client ----------

export interface ConnectorRoomOptions {
  clientPath: string; // path to custom.agent-workroom/bin/client.py
  room: string;
  pageLimit?: number;
}

interface McpResult {
  structuredContent?: { data?: { messages?: unknown[] }; meta?: { next_cursor?: string | null; has_more?: boolean } };
  content?: { type: string; text?: string }[];
}

function parseToolResult(stdout: string): { messages: RoomMessage[]; nextCursor: string | null; hasMore: boolean } {
  const result = JSON.parse(stdout) as McpResult;
  let data = result.structuredContent?.data;
  let meta = result.structuredContent?.meta;
  if (!data && result.content) {
    const textPart = result.content.find((c) => c.type === 'text' && typeof c.text === 'string');
    if (textPart?.text) {
      const inner = JSON.parse(textPart.text) as { data?: typeof data; meta?: typeof meta };
      data = inner.data;
      meta = inner.meta;
    }
  }
  const raw = (data?.messages ?? []) as Record<string, unknown>[];
  const messages = raw.map((m) => ({
    id: String(m.id),
    actor_id: String(m.actor_id ?? ''),
    text: String(m.text ?? ''),
    created_at: String(m.created_at ?? ''),
  }));
  return {
    messages,
    nextCursor: meta?.next_cursor ?? null,
    hasMore: meta?.has_more === true,
  };
}

export class ConnectorRoomSource implements RoomPageSource {
  constructor(private readonly opts: ConnectorRoomOptions) {}

  async fetchPage(cursor: string | null): Promise<RoomPage> {
    const args: Record<string, unknown> = {
      schema_version: '1',
      room: this.opts.room,
      limit: this.opts.pageLimit ?? 100,
    };
    if (cursor !== null) args.cursor = cursor;
    const dir = await mkdtemp(join(tmpdir(), 'state-ledger-'));
    const argsPath = join(dir, 'args.json');
    try {
      await writeFile(argsPath, JSON.stringify(args));
      const { stdout } = await run('python3', [
        this.opts.clientPath,
        'call-tool',
        '--name',
        'workroom_room_read',
        '--arguments-file',
        argsPath,
      ], { maxBuffer: 64 * 1024 * 1024 });
      return parseToolResult(stdout);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

// ---------- progress persistence ----------

export class FileProgressStore implements ProgressStore {
  constructor(private readonly path: string) {}

  async load(): Promise<ProgressState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as ProgressState;
      if (!Array.isArray(parsed.messages)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async save(state: ProgressState): Promise<void> {
    await writeFile(this.path, JSON.stringify(state));
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

// ---------- git refs / gh PRs / decisions.tsv ----------

export async function readRefsViaGit(cwd: string, remote = 'origin'): Promise<RefEntry[]> {
  const { stdout } = await run('git', ['ls-remote', remote], { cwd, maxBuffer: 64 * 1024 * 1024 });
  const out: RefEntry[] = [];
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 1) continue;
    out.push({ sha: line.slice(0, tab).trim(), name: line.slice(tab + 1).trim() });
  }
  return out;
}

interface GhPr {
  number: number;
  title: string;
  state: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  author?: { login?: string } | null;
  updatedAt: string;
  url: string;
  isDraft?: boolean;
}

export async function readPrsViaGh(repo: string, cwd: string): Promise<PrState[]> {
  const { stdout } = await run('gh', [
    'pr', 'list', '--repo', repo, '--state', 'all', '--limit', '300',
    '--json', 'number,title,state,headRefName,headRefOid,baseRefName,author,updatedAt,url,isDraft',
  ], { cwd, maxBuffer: 64 * 1024 * 1024 });
  const raw = JSON.parse(stdout) as GhPr[];
  return raw.map((p) => ({
    number: p.number,
    title: p.title,
    state: p.state,
    headRefName: p.headRefName,
    headRefOid: p.headRefOid,
    baseRefName: p.baseRefName,
    author: p.author?.login ?? null,
    updatedAt: p.updatedAt,
    url: p.url,
    isDraft: p.isDraft === true,
  }));
}

export function parseDecisionsTsv(text: string): DecisionRow[] {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const out: DecisionRow[] = [];
  for (const line of lines.slice(1)) { // header row
    const cells = line.split('\t');
    out.push({
      ts: cells[0] ?? '',
      decision: cells[1] ?? '',
      reason: cells[2] ?? '',
      owner: cells[3] ?? '',
      evidence: cells[4] ?? '',
    });
  }
  return out;
}

export async function readDecisionsFile(path: string): Promise<DecisionRow[]> {
  return parseDecisionsTsv(await readFile(path, 'utf8'));
}

// ---------- assembly ----------

export interface LiveReaderOptions {
  clientPath: string;
  room: string;
  repo: string;
  cwd: string;
  decisionsPath: string;
  progressPath: string;
}

export function liveReaders(opts: LiveReaderOptions): SourceReaders {
  return {
    room: new ConnectorRoomSource({ clientPath: opts.clientPath, room: opts.room }),
    roomProgress: new FileProgressStore(opts.progressPath),
    readRefs: () => readRefsViaGit(opts.cwd),
    readPrs: () => readPrsViaGh(opts.repo, opts.cwd),
    readDecisions: () => readDecisionsFile(opts.decisionsPath),
  };
}

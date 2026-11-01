// HTTP routes for room file sharing (docs/specs/file-sharing.md, slices S1-S3).
// Path B: ephemeral R2 bytes with a hard TTL. Path A: Drive link metadata only; the Worker holds no Drive credential.
import { z } from 'zod';
import { Fault, keySchema } from './contracts.ts';
import type { Workroom } from './domain.ts';
import { uploadFile, readFile, listFiles, registerDriveLink, type FileBucket, type FileEnv, type FileAvailability } from './files.ts';

export interface FileRouteEnv extends FileEnv { FILES?: FileBucket }

const linkSchema = z.object({ schema_version: z.literal('1'), name: z.string().min(1).max(240), mime: z.string().min(3).max(255),
  size_bytes: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/), drive_file_id: z.string().min(10).max(128),
  web_link: z.string().url().max(2048) }).strict();

const ROUTE = /^\/api\/v1\/rooms\/([^/]+)\/(files|file-links)(?:\/([^/]+))?$/;

export function dispositionName(header: string | null): string {
  const star = header?.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (!star) throw new Fault('INVALID_INPUT', "Content-Disposition with filename*=UTF-8''<name> is required.");
  try { return decodeURIComponent(star.trim()); } catch { throw new Fault('INVALID_INPUT', 'Content-Disposition filename* is not valid percent-encoding.'); }
}

export async function fileRoute(service: Workroom, env: FileRouteEnv, request: Request, url: URL, readJSON: () => Promise<unknown>,
  now = Date.now()): Promise<Response | { data: unknown; meta: object } | null> {
  const m = ROUTE.exec(url.pathname);
  if (!m) return null;
  const room = decodeURIComponent(m[1]!), kind = m[2]!, id = m[3] ? decodeURIComponent(m[3]) : undefined;
  const bucket = env.FILES ?? null;
  if (kind === 'file-links') {
    if (id || request.method !== 'POST') throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
    await service.authorize(room, true);
    const input = linkSchema.parse(await readJSON());
    const stored = await registerDriveLink(service.database, { ...input, room, principal: service.principal, idempotency_key: keySchema.parse(request.headers.get('idempotency-key')), now });
    return { data: stored, meta: {} };
  }
  if (request.method === 'POST' && !id) {
    if (url.search) throw new Fault('INVALID_INPUT', 'No query parameters for uploads.');
    await service.authorize(room, true);
    if (!request.body) throw new Fault('INVALID_INPUT', 'Request body is required.');
    const length = request.headers.get('content-length');
    if (length === null || !/^[0-9]{1,12}$/.test(length)) throw new Fault('INVALID_INPUT', 'Content-Length is required for uploads.', 411);
    const stored = await uploadFile(service.database, bucket, { room, principal: service.principal,
      name: dispositionName(request.headers.get('content-disposition')),
      mime: request.headers.get('content-type')?.split(';')[0]?.trim() ?? '',
      body: request.body, size: Number(length), now,
      idempotency_key: keySchema.parse(request.headers.get('idempotency-key')),
      sha256: request.headers.get('x-workroom-sha256') ?? undefined, env });
    return { data: stored, meta: {} };
  }
  if (request.method !== 'GET') throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
  await service.authorize(room);
  if (id) {
    const result = await readFile(service.database, bucket, room, id, now);
    if (result.kind === 'metadata') return { data: { file: result.file }, meta: {} };
    return new Response(result.body, { headers: result.headers });
  }
  const params = Object.fromEntries(url.searchParams);
  if (Object.keys(params).some(k => !['cursor', 'limit', 'availability'].includes(k))) throw new Fault('INVALID_INPUT', 'Unsupported query parameters.');
  return { data: await listFiles(service.database, room, now, { limit: params.limit === undefined ? undefined : Number(params.limit),
    cursor: params.cursor ?? null, availability: (params.availability ?? null) as FileAvailability | null }), meta: {} };
}

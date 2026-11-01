import { createApp } from './app.ts';
import { Fault } from './contracts.ts';

// Only in the separate synthetic Worker bundle. These are public fixtures, not real credentials.
const fixtures: Record<string, string> = {
  'local-alpha-fixture': 'synthetic:alpha', 'local-beta-fixture': 'synthetic:beta',
  'local-human-fixture':'synthetic:human',
  'local-reader-fixture': 'synthetic:reader', 'local-outsider-fixture': 'synthetic:outsider',
};
export default createApp(async request => {
  const url = new URL(request.url);
  const host = request.headers.get('host')?.split(':')[0] ?? url.hostname;
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !['127.0.0.1', 'localhost'].includes(host))
    throw new Fault('FORBIDDEN', 'Synthetic auth is loopback only.', 403);
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
  const principal = token && fixtures[token];
  if (!principal) throw new Fault('UNAUTHENTICATED', 'A synthetic local fixture token is required.', 401);
  return principal;
});

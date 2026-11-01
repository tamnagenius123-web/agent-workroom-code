// Live check (spends real API credit, ~< $0.05): cold vs warm prompt cache, then a 2-request batch.
// Usage: ANTHROPIC_API_KEY=... npx tsx scripts/claude-live-check.mts [cache|batch|all]
// Never prints the key.
import { batchResults, cachedSystem, createBatch, createMessage, getBatch, readUsage } from '../src/claude/anthropic.ts';

const key = process.env.ANTHROPIC_API_KEY;
if (!key) { console.error('ANTHROPIC_API_KEY not set'); process.exit(2); }
const model = process.env.CLAUDE_CHECK_MODEL ?? 'claude-haiku-5-5';
const mode = process.argv[2] ?? 'all';
const f = (u: string, i: RequestInit) => fetch(u, i);

const decisions = Array.from({ length: 400 }, (_, i) => ({ id: `d${i}`, text: `Decision ${i}: leases use epoch fencing; stale-epoch writes are rejected; owner approval revision ${i} is immutable.` }));
const baseline = { room_brief: { room: 'live-check', decisions } as never };

if (mode === 'cache' || mode === 'all') {
  const run = async (q: string) => readUsage((await createMessage(f, key, { model, max_tokens: 8, system: cachedSystem('Answer in one word.', baseline), messages: [{ role: 'user', content: q }] }) as { usage: unknown }).usage);
  const cold = await run('Is fencing used? yes/no');
  const warm = await run('Are revisions immutable? yes/no');
  console.log(JSON.stringify({ cold, warm }));
}
if (mode === 'batch' || mode === 'all') {
  const b = await createBatch(f, key, ['grade-a', 'grade-b'].map(id => ({ custom_id: id, params: { model, max_tokens: 8, messages: [{ role: 'user', content: `Reply with the single word OK (${id}).` }] } }))) as { id: string };
  console.log('batch', b.id);
  for (let i = 0; i < 120; i++) {
    const s = await getBatch(f, key, b.id) as { processing_status: string; results_url?: string };
    if (s.processing_status === 'ended' && s.results_url) { console.log(JSON.stringify(await batchResults(f, key, s.results_url))); break; }
    await new Promise(r => setTimeout(r, 15000));
  }
}

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness } from './local-harness.ts';

const persist = resolve('.local/d1');
const existing = existsSync('.local/seeded');
const app = await harness({ port: 8787, persist, seed: !existing });
if (!existing) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir('.local', { recursive: true });
  await writeFile('.local/seeded', 'synthetic local database initialized\n');
}
process.stderr.write(`Synthetic local workroom: ${app.url}\nFixture: local-alpha-fixture (no real agents connected)\n`);
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });

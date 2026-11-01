import { ingest } from '../src/wake-listener/listener.ts';
const [dir, secret, ts, sig, body, n, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) { /* start barrier so processes overlap */ }
let acc = 0; for (let i = 0; i < Number(n); i++) if (ingest(dir, secret, { delivery_id: 'd-race-' + i, ts, signature: sig, body }, Number(ts)) === 'accepted') acc++;
process.stdout.write(String(acc));

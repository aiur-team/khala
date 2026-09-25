// Peer/Khala-side controls for the proof. Message bodies arrive on stdin only.
//   release <state-dir>                        stdin → one released message
//   mode <state-dir> <steer|sync|async>
//   watch <state-dir> <off|prompt40|stop-long> [deadline-seconds]
//   keep-token <state-dir> <out-file> <release-id>   copy a delivered token (restart trial)
//   replay-ack <state-dir> <session-id> <token-file>
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openStore } from './marketplace/plugins/khala-proof/lib/store.mjs';

const [command, dir, ...rest] = process.argv.slice(2);
if (!command || !dir) throw new Error('usage: khala-admin.mjs <command> <state-dir> ...');
const store = await openStore(dir);
if (!store) throw new Error(`no run.json in ${dir}`);

if (command === 'release') {
  let message = '';
  for await (const chunk of process.stdin) message += chunk;
  if (!message) throw new Error('message stdin is empty');
  process.stdout.write(`${await store.release(message)}\n`);
} else if (command === 'mode') {
  if (!['steer', 'sync', 'async'].includes(rest[0])) throw new Error('mode must be steer, sync, or async');
  await writeFile(join(dir, 'mode'), `${rest[0]}\n`);
  await store.log('mode-set', { mode: rest[0] });
} else if (command === 'watch') {
  const watch = { variant: rest[0], deadlineSeconds: rest[1] ? Number(rest[1]) : undefined };
  await writeFile(join(dir, 'watch.json'), JSON.stringify(watch));
  await store.log('watch-set', watch);
} else if (command === 'keep-token') {
  // Copy a delivered release's token (Khala-side record) for replay checks.
  const delivered = JSON.parse(await readFile(join(dir, 'delivered', `${rest[1]}.json`), 'utf8'));
  await writeFile(rest[0], delivered.token, { mode: 0o600 });
} else if (command === 'replay-ack') {
  const token = (await readFile(rest[1], 'utf8')).trim();
  process.stdout.write(`${await store.acknowledge(rest[0], token, 'replay-ack')}\n`);
} else {
  throw new Error(`unknown command ${command}`);
}

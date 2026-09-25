// Operator/Khala-side controls for the Claude app proof.
//   init <state-dir> <run.json>          copy an identity record (see README) into the state dir
//   release <state-dir>                  stdin → one released message
//   notify <state-dir> <tools_list_changed|log_message>   content-free wrong-implementation probe (stdio only)
//   observe <state-dir> <kind> [key=value ...]            operator-recorded observation
//     kinds: model-echo release=<id> conversation=<id>    the target conversation restated the marker
//            restart phase=<before-ack|after-ack>         app or connector restarted
//            census processes=<n> note=<text>             model-process census (no argv)
//            negative mode=<steer|sync> reason=<text>     a push boundary inspected and absent
import { copyFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { openStore } from './lib/store.mjs';

const OBSERVATIONS = ['model-echo', 'restart', 'census', 'negative'];
const [command, dir, ...rest] = process.argv.slice(2);
if (!command || !dir) throw new Error('usage: khala-admin.mjs <command> <state-dir> ...');

if (command === 'init') {
  await copyFile(rest[0], join(dir, 'run.json'));
  process.exit(0);
}
const store = await openStore(dir);
if (!store) throw new Error(`no run.json in ${dir}`);

if (command === 'release') {
  let message = '';
  for await (const chunk of process.stdin) message += chunk;
  if (!message) throw new Error('message stdin is empty');
  process.stdout.write(`${await store.release(message)}\n`);
} else if (command === 'notify') {
  // The HTTP connector returns JSON responses only and has no stream to push on.
  if (store.run.shape !== 'desktop_extension') throw new Error('notify probes need the stdio desktop extension');
  const name = `notify-${Date.now()}-${randomBytes(3).toString('hex')}.json`;
  await writeFile(join(dir, 'control', name), JSON.stringify({ kind: rest[0] }));
  await store.log('notify-requested', { notification: rest[0] });
} else if (command === 'observe') {
  if (!OBSERVATIONS.includes(rest[0])) throw new Error(`observation must be one of ${OBSERVATIONS.join(', ')}`);
  const fields = Object.fromEntries(rest.slice(1).map(pair => {
    const at = pair.indexOf('=');
    return [pair.slice(0, at), pair.slice(at + 1)];
  }));
  await store.log('observed', { observation: rest[0], ...fields });
} else {
  throw new Error(`unknown command ${command}`);
}

import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const [runDir, sessionId, mode, batchToken] = process.argv.slice(2);
if (!runDir || !sessionId || !['steer', 'sync', 'rewake', 'pull'].includes(mode) || !batchToken) {
  throw new Error('usage: stage-message.mjs <run-dir> <session-id> <mode> <batch-token>; message on stdin');
}
if (!/^[A-Za-z0-9._-]+$/.test(batchToken)) throw new Error('invalid batch token');

let message = '';
for await (const chunk of process.stdin) message += chunk;
if (!message) throw new Error('message stdin is empty');

const ackPath = join(runDir, 'acked', batchToken);
try {
  await readFile(ackPath);
  throw new Error(`batch already acknowledged: ${batchToken}`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const pendingDir = join(runDir, 'pending');
await mkdir(pendingDir, { recursive: true });
const target = join(pendingDir, `${sessionId}.${mode}.${batchToken}.json`);
const staged = `${target}.${process.pid}.tmp`;
const handle = await open(staged, 'wx', 0o600);
try {
  await handle.writeFile(JSON.stringify({ batchToken, message }));
} finally {
  await handle.close();
}
await rename(staged, target);

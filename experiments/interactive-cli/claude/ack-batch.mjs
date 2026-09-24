import { appendFile, mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const [runDir, sessionId, mode, batchToken] = process.argv.slice(2);
if (!runDir || !sessionId || !mode || !batchToken || !/^[A-Za-z0-9._-]+$/.test(batchToken)) {
  throw new Error('usage: ack-batch.mjs <run-dir> <session-id> <mode> <batch-token>');
}

const delivered = join(runDir, 'delivered', `${sessionId}.${mode}.${batchToken}.json`);
const acknowledgedDelivery = `${delivered}.acked`;
let deliveryPath = delivered;
let item;
try {
  item = JSON.parse(await readFile(deliveryPath, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  deliveryPath = acknowledgedDelivery;
  item = JSON.parse(await readFile(deliveryPath, 'utf8'));
}
if (item.batchToken !== batchToken) throw new Error('delivered batch token does not match acknowledgement');
if (deliveryPath === delivered) await rename(delivered, acknowledgedDelivery);

const ackedDir = join(runDir, 'acked');
await mkdir(ackedDir, { recursive: true });
const receipt = join(ackedDir, batchToken);
const handle = await open(`${receipt}.${process.pid}.tmp`, 'wx', 0o600);
try {
  await handle.writeFile(`${new Date().toISOString()}\n`);
} finally {
  await handle.close();
}
await rename(`${receipt}.${process.pid}.tmp`, receipt);
await appendFile(join(runDir, 'events.jsonl'), `${JSON.stringify({
  at: new Date().toISOString(),
  kind: 'acknowledged',
  mode,
  sessionId,
  batchToken,
})}\n`, { mode: 0o600 });

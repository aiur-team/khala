// Desktop-extension entry point: newline-delimited JSON-RPC over stdio.
// Claude Desktop starts this process; Khala never starts a model session.
import { randomBytes } from 'node:crypto';
import { readFile, readdir, rename } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { NOTIFICATIONS, createConnection } from '../lib/protocol.mjs';
import { openStore } from '../lib/store.mjs';

const store = await openStore(process.env.KHALA_PROOF_STATE);
const connection = createConnection({ store, transport: 'stdio', connectionId: `c_${randomBytes(6).toString('hex')}` });
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);

// Probe: forward admin-requested, content-free notifications. Claiming by
// rename keeps two servers from sending the same request.
async function drainNotifications() {
  for (const name of (await readdir(store.path('control'))).filter(item => item.startsWith('notify-')).sort()) {
    const claimed = store.path('control', `sent-${connection.connectionId}-${name}`);
    try {
      await rename(store.path('control', name), claimed);
    } catch {
      continue;
    }
    const { kind } = JSON.parse(await readFile(claimed, 'utf8'));
    if (!NOTIFICATIONS[kind]) continue;
    write({ jsonrpc: '2.0', ...NOTIFICATIONS[kind] });
    await store.log('notified', { connectionId: connection.connectionId, notification: kind });
  }
}
if (store) setInterval(() => { drainNotifications().catch(() => {}); }, 500).unref();

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const reply = await connection.handle(JSON.parse(line));
  if (reply) write(reply);
}

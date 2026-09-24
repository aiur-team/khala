import { appendFile, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';

const [runDir, sessionId] = process.argv.slice(2);
if (!runDir || !sessionId) throw new Error('usage: read-pending.mjs <run-dir> <session-id>');

await mkdir(join(runDir, 'delivered'), { recursive: true });
const prefix = `${sessionId}.pull.`;
let pendingNames = [];
try {
  pendingNames = await readdir(join(runDir, 'pending'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const candidates = pendingNames
  .filter(name => name.startsWith(prefix) && name.endsWith('.json'))
  .sort();
if (candidates.length === 0) {
  process.stdout.write('No pending channel messages.\n');
  process.exit(0);
}

const source = join(runDir, 'pending', candidates[0]);
const claimed = `${source}.${process.pid}.claimed`;
await rename(source, claimed);
const item = JSON.parse(await readFile(claimed, 'utf8'));
await rename(claimed, join(runDir, 'delivered', basename(source)));
await appendFile(join(runDir, 'events.jsonl'), `${JSON.stringify({
  at: new Date().toISOString(),
  kind: 'explicit-pull',
  mode: 'async',
  sessionId,
  batchToken: item.batchToken,
})}\n`, { mode: 0o600 });
process.stdout.write(`[khala:${item.batchToken}] ${item.message}\n`);

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [runDir, sessionId, channel, ...words] = process.argv.slice(2);
if (!runDir || !sessionId || !['post-tool', 'stop', 'rewake'].includes(channel) || words.length === 0) {
  throw new Error('usage: stage-message.mjs <run-dir> <session-id> <post-tool|stop|rewake> <message>');
}

const pendingDir = join(runDir, 'pending');
await mkdir(pendingDir, { recursive: true });
const target = join(pendingDir, `${sessionId}.${channel}.json`);
const staged = `${target}.${process.pid}.tmp`;
await writeFile(staged, JSON.stringify({ message: words.join(' ') }), { mode: 0o600, flag: 'wx' });
await rename(staged, target);

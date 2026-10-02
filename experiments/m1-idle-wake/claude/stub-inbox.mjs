import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { append, init, sleep, stateDir } from './marketplace/plugins/khala-wake-spike/hooks/state.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['harness', 'session', 'channel', 'label', 'kind', 'body', 'delay-ms', 'count', 'gap-ms', 'since'].map(key => [key, { type: 'string' }])) });
const dir = stateDir(values.harness ?? 'claude', values.session);
function number(key, fallback) {
  const value = Number(values[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${key}`);
  return value;
}
if (positionals[0] === 'init') {
  await init(values.harness ?? 'claude', values.session, values.channel ?? 'spike');
  console.log(JSON.stringify({ dir }));
} else if (positionals[0] === 'append') {
  const kind = values.kind ?? 'human';
  if (!['human', 'agent', 'unknown'].includes(kind)) throw new Error('Invalid sender kind');
  const count = number('count', 1);
  if (count < 1) throw new Error('Count must be positive');
  await sleep(number('delay-ms', 0));
  for (let i = 0; i < count; i++) {
    if (i) await sleep(number('gap-ms', 0));
    const eventId = `$spike-${randomBytes(6).toString('hex')}`;
    const ts = new Date().toISOString();
    const label = values.label ?? 'Maya';
    await append(path.join(dir, 'inbox.jsonl'), { eventId, roomId: '!spike:khala.local', ts, sender: `@${label.toLowerCase()}:khala.local`, senderLabel: label, senderKind: kind, kind: 'message', body: `${values.body ?? ''}${values.count !== undefined ? ` #${i}` : ''}` });
    console.log(JSON.stringify({ eventId, appendedAt: new Date().toISOString() }));
  }
} else if (positionals[0] === 'log') {
  const since = values.since === undefined ? -Infinity : Date.parse(values.since);
  if (Number.isNaN(since)) throw new Error('Invalid since timestamp');
  const content = await readFile(path.join(dir, 'spike-log.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  for (const line of content.split('\n').filter(Boolean)) if (Date.parse(JSON.parse(line).at) >= since) console.log(line);
} else throw new Error('Expected init, append or log');

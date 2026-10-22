import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { claudeTranscriptInterrupted, claudeTranscriptVersion, versionAtLeast } from './claude-transcript';

let root: string;
const activityAt = '2026-10-06T12:00:00Z';
const marker = '[Request interrupted by user]';
const entry = (content: unknown = marker, timestamp = '2026-10-06T12:00:01Z') => ({
  type: 'user', timestamp, message: { role: 'user', content },
});
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-transcript-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function check(text: string) {
  const file = path.join(root, 'transcript.jsonl');
  await fs.writeFile(file, text);
  return claudeTranscriptInterrupted(file, activityAt);
}
it.each([marker, '[Request interrupted by user for tool use]', [{ type: 'text', text: marker }]])('accepts exact structured user marker %j', async content => {
  expect(await check(JSON.stringify(entry(content)) + '\n\n')).toBe(true);
});
it.each([
  '', '{', JSON.stringify(entry()) + '\n{"partial":',
  JSON.stringify(entry(marker, activityAt)),
  JSON.stringify(entry(marker, '2026-10-06T11:59:59Z')),
  JSON.stringify(entry(`Please explain ${marker}`)),
  JSON.stringify({ ...entry(), type: 'assistant' }),
  JSON.stringify({ ...entry(), message: { role: 'assistant', content: marker } }),
  JSON.stringify(entry([{ type: 'text', text: marker }, { type: 'text', text: 'more' }])),
  JSON.stringify(entry()) + '\n' + JSON.stringify(entry('Normal follow-up', '2026-10-06T12:00:02Z')),
  JSON.stringify(entry()) + '\n' + JSON.stringify({ type: 'assistant', timestamp: '2026-10-06T12:00:02Z', message: { role: 'assistant', content: 'Working' } }),
])('silently rejects non-terminal or invalid marker %s', async text => {
  expect(await check(text)).toBe(false);
});
it('silently rejects missing paths and nonregular files', async () => {
  expect(await claudeTranscriptInterrupted(undefined, activityAt)).toBe(false);
  expect(await claudeTranscriptInterrupted(path.join(root, 'missing'), activityAt)).toBe(false);
  expect(await claudeTranscriptInterrupted(root, activityAt)).toBe(false);
});
it('reads a bounded tail without interpreting a partial first line', async () => {
  expect(await check('x'.repeat(128 * 1024) + '\n' + JSON.stringify(entry()) + '\n')).toBe(true);
  expect(await check(JSON.stringify(entry('x'.repeat(128 * 1024) + marker)) + '\n')).toBe(false);
});
it('reads the newest recorded Claude version from the tail', async () => {
  const file = path.join(root, 'transcript.jsonl');
  await fs.writeFile(file, [{ version: '2.1.300' }, { version: '2.1.307' }, { type: 'summary' }].map(line => JSON.stringify(line)).join('\n') + '\n{"partial":');
  expect(await claudeTranscriptVersion(file)).toBe('2.1.307');
  await fs.writeFile(file, JSON.stringify({ version: 'latest' }));
  expect(await claudeTranscriptVersion(file)).toBeUndefined();
  expect(await claudeTranscriptVersion(path.join(root, 'missing'))).toBeUndefined();
  expect(await claudeTranscriptVersion(undefined)).toBeUndefined();
});
it.each([
  ['2.1.307', true], ['2.1.400', true], ['2.2.0', true], ['3.0.0', true], ['10.0.0', true],
  ['2.1.306', false], ['2.0.999', false], ['1.9.400', false], [undefined, false],
] as const)('compares %s against the 2.1.307 floor', (version, expected) => {
  expect(versionAtLeast(version, '2.1.307')).toBe(expected);
});

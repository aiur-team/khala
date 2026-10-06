import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { antigravity } from './antigravity';
import { resolveSources } from './session-sources';
import { deliver } from '../../hooks/deliver';
import { openSessionDir, writeStateFile, type SessionFiles } from '../state';
import { appendEntries, readCursor } from '../inbox';
import { isEmptyPrompt } from '../wake/terminal/prompt-guard';
import { chooseWakeDriver } from '../wake/ladder';
import { readActivity, writeActivity } from '../activity';
import { writeWakeSettings } from '../wake/shared';
import { stateRoot } from '../state';
import { runConformance } from './conformance/run';
import { antigravityDriver, createAntigravityConformanceDriver } from './conformance/drivers/antigravity';

let root: string, files: SessionFiles, env: NodeJS.ProcessEnv;
const now = () => new Date('2026-10-05T12:00:00Z');
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-agy-hook-'));
  env = { XDG_STATE_HOME: root };
  files = await openSessionDir('antigravity', 'session', env);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function emit(id: string) {
  await appendEntries(files, [{ eventId: id, roomId: '!room', ts: now().toISOString(), sender: '@peer',
    senderLabel: 'Peer', senderKind: 'human', kind: 'message', body: id }]);
}
async function hook(event: 'PreInvocation' | 'Stop', invocationNum = 0) {
  let stdout = '', stderr = '';
  await deliver(JSON.stringify({ conversationId: 'session', invocationNum }), ['--harness', 'antigravity', '--event', event],
    { env, now, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  expect(stderr).toBe(''); return JSON.parse(stdout);
}
it('uses per-call metadata for separate conversations and refuses invalid metadata instead of falling through', async () => {
  for (const id of ['first', 'second']) expect(await resolveSources(antigravity.sessionSources,
    { 'antigravity.google/conversation_id': id }, { ANTIGRAVITY_CONVERSATION_ID: 'fallback' }, { harness: 'antigravity' }))
    .toEqual({ sessionId: id, rejoinable: true });
  expect(await resolveSources(antigravity.sessionSources, { 'antigravity.google/conversation_id': '../invalid' },
    { ANTIGRAVITY_CONVERSATION_ID: 'valid' }, { harness: 'antigravity' })).toBeNull();
});
it('delivers steer only after tools and sync once per unread batch including continued turns', async () => {
  await writeStateFile(files.dir, 'mode.json', { mode: 'steer' }); await emit('$steer');
  expect(await hook('PreInvocation')).toEqual({});
  expect((await readCursor(files)).deliveredCount).toBe(0);
  expect((await hook('PreInvocation', 1)).injectSteps[0].ephemeralMessage).toContain('$steer');
  expect(await hook('PreInvocation', 2)).toEqual({});
  await writeStateFile(files.dir, 'mode.json', { mode: 'sync' }); await emit('$sync');
  expect(await hook('PreInvocation', 1)).toEqual({});
  expect((await hook('Stop')).reason).toContain('$sync');
  expect(await hook('Stop')).toEqual({ decision: 'stop' });
  await emit('$continued'); expect((await hook('Stop')).reason).toContain('$continued');
  expect(await hook('Stop')).toEqual({ decision: 'stop' });
});
it('keeps async unread and rejects unsupported permission-changing hooks', async () => {
  await writeStateFile(files.dir, 'mode.json', { mode: 'async' }); await emit('$async');
  await hook('PreInvocation'); await hook('PreInvocation', 1); await hook('Stop');
  expect((await readCursor(files)).deliveredCount).toBe(0);
  let stdout = '';
  await deliver('{"conversationId":"session"}', ['--harness', 'antigravity', '--event', 'PreToolUse'],
    { env, now, stdout: { write: text => { stdout += text; } }, stderr: { write: () => {} } });
  expect(stdout).toBe('');
});
it('matches captured empty prompts and refuses drafts and a moved cursor', async () => {
  for (const [name, empty] of [['empty', true], ['after-turn', true], ['draft', false]] as const) {
    const capture = await fs.readFile(new URL(`../../../../docs/build/multi-harness/spikes/terminal-hosts/agy-${name}.cursorline`, import.meta.url), 'utf8');
    const [metadata, ...lines] = capture.trimEnd().split('\n');
    expect(isEmptyPrompt(lines.join('\n'), Number(metadata!.match(/cursor_x=(\d+)/)![1]), antigravity.emptyPrompt)).toBe(empty);
  }
  expect(isEmptyPrompt('>', 3, antigravity.emptyPrompt)).toBe(false);
});
it('falls back to the guarded terminal when native credentials are missing', async () => {
  await writeActivity(files, 'idle', now);
  const probe = antigravityDriver.wakeProbe!(antigravity);
  await probe.prepare!(files);
  await fs.rm(path.join(files.dir, 'antigravity-wake.json'));
  await writeWakeSettings(stateRoot(env), { consent: { 'antigravity/antigravity-native': { at: now().toISOString() }, 'antigravity/terminal': { at: now().toISOString() } }, off: {} });
  const ctx = { files, env, harness: 'antigravity', sessionId: 'session', signal: new AbortController().signal, now: now().getTime() + 60_000 };
  const selected = await chooseWakeDriver(probe.drivers, ctx, await readActivity(files));
  expect(selected?.id).toBe('terminal');
  const line = 'Khala: channel messages are waiting. Continue. (k-1234abcd)';
  await selected!.wake(ctx, line); expect(probe.prompt()).toBe(line);
});

it.each(['terminal', 'rejected-native'] as const)('passes Tier A through %s fallback with its own transcript input shape', async transport => {
  const result = await runConformance(antigravity, createAntigravityConformanceDriver(transport));
  expect(result.rows.find(row => row.feature === 'idle wake')?.status).toBe('pass');
});

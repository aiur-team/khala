import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { channelFiles, ensureStateDir, openSessionDir, writeStateFile, writeStatus, type AgentState, type SessionFiles } from '../state';
import run from '../../hooks/session-start';

let root: string;
let files: SessionFiles;
let stdout: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-resume-1100-'));
  vi.stubEnv('XDG_STATE_HOME', root);
  files = await openSessionDir('claude', 'session', process.env);
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
it.each(['connected', 'closed', 'rejoin_needed'])('reminds a %s session to rejoin and arm Monitor before Stop', async state => {
  await writeStatus(files, state === 'connected' ? 'connected' : 'disconnected', state === 'connected' ? undefined : state, undefined, 'CHANNELMARK', 'NAMEMARK');
  expect(await run(JSON.stringify({ session_id: 'session', hook_event_name: 'SessionStart', source: 'resume' }), [])).toBe(0);
  const output = String(stdout.mock.calls[0]?.[0]);
  const context = JSON.parse(output).hookSpecificOutput;
  expect(context.hookEventName).toBe('SessionStart');
  expect(context.additionalContext).toContain('khala watch --harness claude --session session');
  expect(context.additionalContext).toContain('previously authorized');
  expect(context.additionalContext).toContain('Local links are single-use');
  expect(context.additionalContext).toContain('fresh local link');
  expect(context.additionalContext).toContain('Re-arm on every Monitor deadline');
  expect(output).not.toMatch(/CHANNELMARK|NAMEMARK/);
});
it.each(['left', 'removed', 'revoked', 'unauthorized', 'channel_deleted'])('does not prompt a session removed by its owner: %s', async reason => {
  await writeStatus(files, 'disconnected', reason, undefined, 'ecosystem');
  await run(JSON.stringify({ session_id: 'session', hook_event_name: 'SessionStart' }), []);
  expect(stdout).not.toHaveBeenCalled();
});
it.each(['null', '{}', 'broken', '{"session_id":"../escape","hook_event_name":"SessionStart"}'])('ignores malformed input %s', async input => {
  expect(await run(input, [])).toBe(0);
  expect(stdout).not.toHaveBeenCalled();
});
it('stays silent for a new unjoined session', async () => {
  await run(JSON.stringify({ session_id: 'new', hook_event_name: 'SessionStart' }), []);
  expect(stdout).not.toHaveBeenCalled();
});


async function saveChannel(roomId: string, state: AgentState, detail?: string, statusName = true) {
  const nested = channelFiles(files, roomId);
  await ensureStateDir(nested.dir);
  await writeStateFile(nested.dir, 'channel.json', { roomId, channelName: 'CHANNELMARK', joinedAt: new Date().toISOString() });
  await writeStateFile(nested.dir, 'rejoin.json', { secret: 'SECRETREJOIN' });
  await writeStatus(nested, state, detail, undefined, statusName ? 'CHANNELMARK' : undefined, 'NAMEMARK');
  return nested;
}

it.each(['joining', 'connected', 'send_failed', 'disconnected'] as const)(
  'reminds for a %s channel when aggregate status has no channelName', async state => {
    await writeStatus(files, state);
    await saveChannel('!first:test', 'disconnected', 'removed');
    await saveChannel('!second:test', state, state === 'disconnected' ? 'not_connected' : undefined);
    await run(JSON.stringify({ session_id: 'session', hook_event_name: 'SessionStart' }), []);
    const output = String(stdout.mock.calls[0]?.[0]);
    expect(output).toContain('khala watch --harness claude --session session');
    expect(output).not.toMatch(/CHANNELMARK|NAMEMARK|SECRETREJOIN|!first:test|!second:test/);
  },
);
it('uses channel metadata before restoration has written its status name', async () => {
  await writeStatus(files, 'joining');
  await saveChannel('!first:test', 'joining', undefined, false);
  await saveChannel('!second:test', 'disconnected', 'closed', false);
  await run(JSON.stringify({ session_id: 'session', hook_event_name: 'SessionStart' }), []);
  expect(String(stdout.mock.calls[0]?.[0])).toContain('previously authorized');
});
it('uses channel metadata when the channel status has not been written yet', async () => {
  const nested = await saveChannel('!first:test', 'joining');
  await fs.unlink(nested.status);
  await run(JSON.stringify({ session_id: 'session', hook_event_name: 'SessionStart' }), []);
  expect(String(stdout.mock.calls[0]?.[0])).toContain('khala watch');
});
it('stays silent when every channel has a terminal disconnected state', async () => {
  await writeStatus(files, 'disconnected', 'closed', undefined, 'STALEAGGREGATE');
  await saveChannel('!first:test', 'disconnected', 'removed');
  await saveChannel('!second:test', 'disconnected', 'left');
  await run(JSON.stringify({ session_id: 'session', hook_event_name: 'SessionStart' }), []);
  expect(stdout).not.toHaveBeenCalled();
});

it('reminds for an unnamed joined channel using its room identity', async () => {
  const nested = await saveChannel('!unnamed:test', 'connected', undefined, false);
  await writeStateFile(nested.dir, 'channel.json', { roomId: '!unnamed:test', joinedAt: new Date().toISOString() });
  await run(JSON.stringify({ session_id: 'session', hook_event_name: 'SessionStart' }), []);
  const output = String(stdout.mock.calls[0]?.[0]);
  expect(output).toContain('khala watch');
  expect(output).not.toContain('!unnamed:test');
});

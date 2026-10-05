import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createKhalaAgentClient } from '../client-impl';
import { openSessionDir, readStatus, writeStateFile, writeStatus, type SessionFiles } from '../state';
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
it.each(['connected', 'closed'])('reminds a %s session to rejoin and arm Monitor before Stop', async state => {
  await writeStatus(files, state === 'closed' ? 'disconnected' : 'connected', state === 'closed' ? 'closed' : undefined, undefined, 'CHANNELMARK', 'NAMEMARK');
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


it('keeps the Monitor reminder during eager restore and after temporary failure', async () => {
  const secret = 'S'.repeat(43);
  const credentials = { homeserver: 'https://matrix.example', userId: '@agent:matrix.example', roomId: '!room:matrix.example', accessToken: 'SECRET', deviceId: 'old-device' };
  await writeStateFile(files.dir, 'rejoin.json', { secret });
  await writeStateFile(files.dir, 'resume.json', { link: 'https://khala.example/join/abcdefgh', label: 'Claude', workspace: process.cwd(),
    secretHash: createHash('sha256').update(secret).digest('hex'), credentials });
  await writeStatus(files, 'disconnected', 'closed', undefined, 'CHANNELMARK', 'NAMEMARK');
  let reply!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { reply = resolve; });
  const client = createKhalaAgentClient({ harness: 'claude', sessionId: 'session', env: { XDG_STATE_HOME: root }, fetch: vi.fn(() => response) });
  try {
    await client.resume!();
    expect(await readStatus(files)).toMatchObject({ state: 'joining', channelName: 'CHANNELMARK', displayName: 'NAMEMARK' });
    await run(JSON.stringify({ session_id: 'session', hook_event_name: 'SessionStart' }), []);
    expect(String(stdout.mock.calls.at(-1)?.[0])).toContain('khala watch');
    stdout.mockClear();
    reply(new Response('{}', { status: 404 }));
    await vi.waitFor(async () => expect(await readStatus(files)).toMatchObject({ state: 'disconnected', channelName: 'CHANNELMARK', displayName: 'NAMEMARK' }));
    await run(JSON.stringify({ session_id: 'session', hook_event_name: 'SessionStart' }), []);
    expect(String(stdout.mock.calls.at(-1)?.[0])).toContain('previously authorized');
  } finally { reply(new Response('{}', { status: 404 })); await client.close(); }
});

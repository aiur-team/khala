import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { channelFiles, ensureStateDir, openSessionDir, writeStateFile, writeJsonAtomic } from './state';
import { claimAgent, claudeAgentId, folderAgentId, markReleased, supersededHarness, supersededHere } from './folder-agent';
import type { ProcessReader } from './harness/proc';

let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'khala-folder-agent-')));
  env = { XDG_STATE_HOME: path.join(root, 'state') };
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function legacySession(sessionId: string, workspace: string, at: Date): Promise<void> {
  const files = await openSessionDir('claude', sessionId, env);
  const nested = channelFiles(files, `!${sessionId}:local`);
  await ensureStateDir(nested.dir);
  await writeStateFile(nested.dir, 'channel.json', { roomId: `!${sessionId}:local`, channelName: sessionId, joinedAt: at.toISOString() });
  await writeStateFile(nested.dir, 'resume.json', { workspace, link: 'x', label: 'x', roomId: `!${sessionId}:local`, secretHash: 'x' });
  await fs.utimes(path.join(nested.dir, 'resume.json'), at, at);
}

it('gives every session in a folder one agent id, and other folders and worktrees their own', async () => {
  const a = path.join(root, 'a'), b = path.join(root, 'b'), link = path.join(root, 'link');
  await fs.mkdir(a); await fs.mkdir(b); await fs.symlink(a, link);
  const id = await claudeAgentId({ ...env, CLAUDE_PROJECT_DIR: a }, 'session-1');
  expect(id).toMatch(/^folder-[a-f0-9]{24}$/);
  expect(await claudeAgentId({ ...env, CLAUDE_PROJECT_DIR: a }, 'session-2')).toBe(id);
  expect(await claudeAgentId({ ...env, CLAUDE_PROJECT_DIR: link }, 'session-3')).toBe(id);
  expect(await claudeAgentId({ ...env, CLAUDE_PROJECT_DIR: b }, 'session-1')).not.toBe(id);
});

it('keeps the session id without a project dir, and passes an invalid id through for the caller to reject', async () => {
  expect(await claudeAgentId(env, 'session-1')).toBe('session-1');
  expect(await claudeAgentId({ ...env, CLAUDE_PROJECT_DIR: 'relative' }, 'session-1')).toBe('session-1');
  expect(await claudeAgentId({ ...env, CLAUDE_PROJECT_DIR: root }, '../x')).toBe('../x');
});

it('adopts the newest per-session state saved in the folder, once, and pins it', async () => {
  const folder = path.join(root, 'project');
  await fs.mkdir(folder);
  await legacySession('older', folder, new Date('2026-10-01T00:00:00Z'));
  await legacySession('newer', folder, new Date('2026-10-02T00:00:00Z'));
  await legacySession('elsewhere', path.join(root, 'other'), new Date('2026-10-03T00:00:00Z'));
  const [first, second] = await Promise.all([folderAgentId(env, folder), folderAgentId(env, folder)]);
  expect([first, second]).toEqual(['newer', 'newer']);
  // A later per-session write (an older khala still running) never moves the pinned agent.
  await legacySession('latest', folder, new Date('2026-10-04T00:00:00Z'));
  expect(await folderAgentId(env, folder)).toBe('newer');
});

const proc = (pid: number, startTime: string, ppid = 1, command = 'node') => ({ pid, ppid, startTime, command });
it('waits for a live previous owner to release the agent, and lets hooks route to the owning harness only', async () => {
  const dir = path.join(root, 'state', 'khala', 'claude', 'folder-x');
  await ensureStateDir(dir);
  const table = new Map([[process.pid, proc(process.pid, 'me', 900)], [900, proc(900, 'claude-new', 1, 'claude')],
    [700, proc(700, 'old-mcp', 800)], [800, proc(800, 'claude-old', 1, 'claude')]]);
  const read: ProcessReader = async pid => table.get(pid) ?? null;
  await writeJsonAtomic(path.join(dir, 'owner.json'), { pid: 700, startTime: 'old-mcp', harness: { pid: 800, startTime: 'claude-old' } });
  // The old owner's hooks (under Claude 800) still route; this process's (under 900) do not, until it claims.
  expect(await supersededHarness(dir, process.pid, read)).toBe(true);
  expect(await supersededHarness(dir, 700, read)).toBe(false);
  expect(await supersededHere(dir, read)).toBe(true);
  let claimed = false;
  const claiming = claimAgent(dir, { read, timeoutMs: 10_000 }).then(() => { claimed = true; });
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(claimed).toBe(false);
  await writeJsonAtomic(path.join(dir, 'released.json'), { pid: 700, startTime: 'old-mcp' });
  await claiming;
  expect(await supersededHarness(dir, process.pid, read)).toBe(false);
  expect(await supersededHarness(dir, 700, read)).toBe(true);
  expect(await supersededHere(dir, read)).toBe(false);
  // A dead previous owner is not waited for.
  table.delete(700);
  await writeJsonAtomic(path.join(dir, 'owner.json'), { pid: 700, startTime: 'old-mcp' });
  await claimAgent(dir, { read, timeoutMs: 60_000 });
  await markReleased(dir, read);
  expect(JSON.parse(await fs.readFile(path.join(dir, 'released.json'), 'utf8'))).toEqual({ pid: process.pid, startTime: 'me' });
});

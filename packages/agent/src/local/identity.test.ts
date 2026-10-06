import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { checkName } from '@khala/contracts/m1/names';
import { StateError } from '../state';
import { HOSTED_PROFILE_FILE, hostedUsernameFromAgentName, LOCAL_OWNER_FALLBACK_NAME, resolveLocalOwnerName, saveHostedUsername } from './identity';

let root: string;
let env: NodeJS.ProcessEnv;
let file: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-identity-'));
  env = { XDG_STATE_HOME: root, USER: 'maya' };
  file = path.join(root, 'khala', HOSTED_PROFILE_FILE);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('round trips a private cached username ahead of USER', async () => {
  await saveHostedUsername('kevin', env);
  const profile = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(profile).toEqual({ v: 1, username: 'kevin', savedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u) });
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
  expect(await resolveLocalOwnerName(env)).toBe('kevin');
});
it('keeps an unchanged cache untouched and replaces a changed username', async () => {
  await saveHostedUsername('kevin', env);
  const before = await fs.readFile(file, 'utf8');
  const modified = (await fs.stat(file)).mtimeMs;
  await saveHostedUsername('kevin', env);
  expect(await fs.readFile(file, 'utf8')).toBe(before);
  expect((await fs.stat(file)).mtimeMs).toBe(modified);
  await saveHostedUsername('kev', env);
  expect(JSON.parse(await fs.readFile(file, 'utf8')).username).toBe('kev');
});
it.each(['kevin-Claude', 'a', 'owner', ' kevin', 'ke__vin'])('does not save invalid or noncanonical username %s', async username => {
  await saveHostedUsername(username, env);
  await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each([['  maya  ', 'maya'], ['kevin.weaver', 'kevin.weaver'], ['root_user', 'root_user']])('resolves USER %s to %s', async (user, expected) => {
  expect(await resolveLocalOwnerName({ ...env, USER: user })).toBe(expected);
});
it.each(['root__user', 'admin', ''])('uses a valid fallback for invalid USER %s', async user => {
  expect(await resolveLocalOwnerName({ ...env, USER: user })).toBe('User');
  expect(checkName(LOCAL_OWNER_FALLBACK_NAME, 'username').ok).toBe(true);
  expect(checkName(`${LOCAL_OWNER_FALLBACK_NAME}-Claude`, 'agent').ok).toBe(true);
});
it('uses the OS user only when USER is absent', async () => {
  const checked = checkName(os.userInfo().username, 'username');
  expect(await resolveLocalOwnerName({ XDG_STATE_HOME: root })).toBe(checked.ok ? checked.name : 'User');
});
it.each(['{', '{"v":1,"username":"kevin-Codex"}', '{"v":2,"username":"kevin"}', '{"v":1,"username":" kevin"}', 'null', '[]'])('falls back for corrupt or invalid cache %s', async content => {
  await fs.mkdir(path.dirname(file), { mode: 0o700 });
  await fs.writeFile(file, content);
  expect(await resolveLocalOwnerName(env)).toBe('maya');
});
it('contains cache read failures', async () => {
  await fs.mkdir(file, { recursive: true });
  expect(await resolveLocalOwnerName(env)).toBe('maya');
});
it('rejects a public root without preventing valid name resolution', async () => {
  await fs.mkdir(path.dirname(file), { mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o755);
  await expect(saveHostedUsername('kevin', env)).rejects.toBeInstanceOf(StateError);
  await expect(saveHostedUsername('kevin', env)).rejects.toMatchObject({ code: 'unsafe_state_dir' });
  expect(checkName(await resolveLocalOwnerName(env), 'username').ok).toBe(true);
});
it('rejects a symlink root without writing into its target', async () => {
  const target = path.join(root, 'target');
  await fs.mkdir(target, { mode: 0o700 });
  await fs.symlink(target, path.dirname(file));
  await expect(saveHostedUsername('kevin', env)).rejects.toMatchObject({ code: 'unsafe_state_dir' });
  expect(await fs.readdir(target)).toEqual([]);
});
it('rejects a root that is a file', async () => {
  await fs.writeFile(path.dirname(file), '');
  await expect(saveHostedUsername('kevin', env)).rejects.toMatchObject({ code: 'unsafe_state_dir' });
});
it.each([
  ['kevin-Codex', 'codex', 'kevin'], ['kevin-Codex-2', 'codex', 'kevin'],
  ['kevin-codex', 'codex', 'kevin'], ['kev.in-Claude-12', 'claude', 'kev.in'],
  ['kevin-Gemini', 'gemini', 'kevin'], ['kevin-Agent-2', 'custom-harness', 'kevin'],
  ['kevin-Claude', 'codex', null], ['reviewer', 'claude', null],
  ['-Claude', 'claude', null], ['a-Claude', 'claude', null], ['owner-Claude', 'claude', null],
] as const)('derives only a valid own default username from %s (%s)', (name, harness, expected) => {
  expect(hostedUsernameFromAgentName(name, harness)).toBe(expected);
});

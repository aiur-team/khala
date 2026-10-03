import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';

const launcher = fileURLToPath(new URL('../../claude-plugin/khala/bin/khala', import.meta.url));
const manifest = JSON.parse(await fs.readFile(new URL('../../npm/package.json', import.meta.url), 'utf8')) as { name: string; version: string };
let root: string;
let data: string;
let fakeBin: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-launcher-'));
  data = path.join(root, 'data');
  fakeBin = path.join(root, 'fake-bin');
  await fs.mkdir(fakeBin);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function script(file: string, body: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
const echo = (label: string) => `printf '%s' "${label}:$*"; cat`;
function run(args: string[], env: Record<string, string> = {}, input = '') {
  const result = spawnSync(launcher, args, {
    encoding: 'utf8', input,
    // The launcher's own directory comes first, as for Claude's Bash tool.
    env: { HOME: root, CLAUDE_PLUGIN_DATA: data, PATH: [path.dirname(launcher), fakeBin, '/usr/bin', '/bin'].join(':'), ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

it('prefers KHALA_BIN, then the pinned copy, then another khala on PATH, then npx', async () => {
  await script(path.join(fakeBin, 'npx'), echo('npx'));
  expect(run(['hook', 'deliver'], {}, 'in')).toMatchObject({ status: 0, stdout: `npx:-y ${manifest.name}@${manifest.version} hook deliverin` });
  await script(path.join(fakeBin, 'khala'), echo('path'));
  expect(run(['mcp', '--harness', 'claude'])).toMatchObject({ status: 0, stdout: 'path:mcp --harness claude' });
  await script(path.join(data, `npm-${manifest.version}`, 'bin/khala'), echo('pinned'));
  expect(run(['hook', 'deliver'], {}, '{"x":1}')).toMatchObject({ status: 0, stdout: 'pinned:hook deliver{"x":1}' });
  await script(path.join(root, 'dev/khala.mjs'), echo('dev'));
  expect(run(['local', 'list'], { KHALA_BIN: path.join(root, 'dev/khala.mjs') })).toMatchObject({ status: 0, stdout: 'dev:local list' });
});

it('installs the pinned version in the background on SessionStart, once', async () => {
  // Fake npm: `npm install --global --prefix <dir> ... <spec>` writes <dir>/bin/khala.
  await script(path.join(fakeBin, 'npm'), [
    'prefix=""; spec=""',
    'while [ $# -gt 0 ]; do case "$1" in --prefix) prefix="$2"; shift;; -*) ;; *) spec="$1";; esac; shift; done',
    'echo "$spec" >> "$NPM_LOG"',
    'mkdir -p "$prefix/bin" && printf \'#!/bin/sh\\necho installed:$*\\n\' > "$prefix/bin/khala" && chmod +x "$prefix/bin/khala"',
  ].join('\n'));
  const env = { NPM_LOG: path.join(root, 'npm.log') };
  expect(run(['--ensure-installed'], env)).toMatchObject({ status: 0, stdout: '', stderr: '' });
  const pinned = path.join(data, `npm-${manifest.version}`, 'bin/khala');
  for (let i = 0; i < 100 && !await fs.stat(pinned).catch(() => null); i++) await sleep(50);
  expect(run(['--version'])).toMatchObject({ status: 0, stdout: 'installed:--version\n' });
  for (let i = 0; i < 100 && await fs.stat(path.join(data, `.install-${manifest.version}.lock`)).catch(() => null); i++) await sleep(50);
  expect(run(['--ensure-installed'], env).status).toBe(0);
  expect(await fs.readFile(env.NPM_LOG, 'utf8')).toBe(`${manifest.name}@${manifest.version}\n`);
  expect(await fs.readdir(data)).toEqual(expect.not.arrayContaining([expect.stringMatching(/^\.tmp-/)]));
});

it('skips the install under KHALA_BIN', async () => {
  await script(path.join(fakeBin, 'npm'), 'touch "$NPM_LOG"');
  expect(run(['--ensure-installed'], { KHALA_BIN: '/bin/true', NPM_LOG: path.join(root, 'npm.log') }).status).toBe(0);
  await sleep(200);
  await expect(fs.stat(path.join(root, 'npm.log'))).rejects.toMatchObject({ code: 'ENOENT' });
});

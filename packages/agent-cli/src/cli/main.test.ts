import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));
const bundleScript = fileURLToPath(new URL('../../scripts/bundle.mjs', import.meta.url));
const temporaryDirectory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-cli-link-'));
const linkedEntrypoint = path.join(temporaryDirectory, 'khala');

describe('bundled CLI entrypoint', () => {
  beforeAll(() => {
    const build = spawnSync(process.execPath, [bundleScript], {
      cwd: packageDirectory,
      encoding: 'utf8',
    });
    expect(build.status, build.stderr).toBe(0);
    fs.symlinkSync(path.join(packageDirectory, 'dist/khala.js'), linkedEntrypoint);
  });

  afterAll(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  it('runs through a symlink and rejects missing arguments', () => {
    const result = spawnSync(process.execPath, [linkedEntrypoint], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: 'invalid_arguments' });
  });

  it('composes the Claude session client over the internal runtime descriptor', () => {
    // No internal server has published `active.json` under this state root.
    const state = fs.mkdtempSync(path.join(temporaryDirectory, 'state-'));
    const result = spawnSync(process.execPath, [linkedEntrypoint, 'claude', 'read', '--session', 'session-1'], {
      encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: state },
    });

    expect(result.status).toBe(3);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, kind: 'refused', code: 'descriptor_missing' });
  });

  it('runs standalone status through a symlink', () => {
    const home = path.join(temporaryDirectory, 'home');
    fs.mkdirSync(home);
    const result = spawnSync(process.execPath, [linkedEntrypoint, 'status'], { encoding: 'utf8', env: { HOME: home, PATH: '' } });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      v: 1,
      connected: false,
      binding: null,
      route: 'unavailable',
      sourceCursor: null,
      inbox: null,
      configuration: {
        v: 1, command: 'status', ok: true, changed: false, state: 'no_harness', planDigest: null,
        confirmation: { required: false, confirmed: false }, harnesses: [], operations: [], diagnostics: [],
      },
    });
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('keeps the internal runtime out of the main bundle and loads it only for internal', () => {
    const main = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'dist/khala.js.meta.json'), 'utf8'));
    expect(Object.keys(main.inputs).filter(input => input.includes('apps/internal'))).toEqual([]);
    const imports = Object.values(main.outputs as Record<string, { imports: { path: string }[] }>).flatMap(output => output.imports.map(entry => entry.path));
    expect(imports).not.toContain('node:sqlite');

    // node:sqlite prints an ExperimentalWarning of its own; the result is the one JSON line.
    const result = (stderr: string) => JSON.parse(stderr.split('\n').find(line => line.startsWith('{'))!);
    const state = fs.mkdtempSync(path.join(temporaryDirectory, 'state-'));
    const env = { ...process.env, XDG_STATE_HOME: state };
    const deleted = spawnSync(process.execPath, [linkedEntrypoint, 'internal', 'delete', 'ch_missing', '--yes'], { encoding: 'utf8', env });
    expect(deleted.status).toBe(3);
    expect(deleted.stdout).toBe('');
    expect(result(deleted.stderr)).toEqual({ ok: false, error: 'missing_state', channelId: 'ch_missing' });

    // The packaged build carries the browser bundle beside the internal runtime.
    expect(fs.existsSync(path.join(packageDirectory, 'dist/internal-web/index.html'))).toBe(true);

    // Without that bundle beside it, launch refuses before taking any runtime state. The copy
    // omits `internal-web/`: launching the real build would start a server that never exits.
    const bare = fs.mkdtempSync(path.join(temporaryDirectory, 'bare-'));
    for (const file of ['khala.js', 'khala-internal.js']) fs.copyFileSync(path.join(packageDirectory, 'dist', file), path.join(bare, file));
    const created = spawnSync(process.execPath, [path.join(bare, 'khala.js'), 'internal'], { encoding: 'utf8', env, timeout: 30_000 });
    expect(created.status).toBe(3);
    expect(result(created.stderr)).toEqual({ ok: false, error: 'web_bundle_unavailable' });
    expect(fs.existsSync(path.join(state, 'khala', 'internal', 'runtime.lock'))).toBe(false);
  });
});

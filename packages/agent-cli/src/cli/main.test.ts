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

  it('keeps the registered Claude session command fail-closed until live composition exists', () => {
    const result = spawnSync(process.execPath, [linkedEntrypoint, 'claude', 'read', '--session', 'session-1'], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: 'transport_unavailable' });
  });

  it('runs standalone status through a symlink', () => {
    const result = spawnSync(process.execPath, [linkedEntrypoint, 'status'], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      v: 1,
      connected: false,
      binding: null,
      route: 'unavailable',
      sourceCursor: null,
      inbox: null,
    });
  });
});

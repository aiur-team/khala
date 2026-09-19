import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));
const buildScript = fileURLToPath(new URL('../../../../scripts/package-task.mjs', import.meta.url));
const temporaryDirectory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-cli-link-'));
const linkedEntrypoint = path.join(temporaryDirectory, 'khala');

describe('built CLI entrypoint', () => {
  beforeAll(() => {
    const build = spawnSync(process.execPath, [buildScript, 'build'], {
      cwd: packageDirectory,
      encoding: 'utf8',
    });
    expect(build.status, build.stderr).toBe(0);
    fs.symlinkSync(path.join(packageDirectory, 'dist/cli/main.js'), linkedEntrypoint);
  });

  afterAll(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  it('runs through a symlink and rejects missing arguments', () => {
    const result = spawnSync(process.execPath, [linkedEntrypoint], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: 'invalid_arguments' });
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

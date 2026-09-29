import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HARNESS_IDS } from '../setup/types.js';
import { nativeShellCreateClient } from './main.js';
import { createUnavailableClient } from '../composition/unavailable.js';

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));
const bundleScript = fileURLToPath(new URL('../../scripts/bundle.mjs', import.meta.url));
const temporaryDirectory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-cli-link-'));
const linkedEntrypoint = path.join(temporaryDirectory, 'khala');
// Node may flush its warning after the CLI has written its JSON error.
const sqliteExperimentalWarning = /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/mu;
const withoutSqliteWarning = (stderr: string): string => stderr.replace(sqliteExperimentalWarning, '');

describe('bundled CLI entrypoint', () => {
  it('selects the exact native Codex session for hosted creation and closes it', async () => {
    const target = `https://khala.aiur.team/new?agent_create=owner_1.${'A'.repeat(43)}`;
    const request = { title: 'Planning', operationId: 'op-create-1', origin: null, target };
    const requestChannelCreate = vi.fn(async () => ({ kind: 'handoff' as const,
      approvalUrl: `https://khala.aiur.team/api/human/channel-discovery/authority/approve?candidate=${'B'.repeat(43)}` }));
    const close = vi.fn(async () => undefined);
    const hostedSession = vi.fn(async () => ({ client: { ...createUnavailableClient(), requestChannelCreate },
      inbox: async () => { throw new Error('no binding'); }, close }));
    const native = nativeShellCreateClient('thread-1', hostedSession);
    expect(await native.client.requestChannelCreate?.(request)).toMatchObject({ kind: 'handoff' });
    expect(await native.client.requestChannelCreate?.({ ...request, target: null }))
      .toEqual({ kind: 'refused', code: 'invalid_request' });
    expect(hostedSession).toHaveBeenCalledExactlyOnceWith({ harness: 'codex', sessionId: 'thread-1' });
    expect(requestChannelCreate).toHaveBeenCalledExactlyOnceWith(request, undefined);
    await native.close();
    expect(close).toHaveBeenCalledOnce();
    const missing = nativeShellCreateClient(undefined, hostedSession);
    expect(await missing.client.requestChannelCreate?.(request)).toEqual({ kind: 'refused', code: 'discovery_required' });
    expect(hostedSession).toHaveBeenCalledOnce();
  });

  it('filters only Node’s known SQLite warning from child stderr', () => {
    const sqlite = '(node:1234) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n'
      + '(Use `node --trace-warnings ...` to show where the warning was created)\n';
    expect(withoutSqliteWarning(sqlite + '{"ok":false}\n')).toBe('{"ok":false}\n');
    expect(withoutSqliteWarning('{"ok":false}\n' + sqlite)).toBe('{"ok":false}\n');
    expect(withoutSqliteWarning(sqlite + 'unexpected warning\n')).toBe('unexpected warning\n');
    expect(withoutSqliteWarning('unexpected warning\n' + sqlite)).toBe('unexpected warning\n');
    expect(withoutSqliteWarning('prefix ' + sqlite)).toBe('prefix ' + sqlite);
  });
  beforeAll(() => {
    const build = spawnSync(process.execPath, [bundleScript], {
      cwd: packageDirectory,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(build.status, build.stderr).toBe(0);
    fs.symlinkSync(path.join(packageDirectory, 'dist/khala.js'), linkedEntrypoint);
  }, 70_000);

  afterAll(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  it('runs through a symlink and rejects missing arguments', () => {
    const result = spawnSync(process.execPath, [linkedEntrypoint], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(withoutSqliteWarning(result.stderr))).toEqual({ ok: false, error: 'invalid_arguments' });
  });

  it('refuses hosted create from an installed shell without a native session', () => {
    const state = fs.mkdtempSync(path.join(temporaryDirectory, 'create-state-'));
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: state };
    delete env.CODEX_THREAD_ID;
    const target = `https://khala.aiur.team/new?agent_create=owner_1.${'A'.repeat(43)}`;
    const result = spawnSync(process.execPath, [linkedEntrypoint, 'channels', 'create', '--title', 'Planning',
      '--operation', 'op-create-1', '--target', target], { encoding: 'utf8', env });
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, v: 1, error: 'discovery_required',
      operationId: 'op-create-1', next: null });
    expect(withoutSqliteWarning(result.stderr)).toBe('');
    expect(fs.readdirSync(state)).toEqual([]);
  });

  it('composes the Claude session client over the internal runtime descriptor', () => {
    // No internal server has published `active.json` under this state root.
    const state = fs.mkdtempSync(path.join(temporaryDirectory, 'state-'));
    const result = spawnSync(process.execPath, [linkedEntrypoint, 'claude', 'read', '--session', 'session-1'], {
      encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: state },
    });

    expect(result.status).toBe(3);
    expect(withoutSqliteWarning(result.stderr)).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, kind: 'refused', code: 'descriptor_missing' });
  });

  it('runs standalone status through a symlink', () => {
    const home = path.join(temporaryDirectory, 'home');
    fs.mkdirSync(home);
    const result = spawnSync(process.execPath, [linkedEntrypoint, 'status'], { encoding: 'utf8', env: { HOME: home, PATH: '' } });

    expect(result.status).toBe(0);
    expect(withoutSqliteWarning(result.stderr)).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      v: 1,
      connected: false,
      binding: null,
      route: 'unavailable',
      sourceCursor: null,
      inbox: null,
      configuration: {
        v: 1, command: 'status', ok: true, changed: false, state: 'no_harness', planDigest: null,
        confirmation: { required: false, confirmed: false }, operations: [], diagnostics: [],
        harnesses: HARNESS_IDS.map(harness => ({ harness, executable: { present: false, path: null },
          version: { detected: null, supported: false }, components: [], route: 'unavailable' })),
      },
    });
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('keeps the internal runtime out of the main bundle and loads it only for internal', () => {
    const main = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'dist/khala.js.meta.json'), 'utf8'));
    expect(Object.keys(main.inputs).filter(input => input.includes('apps/internal'))).toEqual([]);
    expect(Object.keys(main.inputs).some(input => input.endsWith('/connector/src/storage/open.ts'))).toBe(true);
    const imports = Object.values(main.outputs as Record<string, { imports: { path: string }[] }>).flatMap(output => output.imports.map(entry => entry.path));
    // The hosted connector's own durable ledger uses SQLite; source inventory still
    // proves the separate internal application is excluded from this entrypoint.
    expect(imports).toContain('node:sqlite');

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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { InternalCommand, InternalCommandIo } from '@khala/contracts/internal/command';
import { PLAINTEXT_DELETION_NOTICE } from '../lifecycle/delete';
import { seedChannel } from '../lifecycle/fixtures/channel';
import { createInternalRuntime, internalRoot } from './internal-cli';

const fixtureBundle = fileURLToPath(new URL('../launcher/fixtures/internal-web', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function stateHome(): string {
  const state = fs.mkdtempSync(path.join('/tmp', 'khala-internal-cli-'));
  fs.chmodSync(state, 0o700);
  roots.push(state);
  return state;
}

/** A root prepared the way a first launch leaves it, holding one offline channel. */
function seeded(state: string, channelId: string): string {
  const root = internalRoot({ XDG_STATE_HOME: state })!;
  fs.mkdirSync(path.join(root, 'channels'), { recursive: true, mode: 0o700 });
  for (const directory of [path.join(state, 'khala'), root, path.join(root, 'channels')]) fs.chmodSync(directory, 0o700);
  seedChannel(root, channelId, [{ author: 'alice', body: 'hello export' }]);
  return root;
}

function io(state: string, overrides: Partial<InternalCommandIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: InternalCommandIo = {
    stdout: { write: async text => { out.push(text); } },
    stderr: { write: async text => { err.push(text); } },
    signal: AbortSignal.abort(),
    env: { XDG_STATE_HOME: state },
    cwd: state,
    ...overrides,
  };
  return { io: value, out, err, json: (lines: string[]) => JSON.parse(lines.join('').trim().split('\n').at(-1)!) };
}

describe('internal runtime composition', () => {
  it('derives a private root from the XDG state directory', () => {
    expect(internalRoot({ XDG_STATE_HOME: '/state' })).toBe('/state/khala/internal');
    expect(internalRoot({ HOME: '/home/u' })).toBe('/home/u/.local/state/khala/internal');
    expect(internalRoot({ XDG_STATE_HOME: 'relative' })).toBeNull();
    expect(internalRoot({})).toBeNull();
  });

  it('exports one offline channel relative to the working directory without starting a server', async () => {
    const state = stateHome();
    seeded(state, 'ch_export');
    const runtime = createInternalRuntime({ bundleDirectory: '/nonexistent', openBrowser: async () => { throw new Error('must not open'); } });
    const run = io(state);
    const code = await runtime.runInternalCommand({ kind: 'export', channelId: 'ch_export', format: 'markdown', output: 'out.md', replace: false }, run.io);
    expect(code).toBe(0);
    expect(run.json(run.out)).toMatchObject({ ok: true, kind: 'exported', channelId: 'ch_export', format: 'markdown', destination: path.join(state, 'out.md') });
    expect(fs.readFileSync(path.join(state, 'out.md'), 'utf8')).toContain('hello export');
    expect(fs.existsSync(path.join(state, 'khala', 'internal', 'active.json'))).toBe(false);

    const again = io(state);
    expect(await runtime.runInternalCommand({ kind: 'export', channelId: 'ch_export', format: 'jsonl', output: 'out.md', replace: false }, again.io)).toBe(3);
    expect(again.json(again.err)).toEqual({ ok: false, error: 'destination_exists', channelId: 'ch_export' });
  });

  it('requires explicit confirmation to delete and always reports the plaintext boundary', async () => {
    const state = stateHome();
    const root = seeded(state, 'ch_delete');
    const runtime = createInternalRuntime();
    const unconfirmed = io(state);
    expect(await runtime.runInternalCommand({ kind: 'delete', channelId: 'ch_delete', confirmed: false }, unconfirmed.io)).toBe(3);
    expect(unconfirmed.json(unconfirmed.err)).toEqual({
      ok: false, error: 'confirmation_required', channelId: 'ch_delete', notice: PLAINTEXT_DELETION_NOTICE,
    });
    expect(fs.readdirSync(path.join(root, 'channels'))).toHaveLength(1);

    const confirmed = io(state);
    expect(await runtime.runInternalCommand({ kind: 'delete', channelId: 'ch_delete', confirmed: true }, confirmed.io)).toBe(0);
    expect(confirmed.json(confirmed.out)).toEqual({ ok: true, kind: 'deleted', v: 1, channelId: 'ch_delete', notice: PLAINTEXT_DELETION_NOTICE });
    expect(fs.readdirSync(path.join(root, 'channels'))).toEqual([]);

    const missing = io(state);
    expect(await runtime.runInternalCommand({ kind: 'delete', channelId: 'ch_delete', confirmed: true }, missing.io)).toBe(3);
    expect(missing.json(missing.err)).toEqual({ ok: false, error: 'missing_state', channelId: 'ch_delete' });
  });

  it('revalidates commands that cross the bundle boundary', async () => {
    const state = stateHome();
    const runtime = createInternalRuntime();
    for (const command of [
      { kind: 'create', extra: true },
      { kind: 'resume', channelId: '../x' },
      { kind: 'export', channelId: 'ch_1', format: 'pdf', output: 'x', replace: false },
      { kind: 'delete', channelId: 'ch_1', confirmed: 'yes' },
      { kind: 'launch-agent' },
      null,
    ]) {
      const run = io(state);
      expect(await runtime.runInternalCommand(command as unknown as InternalCommand, run.io)).toBe(3);
      expect(run.json(run.err)).toEqual({ ok: false, error: 'invalid_arguments' });
    }
    expect(fs.existsSync(path.join(state, 'khala'))).toBe(false);
  });

  it('refuses to launch without a usable web bundle, before taking any runtime state', async () => {
    const state = stateHome();
    const run = io(state);
    const runtime = createInternalRuntime({ bundleDirectory: path.join(state, 'missing-bundle') });
    expect(await runtime.runInternalCommand({ kind: 'create' }, run.io)).toBe(3);
    expect(run.json(run.err)).toEqual({ ok: false, error: 'web_bundle_unavailable' });
    expect(fs.existsSync(path.join(state, 'khala', 'internal', 'runtime.lock'))).toBe(false);
  });

  it('prints one JSON report plus human recovery lines, then shuts down when aborted', async () => {
    const state = stateHome();
    const abort = new AbortController();
    const run = io(state, { signal: abort.signal });
    const runtime = createInternalRuntime({ bundleDirectory: fixtureBundle, startPort: 0, openBrowser: async () => ({ opened: false, reason: 'test' }) });
    const exit = runtime.runInternalCommand({ kind: 'create' }, run.io);
    while (run.out.length === 0) await new Promise(resolve => setTimeout(resolve, 10));
    const report = run.json(run.out);
    expect(report).toMatchObject({ ok: true, kind: 'running', channelId: expect.stringMatching(/^ch_/), browser: { opened: false } });
    const human = run.err.join('');
    expect(human).toContain(report.url);
    expect(human).toContain(report.resumeCommand);
    expect(human).toContain('Agent sessions you started are not affected.');
    abort.abort();
    expect(await exit).toBe(0);
    expect(fs.existsSync(report.descriptorPath)).toBe(false);
  });
});

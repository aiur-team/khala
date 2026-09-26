import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PATH_HARNESS_IDS, createDiscoveryOnlyAdapter, createNodeSetupProbe, detectHarness } from './detect.js';
import { HARNESS_IDS, type SetupEnvironment, type SetupProbe } from './types.js';

const SECRET = 'sentinel-secret-detect';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function temporary(): string {
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-detect-'));
  directories.push(directory);
  return directory;
}

function script(directory: string, name: string, body: string): string {
  const file = path.join(directory, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

function environment(probe: SetupProbe): SetupEnvironment {
  return { home: '/h', xdgConfigHome: '/h/.config', xdgDataHome: '/h/.local/share', xdgStateHome: '/h/.local/state', probe };
}

function fakeProbe(executables: Record<string, string>, run: (executable: string) => Promise<string>): SetupProbe & { runs: string[][] } {
  const runs: string[][] = [];
  return {
    runs,
    async resolveExecutable(name) { return executables[name] ?? null; },
    async runVersion(executable, args) { runs.push([executable, ...args]); return run(executable); },
    async readFile() { return null; },
    async listDirectory() { return null; },
  };
}

describe('detectHarness', () => {
  it('reports an absent executable without running anything', async () => {
    const probe = fakeProbe({}, async () => '1.0.0');
    expect(await detectHarness(environment(probe), 'codex')).toEqual({ executable: null, version: null, supported: false });
    expect(probe.runs).toEqual([]);
  });

  it.each([
    ['claude', '2.1.3 (Claude Code)\n', '2.1.3'],
    ['codex', 'codex-cli 0.154.0\n', '0.154.0'],
    ['opencode', 'v1.4.2\n', '1.4.2'],
    ['cursor', '1.7.44\n9f3a2c1d\nx64\n', '1.7.44'],
  ] as const)('parses the %s version by absolute path and never marks it supported', async (harness, output, version) => {
    const probe = fakeProbe({ [harness]: `/usr/bin/${harness}` }, async () => output);
    expect(await detectHarness(environment(probe), harness)).toEqual({ executable: `/usr/bin/${harness}`, version, supported: false });
    expect(probe.runs).toEqual([[`/usr/bin/${harness}`, '--version']]);
  });

  it('distinguishes a failed or malformed probe from absence and drops raw output', async () => {
    const failing = fakeProbe({ codex: '/usr/bin/codex' }, async () => { throw new Error(SECRET); });
    const malformed = fakeProbe({ codex: '/usr/bin/codex' }, async () => `${SECRET} 9.9.9`);
    for (const probe of [failing, malformed]) {
      const detection = await detectHarness(environment(probe), 'codex');
      expect(detection).toEqual({ executable: '/usr/bin/codex', version: null, supported: false });
      const observation = await createDiscoveryOnlyAdapter('codex').inspect(environment(probe), detection);
      expect(observation.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['version_probe_failed']);
      expect(JSON.stringify(observation)).not.toContain(SECRET);
    }
  });

  it('gives the discovery-only adapter no operations to plan', async () => {
    const adapter = createDiscoveryOnlyAdapter('claude');
    expect(Object.keys(adapter).sort()).toEqual(['detect', 'harness', 'inspect', 'plan']);
    expect(adapter.plan({ desired: 'present', observation: {
      detection: { executable: '/usr/bin/claude', version: '1.0.0', supported: false },
      components: [], route: 'unknown', diagnostics: [] } })).toEqual([]);
  });

  it('discovers every harness on PATH except Claude Desktop, which only its adapter can find', () => {
    expect(PATH_HARNESS_IDS).toEqual(HARNESS_IDS.filter(harness => harness !== 'claude-app'));
  });
});

describe('createNodeSetupProbe', () => {
  it('resolves the first executable file on PATH order and ignores non-executables', async () => {
    const first = temporary();
    const second = temporary();
    fs.writeFileSync(path.join(first, 'codex'), 'not executable', { mode: 0o644 });
    fs.mkdirSync(path.join(first, 'claude'));
    const expected = script(second, 'codex', 'echo 1.0.0');
    const probe = createNodeSetupProbe({ pathEntries: [first, second], environment: {} });
    expect(await probe.resolveExecutable('codex')).toBe(expected);
    expect(await probe.resolveExecutable('claude')).toBeNull();
    expect(await probe.resolveExecutable('../codex')).toBeNull();
  });

  it('runs the version probe with only the injected environment', async () => {
    const bin = temporary();
    const executable = script(bin, 'codex', 'exec /usr/bin/env');
    const probe = createNodeSetupProbe({ pathEntries: [bin], environment: { HOME: '/synthetic', PATH: bin } });
    const lines = (await probe.runVersion(executable, [])).trim().split('\n').filter(line => !line.startsWith('PWD=')
      && !line.startsWith('SHLVL=') && !line.startsWith('_='));
    expect(lines.sort()).toEqual([`PATH=${bin}`, 'HOME=/synthetic'].sort());
  });

  it('rejects relative executables, nonzero exits, and floods, killing descendants', async () => {
    const bin = temporary();
    const marker = path.join(bin, 'child-alive');
    const probe = createNodeSetupProbe({ pathEntries: [bin], environment: { PATH: '/usr/bin:/bin' } });
    await expect(probe.runVersion('codex', [])).rejects.toThrow('relative_executable');
    await expect(probe.runVersion(script(bin, 'fail', 'echo 1.0.0; exit 3'), [])).rejects.toThrow('nonzero_exit');
    const flood = script(bin, 'flood', `(sleep 1; touch '${marker}') & while :; do echo ${SECRET}; done`);
    await expect(probe.runVersion(flood, [])).rejects.toThrow('output_limit');
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('reads files without following symlinks and treats absence as null', async () => {
    const root = temporary();
    fs.writeFileSync(path.join(root, 'real'), 'bytes');
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    const probe = createNodeSetupProbe({ pathEntries: [], environment: {} });
    expect(Buffer.from((await probe.readFile(path.join(root, 'real')))!).toString()).toBe('bytes');
    expect(await probe.readFile(path.join(root, 'missing'))).toBeNull();
    await expect(probe.readFile(path.join(root, 'link'))).rejects.toThrow();
    expect(await probe.listDirectory(root)).toEqual(['link', 'real']);
    expect(await probe.listDirectory(path.join(root, 'missing'))).toBeNull();
  });
});

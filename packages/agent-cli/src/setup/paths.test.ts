import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSetupPaths, SetupPathError } from './paths.js';

describe('resolveSetupPaths', () => {
  it('derives every path from explicit HOME with XDG defaults', () => {
    expect(resolveSetupPaths({ HOME: '/home/alice', PATH: '/opt/bin:/usr/bin' })).toEqual({
      home: '/home/alice',
      configHome: '/home/alice/.config',
      dataHome: '/home/alice/.local/share',
      stateHome: '/home/alice/.local/state',
      codexHome: '/home/alice/.codex',
      versionsRoot: '/home/alice/.local/share/khala/versions',
      binRoot: '/home/alice/.local/share/khala/bin',
      manifestPath: '/home/alice/.local/state/khala/setup/manifest.v1.json',
      transactionPath: '/home/alice/.local/state/khala/setup/transaction.v1.json',
      backupsRoot: '/home/alice/.local/state/khala/setup/backups',
      runtimeDescriptorPath: '/home/alice/.local/state/khala/internal/active.json',
      pathEntries: ['/opt/bin', '/usr/bin'],
    });
  });

  it('overrides each XDG root independently and treats empty values as unset', () => {
    const overridden = resolveSetupPaths({ HOME: '/h', XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: '/d', XDG_STATE_HOME: '/s' });
    expect([overridden.configHome, overridden.dataHome, overridden.stateHome]).toEqual(['/c', '/d', '/s']);
    expect(overridden.runtimeDescriptorPath).toBe('/s/khala/internal/active.json');
    expect(overridden.transactionPath).toBe('/s/khala/setup/transaction.v1.json');
    const empty = resolveSetupPaths({ HOME: '/h', XDG_CONFIG_HOME: '', XDG_DATA_HOME: '', XDG_STATE_HOME: '' });
    expect([empty.configHome, empty.dataHome, empty.stateHome]).toEqual(['/h/.config', '/h/.local/share', '/h/.local/state']);
  });

  it('honors CODEX_HOME and treats an empty one as unset', () => {
    expect(resolveSetupPaths({ HOME: '/h', CODEX_HOME: '/srv/codex' }).codexHome).toBe('/srv/codex');
    expect(resolveSetupPaths({ HOME: '/h', CODEX_HOME: '' }).codexHome).toBe('/h/.codex');
  });

  it.each([
    [{}, 'invalid_home'],
    [{ HOME: '' }, 'invalid_home'],
    [{ HOME: 'relative/home' }, 'invalid_home'],
    [{ HOME: '/h', XDG_CONFIG_HOME: 'cfg' }, 'invalid_xdg_config_home'],
    [{ HOME: '/h', XDG_DATA_HOME: './data' }, 'invalid_xdg_data_home'],
    [{ HOME: '/h', XDG_STATE_HOME: 'state' }, 'invalid_xdg_state_home'],
    [{ HOME: '/h', CODEX_HOME: 'codex' }, 'invalid_codex_home'],
  ])('fails closed on %j', (input, code) => {
    expect(() => resolveSetupPaths(input)).toThrow(expect.objectContaining({ code }));
    expect(() => resolveSetupPaths(input)).toThrow(SetupPathError);
  });

  it('keeps only distinct absolute PATH entries and never resolves the working directory', () => {
    expect(resolveSetupPaths({ HOME: '/h', PATH: ':.:bin:/a:/a/:/b:../x:' }).pathEntries).toEqual(['/a', '/b']);
    expect(resolveSetupPaths({ HOME: '/h' }).pathEntries).toEqual([]);
  });

  it('touches nothing on disk', () => {
    const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-paths-'));
    try {
      resolveSetupPaths({ HOME: home, PATH: path.join(home, 'bin') });
      expect(fs.readdirSync(home)).toEqual([]);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

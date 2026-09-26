// The runner never launches, wraps or hosts an agent (executor decision 24): its
// command allowlist refuses `khala run <cli>` and every agent CLI, and only the
// guarded adapters may start a process at all.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCommand } from '../../../scripts/acceptance/guard';

const PACKAGE = '@aiur/khala@0.4.0';
const SCRIPTS = fileURLToPath(new URL('../../../scripts/acceptance/', import.meta.url));

function sources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : file.endsWith('.ts') ? [file] : [];
  });
}

describe('runner command guard', () => {
  it.each([
    [['npx', '--yes', PACKAGE, 'run', 'claude']],
    [['khala', 'run', 'codex']],
    [['npx', '--yes', PACKAGE, 'run', 'opencode', '--model', 'deepseek']],
    [['claude', '--resume', 'abc']],
    [['/usr/local/bin/codex', 'exec', 'hi']],
    [['opencode']],
    [['codex', 'app-server']],
    [['npx', '--yes', PACKAGE, 'app-server']],
    [['npx', '--yes', '@aiur/khala@latest', 'status']],
    [['npx', PACKAGE, 'status']],
    [['sqlite3', '/home/me/.local/state/khala/internal/channels/x/room.sqlite']],
    [['sh', '-c', 'khala run claude']],
    [['gh', 'pr', 'create']],
  ])('refuses %j', argv => {
    expect(checkCommand(argv, PACKAGE).ok).toBe(false);
  });

  it.each([
    [['npx', '--yes', PACKAGE, 'status']],
    [['npx', '--yes', PACKAGE, 'internal']],
    [['npx', '--yes', PACKAGE, 'internal', '--resume', 'channel_abc-123']],
    [['gh', 'api', 'repos/aiur-team/khala/issues']],
  ])('allows %j', argv => {
    expect(checkCommand(argv, PACKAGE)).toEqual({ ok: true });
  });

  it('starts processes only from adapters that check every command first', () => {
    const starters = sources(SCRIPTS).filter(file => /node:child_process/.test(fs.readFileSync(file, 'utf8')));
    expect(starters.map(file => path.relative(SCRIPTS, file)).sort()).toEqual(['adapters/github.ts', 'adapters/launcher.ts', 'main.ts']);
    for (const file of starters) {
      const text = fs.readFileSync(file, 'utf8');
      const starts = text.match(/\b(?:spawn|execFile|exec|fork)\(|promisify\(execFile\)/g) ?? [];
      expect(starts.length, file).toBeGreaterThan(0);
      expect((text.match(/assertCommand\(argv/g) ?? []).length, file).toBeGreaterThanOrEqual(1);
      expect(text, file).not.toMatch(/['"`]run['"`]/);
    }
  });
});

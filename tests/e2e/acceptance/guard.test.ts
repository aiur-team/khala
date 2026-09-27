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
    [['tmux', 'new-session', '-d']],
    [['tmux', 'send-keys', '-t', '%7', 'hello']],
    [['tmux', 'send-keys', '-t', '%7', 'C-c']],
    [['tmux', 'send-keys', '-t', '%7', '-l', '/status']],
    [['tmux', 'capture-pane', '-p', '-t', 'other']],
    [['tmux', 'display-message', '-p', '-t', '%7', '#{pane_pid}']],
    [['/proc/4242/exe', '--model', 'gpt-6-sol']],
    [['/proc/4242/exe', '--version', 'extra']],
    // The runner acts as the human controller, never as an agent session.
    [['npx', '--yes', PACKAGE, 'send', 'hello']],
    [['khala', 'join', 'http://127.0.0.1:4870/channels/x']],
    [['npx', '--yes', PACKAGE, 'internal', '--resume', 'x;rm -rf /']],
  ])('refuses %j', argv => {
    expect(checkCommand(argv, PACKAGE).ok).toBe(false);
  });

  it('names agent launching as the reason `khala run` is refused', () => {
    for (const argv of [['khala', 'run', 'claude'], ['npx', '--yes', PACKAGE, 'run', 'codex']]) {
      expect(checkCommand(argv, PACKAGE)).toEqual({ ok: false, reason: 'khala run wraps an agent CLI; the runner never launches an agent' });
    }
  });

  it.each([
    [['npx', '--yes', PACKAGE, 'status']],
    [['npx', '--yes', PACKAGE, 'internal']],
    [['npx', '--yes', PACKAGE, 'internal', '--resume', 'channel_abc-123']],
    [['gh', 'api', 'repos/aiur-team/khala/issues']],
    [['tmux', 'display-message', '-p', '-t', '%7', '#{pane_tty}']],
    [['tmux', 'display-message', '-p', '-t', '%7', '#{pane_title}']],
    [['tmux', 'capture-pane', '-p', '-t', '%7']],
  ])('allows %j', argv => {
    expect(checkCommand(argv, PACKAGE)).toEqual({ ok: true });
  });

  it('allows only a fixture image version query outside package commands', () => {
    expect(checkCommand(['/proc/4242/exe', '--version'], null)).toEqual({ ok: true });
    expect(checkCommand(['/proc/4242/exe', '--version'], PACKAGE).ok).toBe(false);
  });

  it('starts processes only from adapters that check every command first', () => {
    const starters = sources(SCRIPTS).filter(file => /node:child_process/.test(fs.readFileSync(file, 'utf8')));
    expect(starters.map(file => path.relative(SCRIPTS, file)).sort()).toEqual(['adapters/aiur.ts', 'adapters/github.ts', 'adapters/launcher.ts', 'main.ts']);
    for (const file of starters) {
      const text = fs.readFileSync(file, 'utf8');
      const starts = text.match(/\b(?:spawn|execFile|execFileSync|exec|fork)\(|promisify\(execFile\)/g) ?? [];
      expect(starts.length, file).toBeGreaterThan(0);
      expect((text.match(/assertCommand\(argv/g) ?? []).length, file).toBeGreaterThanOrEqual(1);
      expect(text, file).not.toMatch(/['"`]run['"`]/);
    }
  });

  it('does not import disposable integration process starters into the guarded runner', () => {
    const repo = path.resolve(SCRIPTS, '../..');
    const fixtures = path.join(repo, 'tests/integration/');
    const visited = new Set<string>();
    const pending = sources(SCRIPTS);
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"](\.[^'"]+)['"]/gu)) {
        const stem = path.resolve(path.dirname(file), match[1]!);
        const imported = [stem, `${stem}.ts`, `${stem}.tsx`, path.join(stem, 'index.ts')]
          .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (imported && imported.startsWith(repo + path.sep)) pending.push(imported);
      }
    }
    expect([...visited].filter(file => file.startsWith(fixtures))).toEqual([]);
  });
});

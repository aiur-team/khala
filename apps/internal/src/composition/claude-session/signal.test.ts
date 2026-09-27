import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeWakeSignalPath as pluginSignalPath } from '../../../../../packages/claude-plugin/hooks/lib/runtime.mjs';
import { claudeWakeSignalPath, ensureClaudeWakeSignal, pulseClaudeWakeSignal } from './signal';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-filechanged-'));
  roots.push(directory);
  return path.join(directory, 'internal');
}

describe('Claude native wake signal', () => {
  it('uses the plugin path recipe and changes one private inode with metadata only', () => {
    const internal = root();
    const file = claudeWakeSignalPath(internal, 'session-a');
    expect(file).toBe(pluginSignalPath(path.join(path.dirname(internal), 'claude-hooks'), 'session-a'));
    expect(file).not.toBe(claudeWakeSignalPath(internal, 'session-b'));
    expect(fs.existsSync(file)).toBe(false);
    expect(ensureClaudeWakeSignal(internal, 'session-a')).toBe(true);
    const inode = fs.statSync(file).ino;
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(pulseClaudeWakeSignal(internal, 'session-a', 7)).toBe(true);
    expect(fs.statSync(file).ino).toBe(inode);
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^7:[a-f0-9]{32}$/);
  });

  it('refuses a substituted signal link before touching its target', () => {
    const internal = root();
    const file = claudeWakeSignalPath(internal, 'session-a');
    expect(ensureClaudeWakeSignal(internal, 'session-a')).toBe(true);
    const target = path.join(path.dirname(internal), 'untouched');
    fs.writeFileSync(target, 'safe');
    fs.unlinkSync(file);
    fs.symlinkSync(target, file);
    expect(ensureClaudeWakeSignal(internal, 'session-a')).toBe(false);
    expect(pulseClaudeWakeSignal(internal, 'session-a', 7)).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('safe');
  });
});

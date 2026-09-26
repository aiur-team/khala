import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FROZEN_HOOK_EVENTS } from './contract';
import { validatePlugin } from './validate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = Object.values(FROZEN_HOOK_EVENTS);

function copyPlugin(): string {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-plugin-'));
  fs.cpSync(root, copy, { recursive: true, filter: source => !/node_modules|dist/.test(source) });
  return copy;
}

describe('claude plugin scaffold', () => {
  it('conforms to the frozen contract', () => {
    expect(validatePlugin(root)).toEqual([]);
  });

  it('fails validation when the manifest registers a hook event outside the frozen list', () => {
    const copy = copyPlugin();
    const file = path.join(copy, 'hooks/hooks.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.hooks.PreToolUse = manifest.hooks.PostToolUse;
    fs.writeFileSync(file, JSON.stringify(manifest));
    expect(validatePlugin(copy)).toContain('hook event PreToolUse is not in the frozen list');
  });

  it('fails validation when a frozen hook event is dropped or the MCP entry is renamed', () => {
    const copy = copyPlugin();
    const hooksFile = path.join(copy, 'hooks/hooks.json');
    const manifest = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    delete manifest.hooks.Stop;
    fs.writeFileSync(hooksFile, JSON.stringify(manifest));
    fs.writeFileSync(path.join(copy, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'khala', args: ['mcp-serve'] } } }));
    expect(validatePlugin(copy)).toEqual(expect.arrayContaining([
      'hook event Stop must run hooks/stop.mjs',
      'the only MCP entry must be khala',
    ]));
  });

  it.each(scripts)('stub %s exits 0 with no output', script => {
    const result = spawnSync(process.execPath, [path.join(root, script)], { input: '{}', encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it.each(scripts)('stub %s has no imports and no network access', script => {
    const source = fs.readFileSync(path.join(root, script), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/\b(?:import|require|fetch|XMLHttpRequest|WebSocket)\b/);
  });

  it('carries no dangerous flags or isolated setting sources', () => {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '.'], { cwd: root, encoding: 'utf8' })
      .split('\n').filter(name => name && !name.endsWith('.test.ts') && !name.endsWith('README.md'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(fs.readFileSync(path.join(root, file), 'utf8'), file).not.toMatch(/--dangerously-|--setting-sources|setting-sources/);
    }
  });

  it('embeds no port or token in the MCP entry', () => {
    expect(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).not.toMatch(/token|port|4870|Bearer/i);
  });
});

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FROZEN_COMMAND_VERBS, FROZEN_HOOK_EVENTS, FROZEN_MCP_TOOLS } from './contract';
import { validatePlugin } from './validate';
import { HOOK_ROLES } from '../hooks/lib/runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = Object.values(FROZEN_HOOK_EVENTS).flat();

function copyPlugin(): string {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-plugin-'));
  fs.cpSync(root, copy, { recursive: true, filter: source => !/node_modules|dist/.test(source) });
  return copy;
}

describe('claude plugin scaffold', () => {
  it('conforms to the frozen contract', () => {
    expect(validatePlugin(root)).toEqual([]);
  });

  it('freezes the MCP tools, including khala_status, and documents each', () => {
    expect(FROZEN_MCP_TOOLS).toContain('khala_status');
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    for (const verb of FROZEN_COMMAND_VERBS) expect(readme).toContain(`/khala ${verb}`);
    for (const tool of FROZEN_MCP_TOOLS) expect(readme).toContain(`\`${tool}\``);
  });

  it('lists the full frozen MCP tool set', () => {
    expect([...FROZEN_MCP_TOOLS]).toEqual([
      'khala_send',
      'khala_read',
      'khala_status',
      'khala_listening_mode',
      'khala_mode_get',
      'khala_mode_set',
      'khala_create_channel',
      'khala_list_channels',
      'khala_request_channel_access',
      'khala_channel_access_status',
      'khala_list_agents',
    ]);
  });

  it('fails validation when the manifest registers a hook event outside the frozen list', () => {
    const copy = copyPlugin();
    const file = path.join(copy, 'hooks/hooks.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.hooks.PreToolUse = manifest.hooks.PostToolUse;
    fs.writeFileSync(file, JSON.stringify(manifest));
    expect(validatePlugin(copy)).toContain('hook event PreToolUse is not in the frozen list');
  });

  it('fails validation when a hook other than the Stop watcher sets asyncRewake, or the watcher loses it', () => {
    const copy = copyPlugin();
    const file = path.join(copy, 'hooks/hooks.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.hooks.UserPromptSubmit[0].hooks[0].asyncRewake = true;
    delete manifest.hooks.Stop[0].hooks[1].asyncRewake;
    fs.writeFileSync(file, JSON.stringify(manifest));
    const errors = validatePlugin(copy);
    expect(errors.some(e => e.includes('user-prompt-submit.mjs') && e.includes('asyncRewake'))).toBe(true);
    expect(errors).toEqual(expect.arrayContaining(['hooks/stop-watcher.mjs must set asyncRewake']));
  });

  it('fails validation when a hook event outside the frozen list is registered', () => {
    const copy = copyPlugin();
    const file = path.join(copy, 'hooks/hooks.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.hooks.PreToolUse = manifest.hooks.PostToolUse;
    fs.writeFileSync(file, JSON.stringify(manifest));
    expect(validatePlugin(copy)).toEqual(expect.arrayContaining(['hook event PreToolUse is not in the frozen list']));
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

  it.each(scripts)('hook %s exits 0 with no output on input that is not its Claude event', script => {
    const result = spawnSync(process.execPath, [path.join(root, script)], { input: '{}', encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it.each(scripts)('hook %s is a thin entry into the runtime with its own role', script => {
    const source = fs.readFileSync(path.join(root, script), 'utf8').replace(/^\s*\/\/.*$/gm, '').trim();
    const role = path.basename(script, '.mjs');
    expect(HOOK_ROLES).toHaveProperty(role);
    expect(source).toBe(`import { main } from './lib/runtime.mjs';\n\nawait main('${role}');`);
  });

  it('reaches Khala only through the khala adapter command: no network, inbox, or acknowledgement path', () => {
    const source = fs.readFileSync(path.join(root, 'hooks/lib/runtime.mjs'), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1]).sort();
    expect(imports).toEqual(['node:child_process', 'node:crypto', 'node:fs/promises', 'node:os', 'node:path']);
    const code = source.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '');
    expect(code).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|require)\b|node:(?:https?|net|tls|dgram)/);
    expect(code).not.toMatch(/inbox|ackBatchToken|--ack|exec\(|shell:\s*true/);
    // Only the non-acknowledging adapter ops; `read`, `send`, `status` and `mode` are agent calls.
    const ops = [...code.matchAll(/deps\.khala\('([a-z]+)'/g)].map(match => match[1]).sort();
    expect(ops).toEqual(['hook', 'pending', 'pull']);
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

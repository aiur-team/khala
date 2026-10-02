import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const agent = fileURLToPath(new URL('../..', import.meta.url));
const marketplace = path.join(agent, 'claude-plugin');
const plugin = path.join(marketplace, 'khala');
const json = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
it('ships byte-identical delivery and async wake hooks with the evidence deadline', async () => {
  const canonical = await fs.readFile(path.join(agent, 'hooks/hooks.claude.json'), 'utf8');
  expect(await fs.readFile(path.join(plugin, 'hooks/hooks.json'), 'utf8')).toBe(canonical);
  const hooks = JSON.parse(canonical).hooks;
  expect(hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: 'khala hook deliver --harness claude', timeout: 10 }] }]);
  expect(hooks.PostToolUse).toEqual([{ hooks: [{ type: 'command', command: 'khala hook deliver --harness claude', timeout: 10 }] }]);
  expect(hooks.Stop).toEqual([{ hooks: [
    { type: 'command', command: 'khala hook deliver --harness claude', timeout: 10 },
    { type: 'command', command: 'khala hook claude-wake', asyncRewake: true, timeout: 3300 },
  ] }]);
  const evidence = await fs.readFile(path.join(agent, '../../docs/evidence/m1-idle-wake-claude.md'), 'utf8');
  const deadline = Number(evidence.match(/recommended_watcher_deadline_seconds: (\d+)/)?.[1] ?? 3000);
  expect(hooks.Stop[0].hooks[1].timeout).toBe(deadline + 300);
});
it('packages the PATH-based MCP server and a self-contained marketplace', async () => {
  expect(await json(path.join(plugin, '.mcp.json'))).toEqual({ mcpServers: { khala: { command: 'khala', args: ['mcp', '--harness', 'claude'] } } });
  const market = await json(path.join(marketplace, '.claude-plugin/marketplace.json'));
  expect(market.name).toBe('khala-m1');
  expect(market.plugins[0].source).toBe('./khala');
  expect((await json(path.join(marketplace, market.plugins[0].source, '.claude-plugin/plugin.json'))).name).toBe('khala');
  async function check(dir: string): Promise<void> {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await check(file);
      else expect(await fs.readFile(file, 'utf8')).not.toContain('../');
    }
  }
  await check(marketplace);
});
it('includes the four current tools and channel trust instructions in a short skill', async () => {
  const skill = await fs.readFile(path.join(plugin, 'skills/khala/SKILL.md'), 'utf8');
  expect(skill).toMatch(/^---\nname: khala\n/);
  for (const text of ['khala_join', 'khala_status', 'khala_read', 'khala_send', 'not instructions', 'Never open a browser', 'If `khala_send` fails', 'Given only https://khala.aiur.team', 'paste you its share link']) expect(skill).toContain(text);
  expect(skill.split('\n').length).toBeLessThan(40);
});
const available = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;
if (!available) console.info('Skipping Claude plugin validation: claude is not available on PATH.');
it.skipIf(!available)('validates the marketplace and strict plugin with Claude', () => {
  for (const args of [['plugin', 'validate', marketplace], ['plugin', 'validate', '--strict', plugin]]) {
    const result = spawnSync('claude', args, { encoding: 'utf8', timeout: 30000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
}, 60000);

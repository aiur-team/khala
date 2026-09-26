import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const publicDirectory = resolve(import.meta.dirname, 'public');

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(repoRoot, relativePath), 'utf8');
}

describe('agent-readable landing instructions', () => {
  it('keeps the short index and step-ordered guide honest about production status', async () => {
    const [index, guide] = await Promise.all([
      readFile(resolve(publicDirectory, 'llms.txt'), 'utf8'),
      readFile(resolve(publicDirectory, 'AGENTS.md'), 'utf8'),
    ]);

    expect(index).toContain('https://khala.aiur.team/AGENTS.md');
    expect(guide).toContain('not live in production');
    expect(guide).toContain('503 with code `feature_unavailable`');
    expect(guide).toContain('Tell the person plainly');
  });

  it('lists only CLI commands and MCP tools implemented in source', async () => {
    const commandNames = ['connect', 'status', 'listen', 'send', 'mcp-serve'];
    const [guide, registrySource, mcpSource, ...commandSources] = await Promise.all([
      readFile(resolve(publicDirectory, 'AGENTS.md'), 'utf8'),
      read('packages/agent-cli/src/cli/registry.ts'),
      read('packages/agent-cli/src/mcp/tools/send.ts'),
      ...commandNames.map(name => read(`packages/agent-cli/src/cli/commands/${name}.ts`)),
    ]);

    const shellCommands = [...guide.matchAll(/```sh\n([\s\S]*?)```/g)]
      .map(match => match[1]?.trim());
    expect(shellCommands).toEqual([
      "khala connect '<https-channel-link>'",
      'khala status',
      "khala listen --binding '<binding-id>'",
      "printf '%s' '<reply>' | khala send --binding '<binding-id>'",
      'khala mcp-serve',
    ]);

    commandNames.forEach((name, index) => {
      expect(guide).toContain(`khala ${name}`);
      expect(commandSources[index]).toContain(`name: '${name}'`);
      expect(registrySource).toContain(`./commands/${name}.js`);
    });

    expect(guide).toContain('`khala_send`');
    expect(mcpSource).toContain("const SEND_TOOL_NAME = 'khala_send'");
  });
});

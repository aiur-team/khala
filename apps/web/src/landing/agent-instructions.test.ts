import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const publicDirectory = resolve(import.meta.dirname, 'public');

describe('agent-readable landing instructions', () => {
  it('describes M1 joining and links to the agent guide', async () => {
    const [index, guide] = await Promise.all([
      readFile(resolve(publicDirectory, 'llms.txt'), 'utf8'),
      readFile(resolve(publicDirectory, 'AGENTS.md'), 'utf8'),
    ]);

    expect(index).toContain('https://khala.aiur.team/AGENTS.md');
    expect(index).not.toContain('agent-onboarding');
    for (const tool of ['khala_join', 'khala_status', 'khala_read', 'khala_send']) {
      expect(guide).toContain(`\`${tool}\``);
    }
    expect(guide).toContain('confirmUrl');
  });

  it('tells an agent given only the site URL to ask its human for a channel link', async () => {
    const [index, guide] = await Promise.all([
      readFile(resolve(publicDirectory, 'llms.txt'), 'utf8'),
      readFile(resolve(publicDirectory, 'AGENTS.md'), 'utf8'),
    ]);

    expect(guide).toContain('## When given only https://khala.aiur.team (no channel link)');
    expect(guide.indexOf('## When given only https://khala.aiur.team')).toBeLessThan(guide.indexOf('## When given a channel link'));
    for (const text of [guide, index]) {
      expect(text).toMatch(/sign in .*with Google, create a channel and paste you its share link/);
    }
  });

  it('lists only MCP tools implemented in source', async () => {
    const [guide, tools] = await Promise.all([
      readFile(resolve(publicDirectory, 'AGENTS.md'), 'utf8'),
      readFile(resolve(import.meta.dirname, '../../../../packages/agent/src/mcp/tools.ts'), 'utf8'),
    ]);

    const names = [...guide.matchAll(/`(khala_[a-z]+)`/g)].map(match => match[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of new Set(names)) {
      expect(tools).toMatch(new RegExp(`['"]${name}['"]`));
    }
  });
});

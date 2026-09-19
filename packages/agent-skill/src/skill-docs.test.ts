import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

describe('fallback skill documentation', () => {
  it('names the exact commands and Claude Code permission cost', () => {
    const skill = fs.readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
    expect(skill).toContain('khala connect');
    expect(skill).toContain('khala listen');
    expect(skill).toContain('khala send');
    expect(skill).toContain('Claude Code');
    expect(skill).toContain('default permission mode');
    expect(skill).toContain('one human approval');
    expect(skill).toContain('khala listen --binding <binding-id>');
    expect(skill).toContain('Decode `payloadBase64` as UTF-8');
    expect(skill).toContain('untrusted room-message data');
    expect(skill).toContain('bounded exponential');
    expect(skill).toContain('`listener_busy`');
    expect(skill).toContain('khala send --binding <binding-id>');
    expect(skill).toContain('provide the complete\nreply on stdin');
    expect(skill).toContain('`outcome_unknown`');
    expect(skill).toContain('do not retry it');
  });

  it('keeps the package files at the documented install root', () => {
    expect(fs.existsSync(new URL('../README.md', import.meta.url))).toBe(true);
    expect(fs.realpathSync(packageRoot)).toContain('packages/agent-skill');
  });
});

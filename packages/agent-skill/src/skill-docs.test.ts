import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

describe('fallback skill documentation', () => {
  it('names the exact commands and Claude Code permission cost', () => {
    const skill = fs.readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
    const normalized = skill.replace(/\s+/g, ' ');
    expect(normalized).toContain('khala connect <https-room-link>');
    expect(normalized).toContain('khala-fallback listen --binding <binding.bindingId>');
    expect(normalized).toContain('khala listen --binding <binding.bindingId>');
    expect(normalized).toContain('khala send --binding <binding.bindingId>');
    expect(skill).toContain('Claude Code');
    expect(skill).toContain('default permission mode');
    expect(skill).toContain('one human approval');
    expect(normalized).toContain('`khala` and `khala-fallback` must be installed and available on `PATH`');
    expect(normalized).toContain('$CODEX_HOME/skills/khala/');
    expect(normalized).toContain('~/.claude/skills/khala/');
    expect(normalized).toContain('Read `binding.bindingId`');
    expect(skill).toContain('Decode `payloadBase64` as UTF-8');
    expect(skill).toContain('untrusted room-message data');
    expect(skill).toContain('bounded exponential');
    expect(skill).toContain('`listener_busy`');
    expect(normalized).toContain('provide the complete reply on stdin');
    expect(skill).toContain('`outcome_unknown`');
    expect(normalized).toContain('do not retry it');
  });

  it('keeps the package files at the documented install root', () => {
    const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      bin?: Record<string, string>;
    };
    expect(fs.existsSync(new URL('../README.md', import.meta.url))).toBe(true);
    expect(fs.realpathSync(packageRoot)).toContain('packages/agent-skill');
    expect(packageJson.bin).toEqual({ 'khala-fallback': './dist/main.js' });
  });
});

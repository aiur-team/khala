import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runCli, type CliDependencies } from '@khala/agent-cli/cli/app';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

function cliStreams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let error = '';
  stdin.end();
  stderr.on('data', chunk => { error += String(chunk); });
  return { stdin, stdout, stderr, error: () => error };
}

const cliClient: CliDependencies['client'] = {
  async connect() { throw new Error('connect should reject missing arguments before reaching the client'); },
  async send() { throw new Error('send should reject empty stdin before reaching the client'); },
  async status() {
    return { v: 1, connected: false, binding: null, route: 'unavailable', sourceCursor: null };
  },
};

async function invokeCli(command: string) {
  const io = cliStreams();
  const exitCode = await runCli([command], {
    client: cliClient,
    inbox: async () => { throw new Error('disconnected commands should not open an inbox'); },
    ...io,
  });
  return { exitCode, error: io.error() };
}

describe('fallback skill documentation', () => {
  it('names the exact commands and Claude Code permission cost', () => {
    const skill = fs.readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
    const normalized = skill.replace(/\s+/g, ' ');
    expect(normalized).toContain('khala connect <https-channel-link>');
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
    expect(skill).toContain('untrusted channel message data');
    expect(skill).toContain('bounded exponential');
    expect(skill).toContain('`listener_busy`');
    expect(normalized).toContain('provide the complete reply on stdin');
    expect(skill).toContain('`outcome_unknown`');
    expect(normalized).toContain('do not retry it');
  });

  it('only documents agent CLI commands recognized by the CLI parser', async () => {
    const skill = fs.readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
    const documentedCommands = [...skill.matchAll(/`khala ([a-z][a-z-]*)(?:\s|`)/g)]
      .map(match => match[1]!)
      .filter((command, index, commands) => commands.indexOf(command) === index)
      .sort();

    expect(documentedCommands).toEqual(['connect', 'listen', 'send', 'status']);
    for (const command of documentedCommands) {
      const result = await invokeCli(command);
      expect(result.error, `documented command "${command}" was rejected by runCli`).not.toContain('invalid_arguments');
    }

    const unknown = await invokeCli('not-a-real-command');
    expect(unknown.exitCode).toBe(2);
    expect(JSON.parse(unknown.error)).toEqual({ ok: false, error: 'invalid_arguments' });
  });

  it('keeps the package files at the documented install root', () => {
    const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      bin?: Record<string, string>;
    };
    expect(fs.existsSync(new URL('../README.md', import.meta.url))).toBe(true);
    expect(fs.realpathSync(packageRoot)).toContain('packages/agent-skill');
    expect(packageJson.bin).toEqual({ 'khala-fallback': './dist/bin.js' });
  });
});

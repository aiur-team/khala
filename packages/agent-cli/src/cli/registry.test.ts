import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runCli } from './app.js';
import { CLI_COMMANDS, CommandRegistryError, commandRegistry, createCommandRegistry } from './registry.js';
import type { AgentClientPort, CliCommand, CliDependencies } from './types.js';

function deps(): { deps: CliDependencies; stdout: () => string; stderr: () => string } {
  const capture = () => {
    const chunks: string[] = [];
    return { stream: new Writable({ write(chunk, _e, done) { chunks.push(String(chunk)); done(); } }),
      text: () => chunks.join('') };
  };
  const out = capture();
  const err = capture();
  return {
    deps: {
      client: {} as AgentClientPort,
      inbox: async () => { throw new Error('unexpected inbox'); },
      stdin: new PassThrough(), stdout: out.stream, stderr: err.stream,
    },
    stdout: out.text,
    stderr: err.text,
  };
}

const command = (name: string, code = 0): CliCommand => ({ name, run: async () => code });

describe('command registry', () => {
  it('registers exactly the existing commands', () => {
    expect(commandRegistry.names()).toEqual(['connect', 'listen', 'read', 'send', 'status', 'mcp-serve', 'channels', 'agents', 'internal', 'codex-hook', 'claude']);
    for (const name of commandRegistry.names()) expect(commandRegistry.resolve(name)?.name).toBe(name);
  });

  it('rejects a duplicate command name instead of dropping or overriding it', () => {
    expect(() => createCommandRegistry([command('probe', 0), command('probe', 1)]))
      .toThrowError(CommandRegistryError);
    expect(() => createCommandRegistry([...CLI_COMMANDS, command('status')])).toThrow(/duplicate_command: status/);
  });

  it('rejects malformed names', () => {
    for (const name of ['', 'Status', '-x', 'a b', '__proto__']) {
      expect(() => createCommandRegistry([command(name)])).toThrow(/invalid_name/);
    }
  });

  it('resolves nothing for an unknown name, including inherited object keys', () => {
    for (const name of ['nope', 'constructor', 'toString', '__proto__', undefined]) {
      expect(commandRegistry.resolve(name)).toBeUndefined();
    }
  });

  it('fails an unknown command with invalid_arguments and exit 2', async () => {
    for (const name of ['nope', 'constructor', '']) {
      const io = deps();
      expect(await runCli([name], io.deps)).toBe(2);
      expect(JSON.parse(io.stderr())).toEqual({ ok: false, error: 'invalid_arguments' });
      expect(io.stdout()).toBe('');
    }
  });

  it('adds a command with one new definition and one registry entry', async () => {
    const seen: string[][] = [];
    const extra: CliCommand = { name: 'probe', run: async args => { seen.push([...args]); return 7; } };
    const registry = createCommandRegistry([...CLI_COMMANDS, extra]);

    expect(registry.names()).toEqual([...commandRegistry.names(), 'probe']);
    expect(await runCli(['probe', '--x'], deps().deps, registry)).toBe(7);
    expect(seen).toEqual([['--x']]);
    // Without the registry line the same argv is refused.
    expect(await runCli(['probe'], deps().deps)).toBe(2);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { runInstall } from './main';

describe('print-only MCP install', () => {
  it.each(['generic', 'cline'])('prints valid JSON and raw command for %s without installing', async harness => {
    const stdout = vi.fn(), stderr = vi.fn(), npmInstall = vi.fn();
    const flags = harness === 'generic' ? [] : ['--harness', harness];
    expect(await runInstall(['mcp', '--print', ...flags], { stdout, stderr, npmInstall, package: undefined })).toBe(0);
    expect(JSON.parse(stdout.mock.calls[0]![0])).toEqual({ mcpServers: { khala: {
      command: 'npx', args: ['-y', 'khala-cli', 'mcp', '--harness', harness],
    } } });
    expect(stdout.mock.calls[1]![0]).toBe(`npx -y khala-cli mcp --harness ${harness}`);
    expect(stderr).not.toHaveBeenCalled();
    expect(npmInstall).not.toHaveBeenCalled();
  });
  it.each([[], ['--harness', 'cline'], ['--print', '--harness'], ['--print', '--harness', '../bad'],
    ['--print', '--uninstall'], ['--print', '--print']])('rejects invalid arguments %j', async (...flags) => {
    const stdout = vi.fn(), stderr = vi.fn();
    expect(await runInstall(['mcp', ...flags], { stdout, stderr })).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith('usage: khala install mcp --print [--harness <id>]');
  });
});

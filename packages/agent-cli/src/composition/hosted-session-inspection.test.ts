import { describe, expect, it, vi } from 'vitest';
import { codexMcpSessionInspection } from './hosted-session-inspection.js';

const SESSION = { harness: 'codex', sessionId: '01a0b66b-ce0c-7ee3-823e-14ecdb9f2856' };
const CLAIM = { ...SESSION, workdir: '/tmp/existing-session' };

describe('installed Codex MCP session inspection', () => {
  it('admits only the provider-named thread with exact proven version and durable generation', async () => {
    const generation = vi.fn(async () => 3);
    const inspect = codexMcpSessionInspection({ session: SESSION, workdir: CLAIM.workdir,
      readVersion: async () => '0.154.0', generation });
    expect(await inspect.inspect(CLAIM)).toMatchObject({
      kind: 'verified', session: { ...SESSION, generation: 3 },
      capabilities: { existingSession: 'native_cli_queue', immediateNotification: 'native_cli_queue' },
    });
    expect(await inspect.inspect({ ...CLAIM, sessionId: 'another-thread' })).toEqual({ kind: 'missing' });
    expect(await inspect.inspect({ ...CLAIM, workdir: '/tmp/other-workdir' })).toEqual({ kind: 'missing' });
    expect(generation).toHaveBeenCalledOnce();
  });

  it('fails closed for an unproven install or missing generation', async () => {
    const input = { session: SESSION, workdir: CLAIM.workdir, generation: async () => 0 };
    expect(await codexMcpSessionInspection({ ...input, readVersion: async () => '0.155.0' }).inspect(CLAIM))
      .toEqual({ kind: 'unsupported' });
    expect(await codexMcpSessionInspection({ ...input, readVersion: async () => null }).inspect(CLAIM))
      .toEqual({ kind: 'unsupported' });
    expect(await codexMcpSessionInspection({ ...input, readVersion: async () => '0.154.0', generation: async () => null }).inspect(CLAIM))
      .toEqual({ kind: 'unavailable' });
  });
});

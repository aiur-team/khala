import { describe, expect, it, vi } from 'vitest';
import { claudeProofKeyLabelInspection, codexMcpSessionInspection } from './hosted-session-inspection.js';

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
    expect(await codexMcpSessionInspection({ ...input, readVersion: async () => '0.157.1' }).inspect(CLAIM))
      .toMatchObject({ kind: 'verified', capabilities: { version: '0.157.1', existingSession: 'native_cli_queue' } });
    expect(await codexMcpSessionInspection({ ...input, readVersion: async () => '0.157.0' }).inspect(CLAIM))
      .toEqual({ kind: 'unsupported' });
    expect(await codexMcpSessionInspection({ ...input, readVersion: async () => '0.155.0' }).inspect(CLAIM))
      .toEqual({ kind: 'unsupported' });
    expect(await codexMcpSessionInspection({ ...input, readVersion: async () => null }).inspect(CLAIM))
      .toEqual({ kind: 'unsupported' });
    expect(await codexMcpSessionInspection({ ...input, readVersion: async () => '0.154.0', generation: async () => null }).inspect(CLAIM))
      .toEqual({ kind: 'unavailable' });
  });

  it('accepts 0.159.2 only as an exact-session request label with unsupported delivery', async () => {
    const inspect = codexMcpSessionInspection({ session: SESSION, workdir: CLAIM.workdir,
      readVersion: async () => '0.159.2', generation: async () => 3 });
    expect(await inspect.inspect(CLAIM)).toMatchObject({ kind: 'verified',
      session: { ...SESSION, generation: 3 },
      capabilities: { support: 'unsupported', existingSession: 'unknown', immediateNotification: 'unknown' } });
    expect(await inspect.inspect({ ...CLAIM, sessionId: 'another-thread' })).toEqual({ kind: 'missing' });
  });
});

describe('installed Claude proof-key label inspection', () => {
  it.each(['2.1.284', '2.1.285'])('accepts the current exact session on %s as experimental', async version => {
    const inspect = claudeProofKeyLabelInspection({ session: { harness: 'claude', sessionId: 'claude-session' },
      workdir: CLAIM.workdir, readVersion: async () => version });
    expect(await inspect.inspect({ harness: 'claude', sessionId: 'claude-session', workdir: CLAIM.workdir }))
      .toMatchObject({ kind: 'verified', capabilities: { version, support: 'experimental' } });
  });
});

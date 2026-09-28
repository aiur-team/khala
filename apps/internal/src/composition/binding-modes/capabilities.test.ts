import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import { describe, expect, it } from 'vitest';
import { openChannelStore } from '../../store/open';
import { createServerHarnessCapabilities } from './capabilities';

const binding = (harness: string, generation = 1) => ({
  v: 1, bindingId: `binding-${harness}`, ownerId: 'owner', agentParticipantId: 'agent', deviceId: 'device',
  harness, sessionId: 'session-digest', generation,
}) as SessionBinding;

describe('server harness capabilities', () => {
  it('projects the bound agent runtime and revalidates the same runtime after restart', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-codex-agent-runtime-'));
    const codex = binding('codex');
    let handle = openChannelStore({ directory, mode: 'create' });
    try {
      const first = createServerHarnessCapabilities(undefined, { handle });
      first.observe(codex, { version: '0.157.1', hookReview: 'trusted' });
      expect(first.capabilities(codex)?.modes.sync.status).toBe('unknown');
      first.observe(codex, { version: '0.157.1', hookReview: 'trusted', platform: 'darwin', arch: 'x64' });
      expect(first.capabilities(codex)?.modes.sync.status).toBe('unknown');
      first.observe(codex, { version: '0.157.1', hookReview: 'trusted', platform: 'linux', arch: 'x64' });
      expect(first.capabilities(codex)?.modes.sync.status).toBe('proven');
      handle.close();
      handle = openChannelStore({ directory, mode: 'existing' });
      let current = { version: '0.157.1', hookReview: 'trusted' as const, platform: 'linux', arch: 'arm64' };
      const restarted = createServerHarnessCapabilities(undefined, { handle, inspectCodex: async () => current });
      expect(restarted.capabilities(codex)).toBeNull();
      expect(await restarted.revalidateCodex(codex)).toBe(false);
      current = { ...current, arch: 'x64' };
      expect(await restarted.revalidateCodex(codex)).toBe(true);
      expect(restarted.capabilities(codex)?.modes.sync.status).toBe('proven');
      expect(restarted.capabilities({ ...codex, generation: 2 })).toBeNull();
    } finally {
      handle.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('claims nothing for OpenCode until its plugin reports a version', () => {
    expect(createServerHarnessCapabilities().capabilities(binding('opencode'))).toBeNull();
  });

  it('classifies OpenCode by the reported version: proven only for the exact tested one', () => {
    const harnesses = createServerHarnessCapabilities();
    harnesses.observe(binding('opencode'), { version: '1.17.10', hookReview: 'unknown' });
    expect(harnesses.capabilities(binding('opencode'))?.modes.sync.status).toBe('proven');
    harnesses.observe(binding('opencode'), { version: '1.18.2', hookReview: 'unknown' });
    expect(harnesses.capabilities(binding('opencode'))).toMatchObject({
      support: 'experimental',
      modes: { steer: { status: 'experimental' }, sync: { status: 'experimental' }, async: { status: 'experimental' } },
    });
    // An observation belongs to one binding generation.
    expect(harnesses.capabilities(binding('opencode', 2))).toBeNull();
  });
});

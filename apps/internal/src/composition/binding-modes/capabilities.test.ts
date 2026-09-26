import type { SessionBinding } from '@khala/contracts/delivery/index';
import { describe, expect, it } from 'vitest';
import { createServerHarnessCapabilities } from './capabilities';

const binding = (harness: string, generation = 1) => ({
  v: 1, bindingId: `binding-${harness}`, ownerId: 'owner', agentParticipantId: 'agent', deviceId: 'device',
  harness, sessionId: 'session-digest', generation,
}) as SessionBinding;

describe('server harness capabilities', () => {
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

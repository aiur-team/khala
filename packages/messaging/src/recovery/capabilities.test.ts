import type { OwnerId } from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { projectCapabilities, type RecoveryIdentity, type RecoverySession } from './capabilities';

const alice = 'owner_alice' as OwnerId;

function identity(session: RecoverySession, fail = false): RecoveryIdentity {
  return { async current() { if (fail) throw new Error('identity unavailable'); return session; } };
}

describe('no-recovery capability projection', () => {
  it('exposes no recovery mode to a signed-in owner', async () => {
    const projected = await projectCapabilities(
      alice,
      identity({ kind: 'signed_in', ownerId: alice }),
    );
    expect(projected.capabilities).toEqual({ modes: [], unavailableReason: 'unsupported_substrate' });
  });

  it('does not turn OAuth login for another owner into message-key recovery', async () => {
    const projected = await projectCapabilities(
      alice,
      identity({ kind: 'signed_in', ownerId: 'owner_bob' as OwnerId }),
    );
    expect(projected.capabilities).toEqual({ modes: [], unavailableReason: 'device_not_ready' });
  });

  it('keeps signed-out and unavailable identity states explicit', async () => {
    await expect(projectCapabilities(alice, identity({ kind: 'signed_out' })))
      .resolves.toMatchObject({ capabilities: { modes: [], unavailableReason: 'signed_out' } });
    await expect(projectCapabilities(alice, identity({ kind: 'unavailable' }, true)))
      .resolves.toMatchObject({ capabilities: { modes: [], unavailableReason: 'device_not_ready' } });
  });
});

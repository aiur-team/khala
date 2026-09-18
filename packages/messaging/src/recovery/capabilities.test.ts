import type { OwnerId } from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { projectCapabilities, type RecoveryIdentity, type RecoverySession } from './capabilities';

const alice = 'owner_alice' as OwnerId;
const approved = [{ id: 'trusted-device-transfer', version: 'matrix-js-sdk/42.4.0' }];

function identity(session: RecoverySession): RecoveryIdentity {
  return { async current() { return session; }, observe() { return () => undefined; } };
}

describe('recovery capability projection', () => {
  it('reports the approved no-recovery policy without fabricating a mode', async () => {
    const substrate = { async capabilities() { return { kind: 'ready' as const, modes: ['server-backup'] }; } };
    const result = await projectCapabilities(alice, [], identity({ kind: 'signed_in', ownerId: alice, generation: 1 }), substrate);
    expect(result.capabilities).toEqual({ modes: [], unavailableReason: 'not_configured' });
  });

  it('does not turn OAuth login into message-key recovery', async () => {
    const substrate = { async capabilities() { return { kind: 'ready' as const, modes: ['trusted-device-transfer'] }; } };
    const result = await projectCapabilities(alice, approved, identity({ kind: 'signed_out' }), substrate);
    expect(result.capabilities).toEqual({ modes: [], unavailableReason: 'signed_out' });
  });

  it('intersects reviewed modes with modes proven by the endpoint SDK', async () => {
    const substrate = {
      async capabilities() { return { kind: 'ready' as const, modes: ['server-backup', 'trusted-device-transfer'] }; },
    };
    const result = await projectCapabilities(
      alice, approved, identity({ kind: 'signed_in', ownerId: alice, generation: 4 }), substrate,
    );
    expect(result.capabilities).toEqual({ modes: ['trusted-device-transfer'], unavailableReason: null });
  });

  it('does not expose capabilities from another signed-in owner', async () => {
    const substrate = { async capabilities() { return { kind: 'ready' as const, modes: ['trusted-device-transfer'] }; } };
    const result = await projectCapabilities(
      alice, approved, identity({ kind: 'signed_in', ownerId: 'owner_bob' as OwnerId, generation: 1 }), substrate,
    );
    expect(result.capabilities).toEqual({ modes: [], unavailableReason: 'device_not_ready' });
  });
});

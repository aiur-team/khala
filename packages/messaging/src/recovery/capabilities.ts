import type { CallOptions, OwnerId, RecoveryCapabilities } from '@khala/contracts/messaging/index';

export type RecoverySession =
  | Readonly<{ kind: 'signed_in'; ownerId: OwnerId; generation: number }>
  | Readonly<{ kind: 'signed_out' }>
  | Readonly<{ kind: 'unavailable' }>;

export interface RecoveryIdentity {
  current(options?: CallOptions): Promise<RecoverySession>;
}

export type CapabilityProjection = Readonly<{
  session: RecoverySession;
  capabilities: RecoveryCapabilities;
}>;

/** P14 allows fresh-device re-admission only. It approves no old-history recovery mode. */
export async function projectCapabilities(
  ownerId: OwnerId,
  identity: RecoveryIdentity,
  options?: CallOptions,
): Promise<CapabilityProjection> {
  let session: RecoverySession;
  try {
    session = await identity.current(options);
  } catch {
    session = { kind: 'unavailable' };
  }
  if (session.kind === 'signed_out') return { session, capabilities: { modes: [], unavailableReason: 'signed_out' } };
  if (session.kind !== 'signed_in' || session.ownerId !== ownerId) {
    return { session, capabilities: { modes: [], unavailableReason: 'device_not_ready' } };
  }
  return { session, capabilities: { modes: [], unavailableReason: 'not_configured' } };
}

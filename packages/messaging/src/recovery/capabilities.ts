import type {
  CallOptions, Disposer, OwnerId, RecoveryCapabilities, RecoveryUnavailableReason,
} from '@khala/contracts/messaging/index';

export type RecoverySession =
  | Readonly<{ kind: 'signed_in'; ownerId: OwnerId; generation: number }>
  | Readonly<{ kind: 'signed_out' }>
  | Readonly<{ kind: 'unavailable' }>;

export interface RecoveryIdentity {
  current(options?: CallOptions): Promise<RecoverySession>;
  /** Emits account lifecycle changes synchronously before a replacement may mutate crypto state. */
  observe(listener: (session: RecoverySession) => void): Disposer;
}

export type SubstrateCapabilities =
  | Readonly<{ kind: 'ready'; modes: readonly string[] }>
  | Readonly<{ kind: 'unavailable'; reason: RecoveryUnavailableReason }>;

export interface RecoveryCapabilitySource {
  capabilities(options?: CallOptions): Promise<SubstrateCapabilities>;
}

export type ApprovedRecoveryMode = Readonly<{
  id: string;
  /** Exact SDK backup/transfer format this application has reviewed. */
  version: string;
}>;

export type CapabilityProjection = Readonly<{
  session: RecoverySession;
  capabilities: RecoveryCapabilities;
}>;

const unavailable = (reason: RecoveryUnavailableReason): RecoveryCapabilities => ({ modes: [], unavailableReason: reason });

/** Projects only explicitly approved modes that the endpoint SDK currently reports. */
export async function projectCapabilities(
  ownerId: OwnerId,
  approvedModes: readonly ApprovedRecoveryMode[],
  identity: RecoveryIdentity,
  substrate: RecoveryCapabilitySource,
  options?: CallOptions,
): Promise<CapabilityProjection> {
  let session: RecoverySession;
  try {
    session = await identity.current(options);
  } catch {
    session = { kind: 'unavailable' };
  }
  if (session.kind === 'signed_out') return { session, capabilities: unavailable('signed_out') };
  if (session.kind !== 'signed_in' || session.ownerId !== ownerId) {
    return { session, capabilities: unavailable('device_not_ready') };
  }
  if (approvedModes.length === 0) return { session, capabilities: unavailable('not_configured') };

  let sdk: SubstrateCapabilities;
  try {
    sdk = await substrate.capabilities(options);
  } catch {
    return { session, capabilities: unavailable('device_not_ready') };
  }
  if (sdk.kind === 'unavailable') return { session, capabilities: unavailable(sdk.reason) };
  const supported = new Set(sdk.modes);
  const modes = approvedModes.map(mode => mode.id).filter(mode => supported.has(mode));
  return {
    session,
    capabilities: modes.length === 0 ? unavailable('unsupported_substrate') : { modes, unavailableReason: null },
  };
}

export function sameSession(left: RecoverySession, right: RecoverySession): boolean {
  return left.kind === 'signed_in' && right.kind === 'signed_in'
    && left.ownerId === right.ownerId && left.generation === right.generation;
}

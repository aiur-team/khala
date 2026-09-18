// Key recovery. Supported modes are substrate capabilities, not defaults chosen
// here, and no recovery promise is implied. Secrets travel only through a local
// callback; no serialisable request, status or control value carries them.

import { type Decoded, array, decodeWith, elementPath, fail, identifier, literal, nullable, object } from './decode';
import type { CallOptions, OperationResult } from './outcomes';

export const RECOVERY_UNAVAILABLE_REASONS = ['not_configured', 'unsupported_substrate', 'device_not_ready', 'signed_out'] as const;
export type RecoveryUnavailableReason = (typeof RECOVERY_UNAVAILABLE_REASONS)[number];

export const RECOVERY_FAILURE_REASONS = ['secret_rejected', 'backup_missing', 'backup_corrupt', 'storage_unavailable', 'cancelled_locally'] as const;
export type RecoveryFailureReason = (typeof RECOVERY_FAILURE_REASONS)[number];

/** Modes are opaque capability identifiers declared by the selected substrate. */
export type RecoveryCapabilities = Readonly<{
  modes: readonly string[];
  unavailableReason: RecoveryUnavailableReason | null;
}>;

export type RecoveryState = 'locked' | 'restoring' | 'restored' | 'partial' | 'unrecoverable' | 'failed';

export type RecoveryStatus = Readonly<{
  operationId: string;
  mode: string;
  state: RecoveryState;
  reason: RecoveryFailureReason | null;
}>;

/**
 * Local-only secret prompt, invoked in the endpoint that holds the keys. Returns
 * the secret bytes, or `null` when the human declines. The port must not persist,
 * log or forward the bytes, and should zero them after use.
 */
export type ProvideRecoverySecret = (prompt: Readonly<{ operationId: string; mode: string; attempt: number }>) => Promise<Uint8Array | null>;

export type RecoveryRejection = 'unsupported_mode' | 'device_not_ready' | 'operation_mismatch';

export interface RecoveryPort {
  capabilities(options?: CallOptions): Promise<RecoveryCapabilities>;
  begin(
    input: Readonly<{ operationId: string; mode: string }>,
    provideSecret: ProvideRecoverySecret,
    options?: CallOptions,
  ): Promise<OperationResult<RecoveryStatus, RecoveryRejection>>;
  inspect(operationId: string, options?: CallOptions): Promise<OperationResult<RecoveryStatus, 'not_found'>>;
}

export function decodeRecoveryCapabilities(input: unknown): Decoded<RecoveryCapabilities> {
  return decodeWith(() => {
    const r = object(input, '', ['modes', 'unavailableReason']);
    const modes = array(r.field('modes'), r.at('modes')).map((mode, index) => identifier(mode, elementPath(r.at('modes'), index)));
    const unavailableReason = nullable(r.field('unavailableReason'), value => literal(value, r.at('unavailableReason'), RECOVERY_UNAVAILABLE_REASONS));
    if ((modes.length === 0) !== (unavailableReason !== null)) fail(r.at('unavailableReason'), 'mismatch');
    return { modes, unavailableReason };
  });
}

export function decodeRecoveryStatus(input: unknown): Decoded<RecoveryStatus> {
  return decodeWith(() => {
    const r = object(input, '', ['operationId', 'mode', 'state', 'reason']);
    const status: RecoveryStatus = {
      operationId: identifier(r.field('operationId'), r.at('operationId')),
      mode: identifier(r.field('mode'), r.at('mode')),
      state: literal(r.field('state'), r.at('state'), ['locked', 'restoring', 'restored', 'partial', 'unrecoverable', 'failed']),
      reason: nullable(r.field('reason'), value => literal(value, r.at('reason'), RECOVERY_FAILURE_REASONS)),
    };
    if ((status.state === 'failed' || status.state === 'unrecoverable') !== (status.reason !== null)) fail(r.at('reason'), 'mismatch');
    return status;
  });
}

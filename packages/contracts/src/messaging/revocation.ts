// Revocation of a device or an agent session binding. Revocation is guarded by the
// target's expected generation so a stale request cannot revoke its replacement.

import { type Decoded, type Reader, decodeWith, identifier, literal, object, safeInteger } from './decode';
import { type BindingId, type DeviceId, readId } from './ids';
import type { CallOptions, OperationResult } from './outcomes';

export type RevocationTarget = 'device' | 'binding';

/** The target ID's brand follows its kind, so a binding ID cannot name a device. */
export type RevocationSubject =
  | Readonly<{ targetKind: 'device'; targetId: DeviceId }>
  | Readonly<{ targetKind: 'binding'; targetId: BindingId }>;

/**
 * `expectedGeneration` is the target's current generation: `DeviceView.generation`
 * for a device, `SessionBinding.generation` for a binding.
 */
export type RevocationRequest = RevocationSubject & Readonly<{
  operationId: string;
  expectedGeneration: number;
}>;

/**
 * `partial` means some effects landed and others did not; it is not complete and
 * must stay visible until resolved.
 */
export type RevocationProgress = RevocationSubject & Readonly<{
  operationId: string;
  /** Generation the target moves to once revoked. */
  generation: number;
  state: 'pending' | 'propagating' | 'complete' | 'partial';
}>;

export type RevocationRejection = 'stale_generation' | 'not_found' | 'forbidden' | 'operation_mismatch';

export interface RevocationPort {
  revoke(input: RevocationRequest, options?: CallOptions): Promise<OperationResult<RevocationProgress, RevocationRejection>>;
  inspect(operationId: string, options?: CallOptions): Promise<OperationResult<RevocationProgress, 'not_found'>>;
}

function readSubject(r: Reader): RevocationSubject {
  const targetKind = literal(r.field('targetKind'), r.at('targetKind'), ['device', 'binding']);
  return targetKind === 'device'
    ? { targetKind, targetId: readId<'DeviceId'>(r.field('targetId'), r.at('targetId')) }
    : { targetKind, targetId: readId<'BindingId'>(r.field('targetId'), r.at('targetId')) };
}

export function decodeRevocationRequest(input: unknown): Decoded<RevocationRequest> {
  return decodeWith(() => {
    const r = object(input, '', ['operationId', 'targetKind', 'targetId', 'expectedGeneration']);
    const operationId = identifier(r.field('operationId'), r.at('operationId'));
    return {
      operationId,
      ...readSubject(r),
      expectedGeneration: safeInteger(r.field('expectedGeneration'), r.at('expectedGeneration')),
    };
  });
}

export function decodeRevocationProgress(input: unknown): Decoded<RevocationProgress> {
  return decodeWith(() => {
    const r = object(input, '', ['operationId', 'targetKind', 'targetId', 'generation', 'state']);
    const operationId = identifier(r.field('operationId'), r.at('operationId'));
    return {
      operationId,
      ...readSubject(r),
      generation: safeInteger(r.field('generation'), r.at('generation')),
      state: literal(r.field('state'), r.at('state'), ['pending', 'propagating', 'complete', 'partial']),
    };
  });
}

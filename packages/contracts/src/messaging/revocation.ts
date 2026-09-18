// Revocation of a device or an agent session binding. Revocation is guarded by the
// target's expected generation so a stale request cannot revoke its replacement.

import { type Decoded, decodeWith, identifier, literal, object, safeInteger } from './decode';
import type { CallOptions, OperationResult } from './outcomes';

export type RevocationTarget = 'device' | 'binding';

export type RevocationRequest = Readonly<{
  operationId: string;
  targetKind: RevocationTarget;
  targetId: string;
  expectedGeneration: number;
}>;

/**
 * `partial` means some effects landed and others did not; it is not complete and
 * must stay visible until resolved.
 */
export type RevocationProgress = Readonly<{
  operationId: string;
  targetKind: RevocationTarget;
  targetId: string;
  /** Generation the target moves to once revoked. */
  generation: number;
  state: 'pending' | 'propagating' | 'complete' | 'partial';
}>;

export type RevocationRejection = 'stale_generation' | 'not_found' | 'forbidden' | 'operation_mismatch';

export interface RevocationPort {
  revoke(input: RevocationRequest, options?: CallOptions): Promise<OperationResult<RevocationProgress, RevocationRejection>>;
  inspect(operationId: string, options?: CallOptions): Promise<OperationResult<RevocationProgress, 'not_found'>>;
}

export function decodeRevocationRequest(input: unknown): Decoded<RevocationRequest> {
  return decodeWith(() => {
    const r = object(input, '', ['operationId', 'targetKind', 'targetId', 'expectedGeneration']);
    return {
      operationId: identifier(r.field('operationId'), r.at('operationId')),
      targetKind: literal(r.field('targetKind'), r.at('targetKind'), ['device', 'binding']),
      targetId: identifier(r.field('targetId'), r.at('targetId')),
      expectedGeneration: safeInteger(r.field('expectedGeneration'), r.at('expectedGeneration')),
    };
  });
}

export function decodeRevocationProgress(input: unknown): Decoded<RevocationProgress> {
  return decodeWith(() => {
    const r = object(input, '', ['operationId', 'targetKind', 'targetId', 'generation', 'state']);
    return {
      operationId: identifier(r.field('operationId'), r.at('operationId')),
      targetKind: literal(r.field('targetKind'), r.at('targetKind'), ['device', 'binding']),
      targetId: identifier(r.field('targetId'), r.at('targetId')),
      generation: safeInteger(r.field('generation'), r.at('generation')),
      state: literal(r.field('state'), r.at('state'), ['pending', 'propagating', 'complete', 'partial']),
    };
  });
}

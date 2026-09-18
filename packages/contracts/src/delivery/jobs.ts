// A release binds exact ordered event references to one immutable recipient
// generation and policy revision. Payload bytes are encoded by KHA-119, not here.

import { type SessionBinding, readSessionBinding } from './binding';
import { type Decoded, type DeliveryLimits, decodeWith, fail, identifier, object, safeInteger, version } from './decode';
import { type EventRef, readEventSelection, readSha256Digest } from './events';
import { type CausalRootId, type ReleaseId, readId } from './ids';

export type ReleasedJob = Readonly<{
  v: 1;
  releaseId: ReleaseId;
  binding: SessionBinding;
  policyVersion: number;
  events: readonly EventRef[];
  /** Opaque owner-local ledger handle, never a transferable fetch credential. */
  payloadRef: string;
  /** Digest of the exact ordered release payload bytes. */
  payloadDigest: string;
  causalRootId: CausalRootId;
}>;

export function decodeReleasedJob(input: unknown, limits: DeliveryLimits): Decoded<ReleasedJob> {
  return decodeWith(() => readReleasedJob(input, '', limits));
}

export function readReleasedJob(input: unknown, field: string, limits: DeliveryLimits): ReleasedJob {
  const reader = object(input, field, [
    'v', 'releaseId', 'binding', 'policyVersion', 'events', 'payloadRef', 'payloadDigest', 'causalRootId',
  ]);
  return {
    v: version(reader.field('v'), reader.at('v')),
    releaseId: readId<'ReleaseId'>(reader.field('releaseId'), reader.at('releaseId')),
    binding: readSessionBinding(reader.field('binding'), reader.at('binding')),
    policyVersion: safeInteger(reader.field('policyVersion'), reader.at('policyVersion')),
    events: readEventSelection(reader.field('events'), reader.at('events'), limits),
    payloadRef: identifier(reader.field('payloadRef'), reader.at('payloadRef')),
    payloadDigest: readSha256Digest(reader.field('payloadDigest'), reader.at('payloadDigest')),
    causalRootId: readId<'CausalRootId'>(reader.field('causalRootId'), reader.at('causalRootId')),
  };
}

/**
 * Applies the configured byte limit before an adapter receives release payload
 * bytes. Digest verification belongs to KHA-121 because KHA-119 owns the future
 * canonical envelope codec.
 */
export function validatePayloadBytes(input: unknown, limits: DeliveryLimits): Decoded<Uint8Array> {
  return decodeWith(() => {
    if (!(input instanceof Uint8Array)) fail('payload', 'invalid_field');
    if (input.byteLength > limits.maxPayloadBytes) fail('payload', 'limit_exceeded');
    return input;
  });
}

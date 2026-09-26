import { createHash } from 'node:crypto';
import type { ReleaseId } from '@khala/contracts/delivery/index';

const RELEASE_ID_DOMAIN = 'khala.internal.release.v1';

/**
 * The internal release ID: deterministic per binding generation and event, never random
 * or time-derived. The release feed mints it and the acknowledgement ledger recomputes it,
 * so a release can be acknowledged only by the binding generation it was made for.
 */
export function internalReleaseId(binding: Readonly<{ bindingId: string; generation: number }>, eventId: string): ReleaseId {
  const digest = createHash('sha256')
    .update(JSON.stringify([RELEASE_ID_DOMAIN, binding.bindingId, binding.generation, eventId]))
    .digest('base64url');
  return `rel_${digest}` as ReleaseId;
}

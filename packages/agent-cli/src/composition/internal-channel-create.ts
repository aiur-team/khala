// Projects the internal discovery client's create routes onto the create port.
// The descriptor selects the running local service, so an explicit `--origin`
// is refused rather than followed; the descriptor never reaches the model.

import type { AccessRefusalCode, ChannelAccessResult } from '../cli/channels/types.js';
import type { ChannelCreatePort } from '../cli/channels/create/types.js';
import type { InternalDiscoveryCallResult, InternalDiscoveryClient } from './internal-discovery.js';

const STATUS_REFUSALS: ReadonlyMap<number, AccessRefusalCode> = new Map([
  [400, 'invalid_request'], [403, 'discovery_denied'], [404, 'not_found'], [409, 'operation_conflict'], [429, 'rate_limited'],
]);

function project(result: InternalDiscoveryCallResult): ChannelAccessResult {
  if (result.kind === 'ok') return { kind: 'status', status: result.body };
  if (result.kind === 'discovery_required') return { kind: 'refused', code: 'discovery_required' };
  if (result.kind === 'refused') {
    const code = STATUS_REFUSALS.get(result.status);
    if (code !== undefined) return { kind: 'refused', code };
  }
  return { kind: 'unavailable' };
}

export function createInternalChannelCreate(client: InternalDiscoveryClient): ChannelCreatePort {
  return {
    async requestChannelCreate(input, signal) {
      if (input.origin !== null) return { kind: 'refused', code: 'untrusted_origin' };
      return project(await client.requestCreate({ operationId: input.operationId, proposedTitle: input.title }, signal));
    },
    async channelCreateStatus(input, signal) {
      if (input.origin !== null) return { kind: 'refused', code: 'untrusted_origin' };
      return project(await client.status('create', input.operationId, signal));
    },
  };
}

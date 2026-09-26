// Live `ChannelAccessInboxPort` over the loopback server's human-cookie routes.
// Results stay `unknown`: the shared inbox controller decodes every projection
// through the contract decoders before rendering any of it.

import {
  ok, rejected, unavailable,
  type CallOptions, type ChannelAccessDecisionCommand, type ChannelAccessDecisionRejection, type ChannelAccessMuteCommand,
  type ChannelAccessMuteResult, type OperationResult,
} from '@khala/contracts/messaging/index';
import type { ChannelAccessInboxPort, InboxRejection, MuteRejection } from '../../features/channel-access/ports';
import { isRecord, rejectionCode, type HumanClient } from '../composition/human-client';

export const REQUESTS_PATH = '/api/human/channel-requests';
export const MUTE_PATH = '/api/human/channel-requests/mute';
const decisionPath = (kind: 'access' | 'create', handle: string) =>
  `/api/human/channel-${kind}-requests/${encodeURIComponent(handle)}/decision`;

const DECISION_REJECTIONS: ReadonlySet<string> = new Set<ChannelAccessDecisionRejection>([
  'forbidden', 'not_found', 'stale_revision', 'decision_conflict', 'expired', 'revoked', 'operation_mismatch',
]);
const MUTE_REJECTIONS: ReadonlySet<string> = new Set<MuteRejection>(['forbidden', 'not_found', 'stale_revision', 'operation_mismatch']);

function readMute(body: unknown): ChannelAccessMuteResult | null {
  if (!isRecord(body) || body.v !== 1 || typeof body.muted !== 'boolean' || typeof body.revision !== 'string') return null;
  if (body.operationKind !== 'access' && body.operationKind !== 'create') return null;
  return { v: 1, operationKind: body.operationKind, muted: body.muted, revision: body.revision };
}

export function createLocalChannelAccessPort(client: HumanClient): ChannelAccessInboxPort {
  // A decision route is chosen by operation kind, which only the inbox read tells us.
  const kinds = new Map<string, 'access' | 'create'>();

  return {
    async inbox(options?: CallOptions): Promise<OperationResult<readonly unknown[], InboxRejection>> {
      const reply = await client.get(REQUESTS_PATH, options?.signal);
      if (reply === 'auth_failed') return rejected('forbidden');
      if (reply === 'network') return unavailable();
      if (reply.status === 403) return rejected('forbidden');
      if (reply.status !== 200 || !isRecord(reply.body) || !Array.isArray(reply.body.requests)) return unavailable();
      kinds.clear();
      for (const request of reply.body.requests as unknown[]) {
        if (isRecord(request) && typeof request.requestHandle === 'string'
          && (request.operationKind === 'access' || request.operationKind === 'create')) {
          kinds.set(request.requestHandle, request.operationKind);
        }
      }
      return ok(reply.body.requests as readonly unknown[]);
    },

    async decide(input: ChannelAccessDecisionCommand, options?: CallOptions) {
      const kind = kinds.get(input.requestHandle);
      if (kind === undefined) return rejected('not_found');
      const reply = await client.post(decisionPath(kind, input.requestHandle), input, options?.signal);
      if (reply === 'auth_failed') return rejected('forbidden');
      if (reply === 'network') return unavailable();
      if (reply.status === 200) return ok(reply.body);
      const code = rejectionCode(reply.body);
      return code !== null && DECISION_REJECTIONS.has(code) ? rejected(code as ChannelAccessDecisionRejection) : unavailable();
    },

    async setMute(input: ChannelAccessMuteCommand, options?: CallOptions) {
      const reply = await client.post(MUTE_PATH, input, options?.signal);
      if (reply === 'auth_failed') return rejected('forbidden');
      if (reply === 'network') return unavailable();
      if (reply.status === 200) {
        const result = readMute(reply.body);
        return result === null ? unavailable() : ok(result);
      }
      const code = rejectionCode(reply.body);
      return code !== null && MUTE_REJECTIONS.has(code) ? rejected(code as MuteRejection) : unavailable();
    },

    // The loopback server has no notification stream; the composition polls
    // `refresh()` instead, and the inbox stays authoritative either way.
    subscribe: () => () => undefined,
  };
}

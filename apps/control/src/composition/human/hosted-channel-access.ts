import { createHash } from 'node:crypto';
import { decodeChannelAccessOwnerProjection } from '@khala/contracts/messaging/index';
import { createChannelAccessPolicy } from '@khala/messaging/channel-access/journal/policy';
import { projectOwner } from '@khala/messaging/channel-access/journal/service';
import { createChannelAccessStore } from '@khala/messaging/channel-access/journal/store';
import type { RouteRegistration } from '../../runtime/handler';
import { createProductionHumanRuntimeLoader, type ProductionHumanDependencies } from './production';

/** Owner inbox reads the durable journal using the same OIDC session and Blobs
 * namespace as the rest of hosted control. No agent authority is inferred here. */
export function createHostedChannelAccessInbox(dependencies: ProductionHumanDependencies): RouteRegistration {
  const runtime = createProductionHumanRuntimeLoader(dependencies);
  return Object.freeze({
    path: '/api/human/channel-access/inbox',
    methods: Object.freeze(['GET']),
    async handle(request: Request): Promise<Response> {
      try {
        const active = runtime();
        const authentication = await active.auth.authenticateRequest(request);
        if (authentication.kind === 'signed_out') return json(401, { v: 1, kind: 'rejected', code: 'signed_out' });
        if (authentication.kind !== 'authenticated') return unavailable();
        // The invitation secret is already required for hosted human runtime.
        // Domain separation keeps the journal's opaque indices independent.
        const key = createHash('sha256').update('khala.hosted.channel-access.policy.v1\0')
          .update(active.env.invitationHmacSecret).digest();
        const journal = createChannelAccessStore({
          store: active.store,
          policy: createChannelAccessPolicy({ key }),
          clock: active.clock,
        });
        const listed = await journal.listOwner({ ownerId: authentication.context.principal.ownerId });
        if (listed.kind !== 'found') return unavailable();
        const requests = [];
        for (const item of listed.requests) {
          const decoded = decodeChannelAccessOwnerProjection(projectOwner(item));
          if (!decoded.ok) return unavailable();
          requests.push(decoded.value);
        }
        return json(200, { v: 1, kind: 'ok', requests });
      } catch {
        return unavailable();
      }
    },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  } });
}

function unavailable(): Response {
  return json(503, { v: 1, kind: 'unavailable' });
}

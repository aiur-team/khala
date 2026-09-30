import { createHash } from 'node:crypto';
import { decodeChannelAccessOwnerProjection, decodeRoomId } from '@khala/contracts/messaging/index';
import { createChannelAccessPolicy } from '@khala/messaging/channel-access/journal/policy';
import { projectOwner, revokeConfirmed } from '@khala/messaging/channel-access/journal/service';
import { createChannelAccessStore, type ChannelAccessStoredContext } from '@khala/messaging/channel-access/journal/store';
import type { RouteRegistration } from '../../runtime/handler';
import { createProductionHumanRuntimeLoader, type ProductionHumanDependencies } from './production';
import { readHostedAccessTarget } from './hosted-channel-access-resolver';
import { createHostedChannelRequester } from './hosted-channel-requester';

/** Owner inbox reads the durable journal using the same OIDC session and Blobs
 * namespace as the rest of hosted control. No agent authority is inferred here. */
export function createHostedChannelAccessInbox(dependencies: ProductionHumanDependencies,
  reconcileCreate?: (requestHandle: string) => Promise<void>): RouteRegistration {
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
        const requesterAuthority = createHostedChannelRequester(active).requesterAuthority;
        async function reconcileStale(context: ChannelAccessStoredContext): Promise<boolean> {
          if (context.outcome !== 'pending_owner' && context.outcome !== 'approved') return true;
          return revokeConfirmed(journal, context, `hosted-inbox-${context.requestHandle}`);
        }
        const requests = [];
        for (const item of listed.requests) {
          const context = await journal.readContext({ requestHandle: item.requestHandle });
          if (context.kind !== 'found' || context.context.ownerId !== authentication.context.principal.ownerId) return unavailable();
          const held = context.context;
          if (held.detail.kind === 'create') {
            if (held.detail.ownerRevision !== held.sessionFingerprint) {
              if (!await reconcileStale(held)) return unavailable();
              continue;
            }
            const current = await requesterAuthority.inspectContext({
              v: 1, principal: held.requester as never, origin: held.origin,
              sessionGeneration: held.sessionGeneration,
              sessionFingerprint: held.sessionFingerprint,
              harness: held.harness, displayLabel: held.requesterLabel,
              workspaceLabel: held.workspaceLabel,
            }, authentication.context.principal.ownerId);
            if (current === 'unavailable') return unavailable();
            if (current === 'revoked') {
              if (!await reconcileStale(held)) return unavailable();
              continue;
            }
            if (held.outcome === 'approved' || held.outcome === 'connecting') {
              await reconcileCreate?.(held.requestHandle);
            }
            const latest = await journal.listOwner({ ownerId: authentication.context.principal.ownerId });
            if (latest.kind !== 'found') return unavailable();
            const refreshed = latest.requests.find(row => row.requestHandle === item.requestHandle);
            if (!refreshed) continue;
            const decoded = decodeChannelAccessOwnerProjection(projectOwner(refreshed));
            if (!decoded.ok) return unavailable();
            requests.push(decoded.value);
            continue;
          }
          // The personal link's sponsor may be a joined human other than the room creator.
          const ref = held.detail.authorizedChannelRef;
          const target = ref.startsWith('invitations.invite.') ? await readHostedAccessTarget(active, ref) : null;
          if (target === 'unavailable') return unavailable();
          // A revoked/expired personal link or departed sponsor can leave an
          // older journal row behind. Close it to release request capacity.
          if (ref.startsWith('invitations.invite.')
            && (target === null || target.ownerId !== authentication.context.principal.ownerId)) {
            if (!await reconcileStale(context.context)) return unavailable();
            continue;
          }
          if (ref.startsWith('invitations.invite.')) {
            const held = context.context;
            const current = await requesterAuthority.inspectContext({ v: 1,
              principal: held.requester as never, origin: held.origin,
              sessionGeneration: held.sessionGeneration, sessionFingerprint: held.sessionFingerprint,
              harness: held.harness, displayLabel: held.requesterLabel, workspaceLabel: held.workspaceLabel,
            }, authentication.context.principal.ownerId);
            if (current === 'unavailable') return unavailable();
            if (current === 'revoked') {
              if (!await reconcileStale(context.context)) return unavailable();
              continue;
            }
          }
          if (!ref.startsWith('invitations.invite.')) {
            const room = decodeRoomId(ref);
            if (!room.ok) {
              if (!await reconcileStale(context.context)) return unavailable();
              continue;
            }
            const authority = await active.matrix.inspectRoomAuthority(room.value);
            if (authority === null) return unavailable();
            if (authority !== authentication.context.principal.ownerId) {
              if (!await reconcileStale(context.context)) return unavailable();
              continue;
            }
            const membership = await active.matrix.inspectOwnerMembership(authority, room.value);
            if (membership.kind === 'unavailable') return unavailable();
            if (membership.kind !== 'joined') {
              if (!await reconcileStale(context.context)) return unavailable();
              continue;
            }
          }
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

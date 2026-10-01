import type { RouteRegistration } from '../runtime/handler';
import type { DiscoveryCredentialAuthorization } from '../channel-discovery/bootstrap/handler';
import { parseCredentialRef } from '../channel-discovery/bootstrap/store';
import { createDigests } from '../invitations/internal';
import { inviteFromShareLink } from '../invitations/link';
import { createProductionHumanRuntimeLoader, createProductionHumanServiceLoader, type ProductionHumanDependencies } from '../composition/human/production';
import { createHostedAccessRequestJournal } from '../composition/human/hosted-channel-access-routes';
import { readHostedAccessTarget } from '../composition/human/hosted-channel-access-resolver';
import { createHostedChannelRequester } from '../composition/human/hosted-channel-requester';
import { createChannelLinkHandlers, AGENT_CHANNEL_LINK_REQUEST_PATH,
  HUMAN_CHANNEL_LINK_PERSONAL_PATH, HUMAN_CHANNEL_LINK_RESOLVE_PATH } from './handler';

/** Human routes use the authenticated browser principal on each request. */
export function createHostedHumanChannelLinkRoutes(options: ProductionHumanDependencies): readonly RouteRegistration[] {
  const runtime = createProductionHumanRuntimeLoader(options);
  const loadServices = createProductionHumanServiceLoader(options);
  const route = (path: string): RouteRegistration => ({
    path, methods: ['POST'],
    async handle(request) {
      try {
        const active = runtime();
        const services = await loadServices(request);
        if (!services) throw new Error('human runtime unavailable');
        const handlers = createChannelLinkHandlers({
          origin: active.env.publicAppOrigin, store: active.store,
          secret: active.env.invitationHmacSecret, clock: active.clock,
          auth: active.auth, admissionFor: () => services.admission,
        });
        return handlers.human.find(item => item.path === path)!.handle(request);
      } catch {
        return new Response(JSON.stringify({ v: 1, kind: 'unavailable' }), { status: 503, headers: {
          'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        } });
      }
    },
  });
  return Object.freeze([route(HUMAN_CHANNEL_LINK_RESOLVE_PATH), route(HUMAN_CHANNEL_LINK_PERSONAL_PATH)]);
}

/** One request-scoped signed sponsor and journal; the URL supplies only the target. */
export function createHostedAgentChannelLinkRoutes(
  options: ProductionHumanDependencies,
  authorize: (request: Request, action: string) => Promise<DiscoveryCredentialAuthorization>,
): readonly RouteRegistration[] {
  const runtime = createProductionHumanRuntimeLoader(options);
  return Object.freeze([{ path: AGENT_CHANNEL_LINK_REQUEST_PATH, methods: ['POST'],
    async handle(request: Request) {
      try {
        const active = runtime();
        const authority = createHostedChannelRequester(active, authorize);
        const digests = createDigests(active.env.invitationHmacSecret);
        const journal = createHostedAccessRequestJournal(active, authority.requesterAuthority);
        const handlers = createChannelLinkHandlers({
          origin: active.env.publicAppOrigin, store: active.store,
          secret: active.env.invitationHmacSecret, clock: active.clock,
          agent: {
            async authenticate(current) {
              const verified = await authority.authenticateSponsor(current);
              if (verified.kind !== 'authenticated') return verified;
              const token = current.headers.get('authorization')?.match(/^DPoP (.+)$/u)?.[1];
              if (!token || !parseCredentialRef(token)) return { kind: 'rejected', code: 'auth_required' };
              return { ...verified, credentialRef: token };
            },
            inspectMembership: (ownerId, roomId) => active.matrix.inspectOwnerMembership(ownerId, roomId),
            inspectRequester: (context, sponsorOwnerId) => authority.requesterAuthority.inspectContext(context, sponsorOwnerId),
            async submitAccess(input) {
              const inviteRef = inviteFromShareLink(new URL(input.channelUrl), active.env.publicAppOrigin);
              const target = inviteRef === null ? null
                : await readHostedAccessTarget(active, digests.inviteKey(inviteRef));
              if (inviteRef === null || !target || target === 'unavailable'
                || target.inviteRefDigest !== digests.inviteRef(inviteRef)
                || target.revision !== input.inviteRevision || target.roomId !== input.roomId
                || target.ownerId !== input.sponsorOwnerId) {
                return { v: 1, operationId: input.operationId, outcome: 'unavailable' };
              }
              return journal.requestAccess({ v: 1, kind: 'channel_url', operationId: input.operationId,
                credentialRef: input.credentialRef, channelUrl: input.channelUrl }, input.requester, input.context);
            },
          },
        });
        return handlers.agent[0]!.handle(request);
      } catch {
        return new Response(JSON.stringify({ v: 1, kind: 'unavailable' }), { status: 503, headers: {
          'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        } });
      }
    },
  }]);
}

import { createGrantExchangeAuthority } from '@khala/messaging/channel-access/exchange/authority';
import { createExchangeGrantIssuer } from '@khala/messaging/channel-access/exchange/grants';
import { exchangeJournal } from '@khala/messaging/channel-access/exchange/journal';
import type { ChannelAccessStore } from '@khala/messaging/channel-access/journal/store';
import type { ChannelAccessFulfillmentPort } from '@khala/contracts/messaging/index';
import type { PairingGrantPort } from '../../pairing/store';
import { readHostedAccessTarget } from '../human/hosted-channel-access-resolver';
import type { HostedAdmissionAuthority } from './hosted-channel-admission';
import type { ProductionHumanRuntime } from '../human/production';
import { findChannelAccessBinding, recordChannelAccessBinding, reserveChannelAccessIssuance } from './channel-access-binding';

/** The bootstrap redeem route accepts a channel grant only after an exact
 * approved exchange, signed connector key, device, session and live sponsor
 * have all been rechecked against durable state. */
export function createHostedChannelGrantPort(deps: Readonly<{
  active: ProductionHumanRuntime;
  journal: Pick<ChannelAccessStore, 'inspectRequester'>;
  fulfillment: Pick<ChannelAccessFulfillmentPort, 'claimAccess' | 'updateAccess'>;
  admissionAuthority: HostedAdmissionAuthority;
}>): PairingGrantPort {
  const { active } = deps;
  const issuer = createExchangeGrantIssuer({ store: active.store, clock: active.clock });
  const exchanges = exchangeJournal(active.store);
  const authority = createGrantExchangeAuthority({ store: deps.journal, fulfillment: deps.fulfillment, clock: active.clock });

  return {
    async redeem(input) {
      const inspected = await issuer.inspect(input.grant);
      if (inspected.kind === 'unavailable') return { kind: 'unavailable' };
      if (inspected.kind !== 'found') return { kind: 'invalid_grant' };
      const binding = inspected.binding;
      if (binding.origin !== active.env.publicAppOrigin || binding.operationId !== input.operationId
        || binding.proofKeyThumbprint !== input.jkt
        || binding.requester !== `agent_${input.jkt}` || binding.deviceId !== input.deviceId
        || binding.sessionGeneration !== input.session.generation || input.session.harness !== 'proof-key'
        || input.session.sessionId !== binding.requester) return { kind: 'invalid_grant' };
      const loaded = await exchanges.load(binding);
      if (loaded.kind === 'unavailable') return { kind: 'unavailable' };
      if (loaded.kind !== 'found') return { kind: 'invalid_grant' };
      const record = loaded.stored.record;
      if (record.phase !== 'sealed' || record.proofKeyThumbprint !== input.jkt
        || record.deviceId !== input.deviceId || record.sessionGeneration !== input.session.generation) {
        return { kind: 'invalid_grant' };
      }
      // The issuance record is written before the first capability is returned.
      // Refuse a completed operation before device provisioning can log in again.
      // An absent record still permits recovery of a consumed, unissued grant.
      const issued = await findChannelAccessBinding(active.store, binding);
      if (issued.kind === 'unavailable') return { kind: 'unavailable' };
      if (issued.kind === 'found') return { kind: 'replayed' };
      const live = await authority.authorize({ operationId: binding.operationId, requester: binding.requester,
        origin: binding.origin, sessionGeneration: binding.sessionGeneration,
        sessionFingerprint: record.sessionFingerprint, claimOperationId: `${loaded.stored.key}#claim` });
      if (live.kind === 'unavailable') return { kind: 'unavailable' };
      if (live.kind !== 'authorized' || live.authorization.ownerId !== binding.ownerId
        || live.authorization.channelRef !== binding.channelRef) return { kind: 'invalid_grant' };
      const approval = await deps.admissionAuthority.current({
        providerOperationId: record.providerOperationId, ownerId: binding.ownerId,
        channelRef: binding.channelRef, requester: binding.requester,
        sessionGeneration: binding.sessionGeneration, sessionFingerprint: record.sessionFingerprint,
        deviceId: binding.deviceId, history: 'none',
      });
      if (approval === 'unavailable') return { kind: 'unavailable' };
      if (approval !== 'current') return { kind: 'invalid_grant' };
      const target = await readHostedAccessTarget(active, binding.channelRef);
      if (target === 'unavailable') return { kind: 'unavailable' };
      if (target === null || target.ownerId !== binding.ownerId) return { kind: 'invalid_grant' };
      const consumed = await issuer.redeem({ grant: input.grant, operationId: binding.operationId,
        requester: binding.requester, origin: binding.origin, sessionGeneration: binding.sessionGeneration,
        deviceId: binding.deviceId, proofKeyThumbprint: binding.proofKeyThumbprint });
      if (consumed.kind === 'unavailable') return { kind: 'unavailable' };
      if (consumed.kind === 'rejected' && consumed.code !== 'grant_replayed') return { kind: 'invalid_grant' };
      if (consumed.kind === 'rejected') {
        const prior = await issuer.consumed({ grant: input.grant, operationId: binding.operationId,
          requester: binding.requester, origin: binding.origin, sessionGeneration: binding.sessionGeneration,
          deviceId: binding.deviceId, proofKeyThumbprint: binding.proofKeyThumbprint });
        if (prior.kind === 'unavailable') return { kind: 'unavailable' };
        if (prior.kind !== 'consumed') return { kind: 'invalid_grant' };
      }
      return { kind: 'redeemed', authorization: {
        v: 1, requestHandle: live.authorization.requestHandle,
        ownerId: binding.ownerId, channelId: target.roomId, origin: binding.origin,
        descriptorId: binding.operationId, jkt: input.jkt, harness: 'proof-key',
        sessionId: binding.requester, generation: binding.sessionGeneration,
        deviceId: binding.deviceId, evidenceDigest: record.sessionFingerprint,
        claimFingerprint: record.sessionFingerprint, approvedAt: new Date(active.clock()).toISOString(),
        expiresAt: live.authorization.deadline,
      } };
    },
    async reserveIssue(input) {
      const inspected = await issuer.inspect(input.grant);
      if (inspected.kind === 'unavailable') return 'unavailable';
      if (inspected.kind !== 'found' || inspected.binding.operationId !== input.operationId) return 'stale';
      const loaded = await exchanges.load(inspected.binding);
      if (loaded.kind === 'unavailable') return 'unavailable';
      if (loaded.kind !== 'found' || loaded.stored.record.phase !== 'sealed') return 'stale';
      return reserveChannelAccessIssuance(active.store, inspected.binding, input.bindingId,
        loaded.stored.record.expiresAt, active.clock());
    },
    async markIssued(input) {
      // Binding and Matrix device setup happen after redemption. Recheck the
      // approval at the final capability issuance boundary as well.
      const inspected = await issuer.inspect(input.grant);
      if (inspected.kind === 'unavailable') return 'unavailable';
      if (inspected.kind !== 'found' || inspected.binding.operationId !== input.operationId) return 'replayed';
      const binding = inspected.binding;
      const loaded = await exchanges.load(binding);
      if (loaded.kind === 'unavailable') return 'unavailable';
      if (loaded.kind !== 'found' || loaded.stored.record.phase !== 'sealed') return 'replayed';
      const record = loaded.stored.record;
      const live = await authority.authorize({ operationId: binding.operationId, requester: binding.requester,
        origin: binding.origin, sessionGeneration: binding.sessionGeneration,
        sessionFingerprint: record.sessionFingerprint, claimOperationId: `${loaded.stored.key}#claim` });
      if (live.kind === 'unavailable') return 'unavailable';
      if (live.kind !== 'authorized' || live.authorization.ownerId !== binding.ownerId
        || live.authorization.channelRef !== binding.channelRef) return 'replayed';
      const approval = await deps.admissionAuthority.current({
        providerOperationId: record.providerOperationId, ownerId: binding.ownerId,
        channelRef: binding.channelRef, requester: binding.requester,
        sessionGeneration: binding.sessionGeneration, sessionFingerprint: record.sessionFingerprint,
        deviceId: binding.deviceId, history: 'none',
      });
      if (approval === 'unavailable') return 'unavailable';
      if (approval !== 'current') return 'replayed';
      const target = await readHostedAccessTarget(active, binding.channelRef);
      if (target === 'unavailable') return 'unavailable';
      if (target === null || target.ownerId !== binding.ownerId || !input.matrixSession
        || input.matrixSession.deviceId !== binding.deviceId || input.matrixSession.roomId !== target.roomId) return 'replayed';
      return recordChannelAccessBinding(active.store, binding, input.bindingId, input.matrixSession, record.expiresAt);
    },
  };
}

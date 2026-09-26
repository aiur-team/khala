import { generateKeyPairSync } from 'node:crypto';
import {
  type AuthPrincipal,
  type AuthorizedChannelRef,
  type ChannelAccessRequesterContext,
  type ChannelAccessResolutionPort,
  type ChannelAccessRevalidationResult,
  type DeviceId,
  type DiscoveryRequester,
  type GrantExchangeRequest,
  type OwnerId,
  deriveOkpKeyThumbprint,
} from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { createChannelAccessPolicy } from '../policy';
import { createChannelAccessService } from '../service';
import { createChannelAccessStore } from '../store';
import { fakeControlStore } from '../support.test';

export const T0 = Date.parse('2026-09-25T12:00:00Z');
export const DIGEST = 'a'.repeat(43);
export const CHANNEL_REF = 'channel_ref_1' as AuthorizedChannelRef;
export const TARGET_REVISION = 'target_revision_1';
export const DEVICE = 'device_agent_1' as DeviceId;

export const requester: DiscoveryRequester = {
  principal: 'principal_1' as DiscoveryRequester['principal'],
  origin: 'https://khala.example',
  proofKey: { algorithm: 'Ed25519', publicKey: 'b'.repeat(43), thumbprint: 'c'.repeat(43) },
  sessionGeneration: 3,
};

export const context: ChannelAccessRequesterContext = {
  v: 1,
  principal: requester.principal,
  origin: requester.origin,
  sessionGeneration: requester.sessionGeneration,
  sessionFingerprint: DIGEST,
  harness: 'codex',
  displayLabel: 'Build agent',
  workspaceLabel: 'Khala',
};

export const owner: AuthPrincipal = {
  v: 1,
  ownerId: 'owner_1' as OwnerId,
  providerIssuer: 'https://identity.example',
  providerSubject: 'subject_1',
  verifiedEmail: 'owner@example.com',
  sessionExpiresAt: '2026-10-25T12:00:00Z',
};

/** A real hosted journal (store + service) over one fake `ControlStore`. */
export function journalHarness() {
  let now = T0;
  const backing = fakeControlStore();
  const policy = createChannelAccessPolicy({ key: new Uint8Array(32).fill(7) });
  const store = createChannelAccessStore({ store: backing.store, policy, clock: () => now });
  const state: { requester: 'current' | 'revoked'; access: ChannelAccessRevalidationResult } = {
    requester: 'current',
    access: { kind: 'current', ownerId: owner.ownerId, targetRevision: TARGET_REVISION, title: 'Private channel' },
  };
  const resolver: ChannelAccessResolutionPort = {
    async resolveAccess() {
      return { kind: 'resolved', ownerId: owner.ownerId, channelRef: CHANNEL_REF, targetRevision: TARGET_REVISION, title: 'Private channel' };
    },
    async resolveCreate() { return { kind: 'unavailable' }; },
    async revalidateAccess() { return state.access; },
    async revalidateCreate() { return { kind: 'unavailable' }; },
    async currentAccessOwner() { return { kind: 'owned', ownerId: owner.ownerId, targetRevision: TARGET_REVISION }; },
    async checkRequester() { return { kind: state.requester }; },
  };
  const service = createChannelAccessService({ store, resolver, policy });
  return {
    backing,
    store,
    service,
    state,
    clock: () => now,
    setNow(value: number) { now = value; },
    async approved(operationId = 'op_access_1') {
      const status = await service.journal.requestAccess({
        v: 1, kind: 'listing_ref', operationId, credentialRef: 'credential_1', listingRef: 'listing_1',
      }, requester, context);
      expect(status.outcome).toBe('pending_owner');
      const listed = await store.listOwner({ ownerId: owner.ownerId });
      if (listed.kind !== 'found') throw new Error('request missing');
      const requestHandle = listed.requests.at(-1)!.requestHandle;
      const decided = await service.decisions.decide({
        v: 1, requestHandle: requestHandle as never, expectedRevision: 'carev_1', decision: 'approve', operationId: `decide_${operationId}`,
      }, owner);
      expect(decided.kind).toBe('ok');
      return requestHandle;
    },
    status(operationId = 'op_access_1') {
      return service.journal.inspect({ v: 1, operationId, operationKind: 'access' }, requester, context);
    },
  };
}

export async function connectorRequest(overrides: Partial<GrantExchangeRequest> = {}, nowMs = T0): Promise<GrantExchangeRequest> {
  const proofX = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!;
  const boxX = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x!;
  const proof = await deriveOkpKeyThumbprint({ algorithm: 'Ed25519', publicKey: proofX, thumbprint: '' });
  const box = await deriveOkpKeyThumbprint({ algorithm: 'X25519', publicKey: boxX, thumbprint: '' });
  if (!proof.ok || !box.ok) throw new Error('crypto unavailable');
  return {
    v: 1,
    operationId: 'op_access_1',
    requester: requester.principal,
    origin: requester.origin,
    proofKey: { algorithm: 'Ed25519', publicKey: proofX, thumbprint: proof.thumbprint },
    encryptionKey: { algorithm: 'X25519', publicKey: boxX, thumbprint: box.thumbprint },
    deviceId: DEVICE,
    sessionGeneration: 3,
    expiresAt: new Date(nowMs + 60_000).toISOString(),
    ...overrides,
  };
}

describe('grant exchange control harness', () => {
  it('builds an approved journal request', async () => {
    const h = journalHarness();
    await h.approved();
    expect(await h.status()).toEqual({ v: 1, operationId: 'op_access_1', outcome: 'approved' });
  });
});

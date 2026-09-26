import type {
  AuthPrincipal,
  ChannelAccessRequesterContext,
  ChannelAccessResolutionPort,
  ChannelCreateAdapterPort,
  ChannelCreateRevalidationResult,
  ChannelSummary,
  DiscoveryRequester,
  OwnerId,
  RoomId,
} from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { createChannelAccessPolicy } from '../channel-access/policy';
import { createChannelAccessService } from '../channel-access/service';
import { createChannelAccessStore } from '../channel-access/store';
import { fakeControlStore } from '../channel-access/support.test';
import type { ChannelCreateSubstrate } from './adapter';
import { composeChannelCreate, hostedChannelCreateAdapter } from './compose';
import { createSubstrateChannelCreateAdapter } from './adapter';

export const T0 = Date.parse('2026-09-25T12:00:00Z');
export const DIGEST = 'a'.repeat(43);
export const OWNER_REVISION = 'owner_revision_1';

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

export const otherOwner: AuthPrincipal = { ...owner, ownerId: 'owner_2' as OwnerId, providerSubject: 'subject_2' };

type CreateFault = 'lose_response' | 'unavailable' | 'rejected' | 'unknown_not_applied';

/**
 * A substrate that tags rooms with their operation ID. `proves: 'absent'` models
 * the internal SQLite store, which can prove no room exists; `proves: 'unknown'`
 * models the hosted Matrix substrate, which never answers `absent`.
 */
export function fakeSubstrate(proves: 'absent' | 'unknown') {
  const rooms = new Map<string, ChannelSummary>();
  const createCalls: Array<Readonly<{ operationId: string; title: string | null }>> = [];
  const faults: CreateFault[] = [];
  let visible = proves === 'absent';
  const substrate: ChannelCreateSubstrate = {
    async createRoom(input): ReturnType<ChannelCreateSubstrate['createRoom']> {
      createCalls.push(input);
      const fault = faults.shift();
      if (fault === 'unavailable') return { kind: 'unavailable' };
      if (fault === 'rejected') return { kind: 'rejected', code: 'forbidden' };
      if (fault === 'unknown_not_applied') return { kind: 'unknown' };
      const room: ChannelSummary = {
        roomId: `!room_${rooms.size + 1}` as RoomId,
        title: input.title,
        membership: 'joined',
        revision: 'r1',
      };
      rooms.set(input.operationId, room);
      return fault === 'lose_response' ? { kind: 'unknown' } : { kind: 'done', value: room };
    },
    async findCreatedRoom(input): ReturnType<ChannelCreateSubstrate['findCreatedRoom']> {
      const room = rooms.get(input.operationId);
      if (room && visible) return { kind: 'found', room };
      return proves === 'absent' ? { kind: 'absent' } : { kind: 'unknown' };
    },
  };
  return {
    substrate,
    rooms,
    createCalls,
    fail(...values: CreateFault[]) { faults.push(...values); },
    /** The hosted substrate finds a created room only once it has synced. */
    sync() { visible = true; },
  };
}

/** The real hosted journal plus the creation workflow over one fake `ControlStore`. */
export function createHarness(options: Readonly<{ proves?: 'absent' | 'unknown'; adapter?: 'hosted' | 'internal' }> = {}) {
  let now = T0;
  const clock = () => now;
  const backing = fakeControlStore();
  const policy = createChannelAccessPolicy({ key: new Uint8Array(32).fill(7) });
  const journal = createChannelAccessStore({ store: backing.store, policy, clock });
  const state: { requester: 'current' | 'revoked'; create: ChannelCreateRevalidationResult } = {
    requester: 'current',
    create: { kind: 'current', ownerId: owner.ownerId, ownerRevision: OWNER_REVISION },
  };
  const resolver: ChannelAccessResolutionPort = {
    async resolveAccess() { return { kind: 'unavailable' }; },
    async resolveCreate() { return { kind: 'resolved', ownerId: owner.ownerId, ownerRevision: OWNER_REVISION }; },
    async revalidateAccess() { return { kind: 'unavailable' }; },
    async revalidateCreate() { return state.create; },
    async currentAccessOwner() { return { kind: 'forbidden' }; },
    async checkRequester() { return { kind: state.requester }; },
  };
  const service = createChannelAccessService({ store: journal, resolver, policy });
  const fake = fakeSubstrate(options.proves ?? 'absent');
  const adapter: ChannelCreateAdapterPort = options.adapter === 'hosted'
    ? hostedChannelCreateAdapter({ substrate: fake.substrate, clock })
    : createSubstrateChannelCreateAdapter({
      substrate: fake.substrate,
      channelRef: roomId => `internal_${roomId.slice(1)}` as never,
      clock,
    });
  const compose = () => composeChannelCreate({ store: backing.store, journal, service, adapter, clock });
  let created = compose();
  return {
    backing,
    journal,
    service,
    state,
    fake,
    clock,
    get create() { return created; },
    setNow(value: number) { now = value; },
    /** A process restart: a fresh workflow over the same durable stores. */
    restart() { created = compose(); },
    async submit(operationId = 'op_create_1', proposedTitle = 'Release notes') {
      return await service.journal.requestCreate({
        v: 1, operationId, credentialRef: 'credential_1', origin: requester.origin, proposedTitle,
      }, requester, context);
    },
    async pending() {
      const listed = await journal.listOwner({ ownerId: owner.ownerId });
      if (listed.kind !== 'found') throw new Error('journal unavailable');
      return listed.requests.at(-1)!.requestHandle as never;
    },
    async approve(principal: AuthPrincipal = owner, operationId = 'decide_1') {
      const requestHandle = await this.pending();
      return await created.decisions.decide({
        v: 1, requestHandle, expectedRevision: 'carev_1', decision: 'approve', operationId,
      }, principal);
    },
    status(operationId = 'op_create_1') {
      return service.journal.inspect({ v: 1, operationId, operationKind: 'create' }, requester, context);
    },
    /** Every durable key outside the journal's own aggregate. */
    sideEffectKeys() {
      return [...backing.records.keys()].filter(key => key !== 'channel-access.journal.v1');
    },
  };
}

describe('channel-create test harness', () => {
  it('journals a pending create intent', async () => {
    const h = createHarness();
    expect(await h.submit()).toEqual({ v: 1, operationId: 'op_create_1', outcome: 'pending_owner' });
  });
});

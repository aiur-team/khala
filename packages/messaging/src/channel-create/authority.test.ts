import type {
  AuthorizedChannelRef,
  ChannelCreateAuthorization,
  StableAgentPrincipal,
} from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import type { ExchangeAuthorityInput, GrantExchangeAuthority } from '../channel-access/exchange/authority';
import type { ChannelAccessStore } from '../channel-access/journal/store';
import { createChannelCreateExchangeAuthority } from './authority';
import { DIGEST, T0, owner, requester } from './support.test';

const CREATED = 'created_channel' as AuthorizedChannelRef;
const deadline = new Date(T0 + 60_000).toISOString();

const authorization = {
  v: 1,
  kind: 'create',
  authorizationRef: 'authorization_1',
  requestHandle: 'careq_1',
  requestRevision: 'carev_3',
  operationId: 'op_create_1',
  ownerId: owner.ownerId,
  requester: requester.principal,
  origin: requester.origin,
  sessionGeneration: 3,
  sessionFingerprint: DIGEST,
  deadline,
  proposalDigest: DIGEST,
  proposedTitle: 'Notes',
} as unknown as ChannelCreateAuthorization;

const input: ExchangeAuthorityInput = {
  operationId: 'op_create_1',
  requester: requester.principal,
  origin: requester.origin,
  sessionGeneration: 3,
  sessionFingerprint: DIGEST,
  claimOperationId: 'claim_1',
};

function authority() {
  const accessCalls: string[] = [];
  const access: GrantExchangeAuthority = {
    async authorize() { accessCalls.push('authorize'); return { kind: 'unavailable' }; },
    async close() { accessCalls.push('close'); return 'closed'; },
    async markConnected() { accessCalls.push('markConnected'); return 'unavailable'; },
  };
  // A journal lookup that (wrongly) returns the row to any caller, to isolate this module's own binding check.
  const journal = {
    async inspectRequester() {
      return {
        kind: 'found',
        status: { outcome: 'connecting' },
        context: { requestHandle: 'careq_1', deadline, detail: { kind: 'create' } },
      };
    },
    async readContext() { return { kind: 'found', context: { detail: { kind: 'create' } } }; },
  } as unknown as Pick<ChannelAccessStore, 'inspectRequester' | 'readContext'>;
  return {
    accessCalls,
    port: createChannelCreateExchangeAuthority({
      access,
      journal,
      fulfillment: { async updateCreate() { return { kind: 'unavailable' as const, retryable: true as const }; } },
      workflow: {
        async fulfill() { return { kind: 'created', channelRef: CREATED, authorization }; },
        async unsettled() { return false; },
      },
      clock: () => T0,
    }),
  };
}

describe('create-aware exchange authority', () => {
  it('authorizes admission into the created channel for the bound requester only', async () => {
    const { port, accessCalls } = authority();
    const result = await port.authorize(input);

    expect(result).toMatchObject({
      kind: 'authorized',
      authorization: {
        kind: 'access',
        channelRef: CREATED,
        requester: requester.principal,
        origin: requester.origin,
        sessionGeneration: 3,
        sessionFingerprint: DIGEST,
        requestRevision: 'carev_3',
      },
    });
    expect(result.kind === 'authorized' ? Object.keys(result.authorization) : []).not.toContain('proposedTitle');
    expect(accessCalls).toEqual([]);
  });

  it.each([
    ['requester', { requester: 'principal_2' as StableAgentPrincipal }],
    ['origin', { origin: 'https://attacker.example' }],
    ['session generation', { sessionGeneration: 4 }],
    ['session fingerprint', { sessionFingerprint: 'd'.repeat(43) }],
    ['operation', { operationId: 'op_other' }],
  ])('closes when the %s does not match the approved creation', async (_name, override) => {
    const { port } = authority();

    expect(await port.authorize({ ...input, ...override })).toEqual({ kind: 'closed', reason: 'closed' });
  });
});

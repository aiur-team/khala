import type { StableAgentPrincipal } from '@khala/contracts/messaging/index';
import { connectorRequest } from '@khala/messaging/channel-access/exchange/journal-harness.test';
import type { ChannelAdmissionProviderPort, ChannelAdmissionRequest } from '@khala/messaging/channel-access/exchange/ports';
import {
  DIGEST,
  type HarnessAdapter,
  context,
  createHarness,
  owner,
  requester,
} from '@khala/messaging/channel-create/support.test';
import { describe, expect, it } from 'vitest';
import type { MutationAuthorization } from '../../auth';
import type { VerifiedExchangeConnector } from '../../channel-access/exchange/handler';
import { createChannelAccessHandlers } from '../../channel-access/handler';
import { channelKey } from '../../channel-discovery/catalog';
import { composeChannelAccessExchange } from './channel-access-exchange';
import { hostedChannelCreateAdapter } from './channel-create';

const DEVICE = 'device_agent_1' as VerifiedExchangeConnector['deviceId'];
const hosted: HarnessAdapter = (substrate, clock) => hostedChannelCreateAdapter({ substrate, clock });

async function setup(options: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness(options);
  const admits: ChannelAdmissionRequest[] = [];
  const applied = new Set<string>();
  const provider: ChannelAdmissionProviderPort = {
    async admit(input) {
      admits.push(input);
      applied.add(input.providerOperationId);
      return { kind: 'admitted', membership: 'joined' };
    },
    async reconcile(input) {
      return applied.has(input.providerOperationId) ? { kind: 'admitted', membership: 'joined' } : { kind: 'not_applied' };
    },
  };
  const body = await connectorRequest({ operationId: 'op_create_1' }, h.clock());
  let connector: VerifiedExchangeConnector = {
    requester: requester.principal,
    origin: requester.origin,
    sessionGeneration: 3,
    sessionFingerprint: DIGEST,
    deviceId: DEVICE,
    proofKeyThumbprint: body.proofKey.thumbprint,
  };
  let humanAuth: 'authorized' | 'forbidden' = 'authorized';
  const handlers = createChannelAccessHandlers({
    service: { journal: h.service.journal, decisions: h.create.decisions },
    auth: {
      authenticateRequest: async () => ({ kind: 'unavailable' }),
      requireHumanMutation: async (): Promise<MutationAuthorization> => humanAuth === 'authorized'
        ? { kind: 'authorized', context: { principal: owner, csrfToken: 'csrf' } }
        : { kind: 'rejected', code: 'forbidden_origin' },
    },
    authenticateAgent: async () => ({ kind: 'authenticated', requester, context }),
  });
  const exchangeRoutes = composeChannelAccessExchange({
    store: h.backing.store,
    journal: h.journal,
    fulfillment: h.service.fulfillment,
    provider,
    clock: h.clock,
    authority: h.create.exchangeAuthority,
    authenticateConnector: async () => ({ kind: 'authenticated', connector }),
  });
  const route = (path: string) => [...handlers.agent, ...handlers.human, ...exchangeRoutes]
    .find(registration => registration.path === path)!;
  const post = (path: string, payload: unknown) => route(path).handle(new Request(`${requester.origin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }));
  return {
    h,
    admits,
    body,
    as(next: Partial<VerifiedExchangeConnector>) { connector = { ...connector, ...next }; },
    denyHumanRole() { humanAuth = 'forbidden'; },
    submit: (proposedTitle = 'Release notes') => post('/api/agent/channel-access/create', {
      v: 1, operationId: 'op_create_1', credentialRef: 'credential_1', origin: requester.origin, proposedTitle,
    }),
    async decide(decision: 'approve' | 'deny' = 'approve') {
      return await post('/api/human/channel-access/decision', {
        v: 1, requestHandle: await h.pending(), expectedRevision: 'carev_1', decision, operationId: 'decide_1',
      });
    },
    exchange: (payload: unknown = body) => route('/api/agent/channel-access/exchange').handle(new Request(
      `${requester.origin}/api/agent/channel-access/exchange?operation=op_create_1`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
    )),
    ready: () => route('/api/agent/channel-access/ready').handle(new Request(
      `${requester.origin}/api/agent/channel-access/ready?operation=op_create_1`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          operationId: 'op_create_1',
          requester: requester.principal,
          origin: requester.origin,
          sessionGeneration: 3,
          deviceId: DEVICE,
          proofKeyThumbprint: body.proofKey.thumbprint,
          recipientKeyThumbprint: body.encryptionKey.thumbprint,
        }),
      },
    )),
    status: async () => await (await route('/api/agent/channel-access/status').handle(new Request(
      `${requester.origin}/api/agent/channel-access/status?v=1&operationId=op_create_1&operationKind=create`,
    ))).json(),
  };
}

describe('composed human-confirmed channel creation', () => {
  it('submission alone creates no channel, membership, device, binding, or grant', async () => {
    const t = await setup();
    const submitted = await t.submit();
    expect(await submitted.json()).toEqual({ v: 1, operationId: 'op_create_1', outcome: 'pending_owner' });

    // The connector cannot turn an unapproved intent into a channel or a grant.
    expect((await t.exchange()).status).toBe(503);
    expect(t.h.fake.createCalls).toEqual([]);
    expect(t.admits).toEqual([]);
    // The exchange persists only its connector-bound tuple before checking approval (RD5A).
    const keys = t.h.sideEffectKeys();
    expect(keys.filter(key => !key.startsWith('channel-access-exchange'))).toEqual([]);
    const exchangeRecords = keys.filter(key => key.startsWith('channel-access-exchange/'))
      .map(key => t.h.backing.records.get(key)!.value as { phase: string; membership: unknown; envelope: unknown });
    expect(exchangeRecords).toEqual([expect.objectContaining({ phase: 'bound', membership: null, envelope: null })]);
  });

  it('rejects approval from a binding or discovery capability without the human role', async () => {
    const t = await setup();
    await t.submit();
    t.denyHumanRole();

    expect((await t.decide()).status).toBe(403);
    expect(t.h.fake.createCalls).toEqual([]);
    expect(await t.status()).toMatchObject({ outcome: 'pending_owner' });
  });

  it('admits only the requesting session into the one created channel', async () => {
    const t = await setup({ adapter: hosted });
    await t.submit();
    const decided = await t.decide();
    expect(decided.status).toBe(200);
    expect(await decided.json()).toMatchObject({ operationKind: 'create', outcome: 'connecting' });
    expect(t.h.fake.rooms.size).toBe(1);
    // Approval records authorization; nothing is admitted while the connector is offline.
    expect(t.admits).toEqual([]);

    const sealed = await t.exchange();
    expect(sealed.status).toBe(200);
    const created = await t.h.create.workflow.fulfill(await t.h.pending());
    expect(created.kind).toBe('created');
    expect(t.admits).toEqual([expect.objectContaining({
      ownerId: owner.ownerId,
      channelRef: created.kind === 'created' ? created.channelRef : null,
      requester: requester.principal,
      sessionGeneration: 3,
      deviceId: DEVICE,
      history: 'none',
    })]);
    expect(await t.status()).toEqual({ v: 1, operationId: 'op_create_1', outcome: 'connecting' });

    expect((await t.ready()).status).toBe(200);
    expect(await t.status()).toEqual({ v: 1, operationId: 'op_create_1', outcome: 'connected' });
    expect(t.h.fake.createCalls).toHaveLength(1);
    expect(t.admits).toHaveLength(1);
  });

  it.each([
    ['another requester', { requester: 'principal_2' as StableAgentPrincipal }],
    ['another session', { sessionFingerprint: 'd'.repeat(43) }],
    ['another origin', { origin: 'https://attacker.example' }],
    ['another session generation', { sessionGeneration: 4 }],
  ])('refuses %s presenting the approved create operation', async (_name, connector) => {
    const t = await setup();
    await t.submit();
    await t.decide();
    t.as(connector);
    const payload = { ...t.body, ...('requester' in connector ? { requester: connector.requester } : {}),
      ...('origin' in connector ? { origin: connector.origin } : {}),
      ...('sessionGeneration' in connector ? { sessionGeneration: connector.sessionGeneration } : {}) };

    const response = await t.exchange(payload);

    expect(response.status).not.toBe(200);
    expect(t.admits).toEqual([]);
    expect(t.h.fake.createCalls).toHaveLength(1);
  });

  it('refuses a proof key other than the connector-authenticated one', async () => {
    const t = await setup();
    await t.submit();
    await t.decide();
    t.as({ proofKeyThumbprint: 'e'.repeat(43) });

    expect((await t.exchange()).status).toBe(409);
    expect(t.admits).toEqual([]);
  });

  it('finishes an interrupted creation at connector exchange without a second channel', async () => {
    const t = await setup();
    await t.submit();
    t.h.fake.fail('lose_response');
    await t.decide();
    expect(await t.status()).toMatchObject({ outcome: 'connecting' });

    expect((await t.exchange()).status).toBe(200);
    expect(t.h.fake.createCalls).toHaveLength(1);
    expect(t.h.fake.rooms.size).toBe(1);
    expect(t.admits).toHaveLength(1);
  });

  it('closes the exchange for a denied creation', async () => {
    const t = await setup();
    await t.submit();
    expect((await t.decide('deny')).status).toBe(200);

    expect((await t.exchange()).status).toBe(410);
    expect(t.h.fake.createCalls).toEqual([]);
    expect(t.admits).toEqual([]);
  });
});

describe('hosted channel-create adapter', () => {
  it('references the hosted channel the way hosted discovery does', async () => {
    const h = createHarness({ adapter: hosted });
    await h.submit();
    await h.approve();
    const fulfilled = await h.create.workflow.fulfill(await h.pending());

    expect(fulfilled.kind).toBe('created');
    if (fulfilled.kind !== 'created') return;
    expect(fulfilled.channelRef).toBe(channelKey([...h.fake.rooms.values()][0]!.roomId));
  });
});

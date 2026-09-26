import type { ChannelAdmissionProviderPort, ChannelAdmissionRequest } from '@khala/messaging/channel-access/exchange/ports';
import { describe, expect, it } from 'vitest';
import { createChannelAccessHandlers } from '../../channel-access/handler';
import { CHANNEL_REF, DEVICE, DIGEST, connectorRequest, context, journalHarness, requester } from '@khala/messaging/channel-access/exchange/journal-harness.test';
import { composeChannelAccessExchange } from './channel-access-exchange';
import { registerAgentHandlers } from './handlers';

async function setup() {
  const journal = journalHarness();
  const admits: ChannelAdmissionRequest[] = [];
  const applied = new Set<string>();
  const provider: ChannelAdmissionProviderPort = {
    async admit(input) {
      admits.push(input);
      const membership = applied.has(input.providerOperationId) ? 'already_joined' : 'joined';
      applied.add(input.providerOperationId);
      return { kind: 'admitted', membership };
    },
    async reconcile(input) {
      return applied.has(input.providerOperationId) ? { kind: 'admitted', membership: 'joined' } : { kind: 'not_applied' };
    },
  };
  const body = await connectorRequest({}, journal.clock());
  const routes = registerAgentHandlers({
    authorize: async () => 'allowed',
    status: { snapshot: async () => ({ generation: 0, agents: [] }) },
    channelAccess: () => createChannelAccessHandlers({
      service: journal.service,
      auth: { authenticateRequest: async () => ({ kind: 'unavailable' }), requireHumanMutation: async () => ({ kind: 'unavailable' }) },
      authenticateAgent: async () => ({ kind: 'authenticated', requester, context }),
    }).agent,
    channelAccessExchange: () => composeChannelAccessExchange({
      store: journal.backing.store,
      journal: journal.store,
      fulfillment: journal.service.fulfillment,
      provider,
      clock: journal.clock,
      authenticateConnector: async () => ({
        kind: 'authenticated',
        connector: {
          requester: requester.principal,
          origin: requester.origin,
          sessionGeneration: 3,
          sessionFingerprint: DIGEST,
          deviceId: DEVICE,
          proofKeyThumbprint: body.proofKey.thumbprint,
        },
      }),
    }),
  });
  const route = (path: string) => routes.find(registration => registration.path === path)!;
  return {
    journal,
    admits,
    body,
    exchange: () => route('/api/agent/channel-access/exchange').handle(new Request(
      `${requester.origin}/api/agent/channel-access/exchange?operation=op_access_1`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    )),
    ready: (overrides: Record<string, unknown> = {}) => route('/api/agent/channel-access/ready').handle(new Request(
      `${requester.origin}/api/agent/channel-access/ready?operation=op_access_1`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          operationId: 'op_access_1',
          requester: requester.principal,
          origin: requester.origin,
          sessionGeneration: 3,
          deviceId: DEVICE,
          proofKeyThumbprint: body.proofKey.thumbprint,
          recipientKeyThumbprint: body.encryptionKey.thumbprint,
          ...overrides,
        }),
      },
    )),
    status: () => route('/api/agent/channel-access/status').handle(new Request(
      `${requester.origin}/api/agent/channel-access/status?v=1&operationId=op_access_1&operationKind=access`,
    )),
  };
}

describe('composed channel-access grant exchange', () => {
  it('exchanges an approved request once and recovers the byte-identical envelope', async () => {
    const h = await setup();
    await h.journal.approved();

    const first = await h.exchange();
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const text = await first.text();
    expect(JSON.parse(text)).toMatchObject({
      v: 1,
      algorithm: 'crypto_box_seal_x25519_xsalsa20poly1305',
      recipientKeyThumbprint: h.body.encryptionKey.thumbprint,
    });
    expect(await (await h.exchange()).text()).toBe(text);
    expect(h.admits).toHaveLength(1);
    expect(h.admits[0]).toMatchObject({ channelRef: CHANNEL_REF, deviceId: DEVICE, history: 'none' });
  });

  it('keeps agent status grant-free and never reports connected from the exchange', async () => {
    const h = await setup();
    await h.journal.approved();
    const envelope = await (await h.exchange()).json() as { ciphertext: string };
    const status = await h.status();
    const statusText = await status.text();
    expect(JSON.parse(statusText)).toEqual({ v: 1, operationId: 'op_access_1', outcome: 'connecting' });
    expect(statusText).not.toContain(envelope.ciphertext);
    const persisted = JSON.stringify([...h.journal.backing.records.values()]);
    expect(persisted).not.toContain('cagrant_');
    expect(persisted).not.toContain('"connected"');
  });

  it('reports connected only after readiness, then deletes the envelope', async () => {
    const h = await setup();
    await h.journal.approved();
    const envelope = await (await h.exchange()).json() as { ciphertext: string };
    // Readiness names the recovery key the envelope was sealed to; any other is refused.
    expect((await h.ready({ recipientKeyThumbprint: 'A'.repeat(43) })).status).toBe(409);
    expect(await (await h.status()).json()).toMatchObject({ outcome: 'connecting' });

    const ready = await h.ready();
    expect(ready.status).toBe(200);
    expect(ready.headers.get('cache-control')).toBe('no-store');
    expect(await ready.json()).toEqual({ v: 1, kind: 'acknowledged' });
    expect(await (await h.status()).json()).toEqual({ v: 1, operationId: 'op_access_1', outcome: 'connected' });
    expect(JSON.stringify([...h.journal.backing.records.values()])).not.toContain(envelope.ciphertext);
    // A duplicate acknowledgement is the same success; the envelope is gone for good.
    expect((await h.ready()).status).toBe(200);
    expect((await h.exchange()).status).toBe(410);
    expect(h.admits).toHaveLength(1);
  });

  it('refuses readiness before the exchange sealed a result', async () => {
    const h = await setup();
    await h.journal.approved();
    expect((await h.ready()).status).toBe(409);
    expect(await (await h.status()).json()).toMatchObject({ outcome: 'approved' });
  });

  it('does not admit or mint before the owner approves', async () => {
    const h = await setup();
    await h.journal.service.journal.requestAccess({
      v: 1, kind: 'listing_ref', operationId: 'op_access_1', credentialRef: 'credential_1', listingRef: 'listing_1',
    }, requester, context);
    expect((await h.exchange()).status).toBe(503);
    expect(h.admits).toHaveLength(0);
    expect(JSON.stringify([...h.journal.backing.records.values()])).not.toContain('channel-access-grant/');
  });
});

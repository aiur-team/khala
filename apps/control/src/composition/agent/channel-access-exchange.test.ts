import { CHANNEL_ACCESS_ENVELOPE_RECOVERY_MS } from '@khala/contracts/messaging/index';
import type { ChannelAdmissionProviderPort, ChannelAdmissionRequest } from '@khala/messaging/channel-access/exchange/ports';
import { describe, expect, it } from 'vitest';
import { createChannelAccessHandlers } from '../../channel-access/handler';
import { createExchangeGrantIssuer } from '@khala/messaging/channel-access/exchange/grants';
import { CHANNEL_REF, DEVICE, DIGEST, T0, connectorRequest, context, journalHarness, requester } from '@khala/messaging/channel-access/exchange/journal-harness.test';
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
  // The key the caller proves possession of; the bound key unless a test says otherwise.
  const caller = { proofKeyThumbprint: body.proofKey.thumbprint, authenticated: true };
  const resumed: unknown[] = [];
  const bindingState = { revoked: false };
  const binding = {
    v: 1, bindingId: 'bnd_1', ownerId: 'owner_1', agentParticipantId: 'agent_1',
    deviceId: DEVICE, harness: 'codex', sessionId: 'thread-1', generation: 3,
  };
  const bindings: Parameters<typeof composeChannelAccessExchange>[0]['bindings'] = {
    async resumeAdapterCapability(input) {
      resumed.push(input);
      if (bindingState.revoked) return { kind: 'refused', code: 'binding_revoked' };
      return {
        kind: 'resumed',
        binding: binding as never,
        capability: { token: `cap${resumed.length}`.padEnd(43, 'x'), scope: ['publish_own', 'receive_released', 'ack_delivery'], expiresAt: 4_000_000_000_000 },
      };
    },
  };
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
      bindings,
      clock: journal.clock,
      authenticateConnector: async () => (caller.authenticated ? {
        kind: 'authenticated',
        connector: {
          requester: requester.principal,
          origin: requester.origin,
          sessionGeneration: 3,
          sessionFingerprint: DIGEST,
          deviceId: DEVICE,
          proofKeyThumbprint: caller.proofKeyThumbprint,
        },
      } : { kind: 'rejected', code: 'auth_required' }),
    }),
  });
  const route = (path: string) => routes.find(registration => registration.path === path)!;
  return {
    journal,
    admits,
    body,
    caller,
    resumed,
    bindingState,
    /** The connector redeems the sealed grant once; only this records that the operation was admitted. */
    async redeemed() {
      const issuer = createExchangeGrantIssuer({ store: journal.backing.store, clock: journal.clock });
      const bound = {
        operationId: 'op_access_1', requester: requester.principal, origin: requester.origin, sessionGeneration: 3,
        deviceId: DEVICE, proofKeyThumbprint: body.proofKey.thumbprint, ownerId: 'owner_1' as never, channelRef: CHANNEL_REF,
      };
      const minted = await issuer.mint({ binding: bound, expiresAt: new Date(journal.clock() + 60_000).toISOString() });
      if (minted.kind !== 'minted') throw new Error('mint failed');
      const redeemed = await issuer.redeem({
        grant: minted.grant,
        operationId: bound.operationId,
        requester: bound.requester,
        origin: bound.origin,
        sessionGeneration: bound.sessionGeneration,
        deviceId: bound.deviceId,
        proofKeyThumbprint: bound.proofKeyThumbprint,
      });
      expect(redeemed.kind).toBe('redeemed');
    },
    resume: (overrides: Record<string, unknown> = {}) => route('/api/agent/channel-access/resume').handle(new Request(
      `${requester.origin}/api/agent/channel-access/resume?operation=op_access_1`,
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
          bindingId: 'bnd_1',
          proofKeyThumbprint: caller.proofKeyThumbprint,
          ...overrides,
        }),
      },
    )),
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

describe('composed channel-access resume by operation', () => {
  async function admitted() {
    const h = await setup();
    await h.journal.approved();
    expect((await h.exchange()).status).toBe(200);
    await h.redeemed();
    return h;
  }

  it('returns the same binding, device and generation every time, without minting or admitting again', async () => {
    const h = await admitted();
    const before = [...h.journal.backing.records.keys()].filter(key => key.startsWith('channel-access-grant')).length;
    const first = await h.resume();
    const second = await h.resume();
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const a = await first.json() as { binding: unknown; adapter_capability: Record<string, unknown> };
    const b = await second.json() as typeof a;
    expect(a.binding).toEqual(b.binding);
    expect(a.binding).toMatchObject({ bindingId: 'bnd_1', deviceId: DEVICE, generation: 3 });
    expect(a.adapter_capability).toMatchObject({
      token_type: 'DPoP', scope: ['publish_own', 'receive_released', 'ack_delivery'], binding_id: 'bnd_1', generation: 3,
    });
    expect(a.adapter_capability.token).not.toBe(b.adapter_capability.token);
    expect(h.admits).toHaveLength(1);
    expect([...h.journal.backing.records.keys()].filter(key => key.startsWith('channel-access-grant')).length).toBe(before);
    // The capability is bound to the exchange's key and the approving owner, never to caller input.
    expect(h.resumed[0]).toMatchObject({ bindingId: 'bnd_1', ownerId: 'owner_1', deviceId: DEVICE, generation: 3, jkt: h.body.proofKey.thumbprint });
  });

  it('refuses a resume by operation ID without proof for the bound key', async () => {
    const h = await admitted();
    h.caller.proofKeyThumbprint = 'z'.repeat(43);
    const refused = await h.resume();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ v: 1, kind: 'rejected', code: 'proof_mismatch' });
    // The authenticated key matches the body but not the exchange's key: still refused.
    h.caller.proofKeyThumbprint = 'y'.repeat(43);
    const other = await h.resume();
    expect(other.status).toBe(409);
    expect((await other.json() as { code: string }).code).toBe('proof_mismatch');
    expect(h.resumed).toHaveLength(0);

    // The caller proves key Y but claims the bound key X in the body: the claim is not proof.
    h.caller.proofKeyThumbprint = 'y'.repeat(43);
    const claimed = await h.resume({ proofKeyThumbprint: h.body.proofKey.thumbprint });
    expect(claimed.status).toBe(409);
    expect(await claimed.json()).toEqual({ v: 1, kind: 'rejected', code: 'proof_mismatch' });
    expect(h.resumed).toHaveLength(0);

    h.caller.proofKeyThumbprint = h.body.proofKey.thumbprint;
    h.caller.authenticated = false;
    expect((await h.resume()).status).toBe(401);
    expect(h.resumed).toHaveLength(0);
  });

  it('refuses an operation that was never admitted, even after the exchange sealed a grant', async () => {
    const h = await setup();
    await h.journal.approved();
    expect((await h.exchange()).status).toBe(200);
    const refused = await h.resume();
    expect(refused.status).toBe(409);
    expect((await refused.json() as { code: string }).code).toBe('operation_mismatch');
    expect(h.resumed).toHaveLength(0);
    // Unknown operations look the same.
    expect((await (await setup()).resume()).status).toBe(409);
  });

  it('refuses a body that disagrees with the authenticated connector', async () => {
    const h = await admitted();
    for (const override of [{ deviceId: 'device_other' }, { sessionGeneration: 4 }, { origin: 'https://evil.example' }]) {
      expect((await h.resume(override)).status).toBe(409);
    }
    expect((await h.resume({ extra: true })).status).toBe(400);
    expect(h.resumed).toHaveLength(0);
  });

  it('serves the seven-day recovery window and fails closed after it', async () => {
    const h = await admitted();
    h.journal.setNow(T0 + 6 * 24 * 60 * 60_000);
    expect((await h.resume()).status).toBe(200);
    h.journal.setNow(T0 + CHANNEL_ACCESS_ENVELOPE_RECOVERY_MS);
    const expired = await h.resume();
    expect(expired.status).toBe(410);
    expect((await expired.json() as { code: string }).code).toBe('expired');
    expect(h.resumed).toHaveLength(1);
  });

  it('fails closed on requester revocation, ownership loss and a revoked binding', async () => {
    const revoked = await admitted();
    revoked.journal.state.requester = 'revoked';
    expect((await revoked.resume()).status).toBe(410);
    expect(revoked.resumed).toHaveLength(0);

    const lost = await admitted();
    lost.journal.state.access = { kind: 'revoked' } as never;
    expect((await lost.resume()).status).toBe(410);
    expect(lost.resumed).toHaveLength(0);

    const binding = await admitted();
    binding.bindingState.revoked = true;
    const refused = await binding.resume();
    expect(refused.status).toBe(410);
    expect((await refused.json() as { code: string }).code).toBe('closed');
  });

  it('has nothing to resume once readiness was acknowledged', async () => {
    const h = await admitted();
    expect((await h.ready()).status).toBe(200);
    expect((await h.resume()).status).toBe(410);
    expect(h.resumed).toHaveLength(0);
  });
});

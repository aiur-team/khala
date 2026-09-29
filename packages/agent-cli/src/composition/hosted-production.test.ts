import { generateKeyPairSync } from 'node:crypto';
import { createProofSigner, decodeActivationRecord, type ChannelAccessActivationStore } from '@khala/connector/bootstrap/index';
import type { DiscoveryCredential, GrantExchangeRequest, SessionBinding } from '@khala/contracts/messaging/index';
import sodium from 'libsodium-wrappers';
import { describe, expect, it, vi } from 'vitest';
import { hostedAppOrigin, hostedSessionFactory } from './hosted-production.js';
import type { OpenProductionConnector } from './hosted-production.js';
import type { AgentClientPort } from '../cli/types.js';

const SESSION = { harness: 'codex', sessionId: '01a0b66b-ce0c-7ee3-823e-14ecdb9f2856' };

describe('installed hosted connector factory', () => {
  it('drives an approved native connect through exchange, redeem, durable resume and ready', async () => {
    const origin = 'https://khala.aiur.team';
    const signer = createProofSigner(generateKeyPairSync('ed25519').privateKey);
    const principal = `agent_${signer.jkt}` as DiscoveryCredential['requester']['principal'];
    const credential = { credentialRef: 'credential_ref', requester: { principal, origin, sessionGeneration: 0,
      proofKey: { algorithm: 'Ed25519', publicKey: signer.publicKey, thumbprint: signer.jkt } } } as DiscoveryCredential;
    const discovery = { current: () => credential, authorize: async () => ({ kind: 'authorized' as const, credential }),
      refresh: async () => ({ kind: 'missing' as const }), invalidate() {} };
    const rows = new Map<string, { record: string; revision: number; recoveryKey: Uint8Array | null }>();
    const journal: ChannelAccessActivationStore = {
      async load(id) { const row = rows.get(id); return row ? { kind: 'record', record: decodeActivationRecord(JSON.parse(row.record))!,
        revision: row.revision, recoveryKey: row.recoveryKey } : { kind: 'absent' }; },
      async save(record, revision, key) {
        const prior = rows.get(record.operationId);
        if ((prior?.revision ?? null) !== revision) return { kind: 'conflict' };
        rows.set(record.operationId, { record: JSON.stringify(record), revision: (prior?.revision ?? 0) + 1,
          recoveryKey: key.kind === 'set' ? key.privateKey : key.kind === 'clear' ? null : prior?.recoveryKey ?? null });
        return { kind: 'saved', revision: (prior?.revision ?? 0) + 1 };
      },
      async listActive() { return [...rows.keys()]; },
    };
    const retained = new Map<string, { binding: SessionBinding; matrixSession: never }>();
    const ready = new Set<string>();
    const calls: string[] = [];
    let firstActivation = true;
    let grant = '';
    let admittedBinding: SessionBinding | null = null;
    let nativeAvailable = false;
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body),
      { status, headers: { 'content-type': 'application/json' } });
    const transport = (async (target: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(target));
      calls.push(url.pathname);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      if (url.pathname.endsWith('/request') || url.pathname.endsWith('/status'))
        return reply(url.pathname === '/api/agent/channel-link/request'
          ? { v: 1, kind: 'request', operationId: body?.operationId, outcome: 'approved' }
          : { v: 1, operationId: body?.operationId ?? url.searchParams.get('operationId'), outcome: 'approved' });
      if (url.pathname.endsWith('/exchange')) {
        const exchange = body as unknown as GrantExchangeRequest;
        await sodium.ready;
        grant = 'cagrant_' + 'A'.repeat(43);
        const payload = { v: 1, operationId: exchange.operationId, requester: exchange.requester, origin,
          sessionGeneration: exchange.sessionGeneration, deviceId: exchange.deviceId,
          proofKeyThumbprint: signer.jkt, recipientKeyThumbprint: exchange.encryptionKey.thumbprint,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), grant };
        const ciphertext = sodium.crypto_box_seal(sodium.from_string(JSON.stringify(payload)),
          sodium.from_base64(exchange.encryptionKey.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING));
        return reply({ v: 1, algorithm: 'crypto_box_seal_x25519_xsalsa20poly1305',
          recipientKeyThumbprint: exchange.encryptionKey.thumbprint,
          ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING) });
      }
      if (url.pathname.endsWith('/redeem') || url.pathname.endsWith('/resume')) {
        const deviceId = String(body?.device_id ?? body?.deviceId);
        if (url.pathname.endsWith('/redeem')) expect((init?.headers as Record<string, string>).authorization).toBe(`DPoP ${grant}`);
        const binding = { v: 1, bindingId: 'bnd_1', ownerId: 'owner_1', agentParticipantId: 'agent_1',
          deviceId, harness: 'proof-key', sessionId: principal, generation: 0 };
        admittedBinding = binding as unknown as SessionBinding;
        const matrixSession = { baseUrl: 'https://matrix.example', userId: '@agent:matrix.example', deviceId,
          accessToken: 'matrix-access-token', roomId: '!room:matrix.example',
          ownerUserId: '@owner:matrix.example', ownerParticipantId: `human_${'a'.repeat(40)}` };
        return reply({ binding, adapter_capability: { token: 'B'.repeat(43), token_type: 'DPoP',
          scope: ['publish_own', 'receive_released', 'ack_delivery'], binding_id: 'bnd_1', generation: 0,
          expires_at: Date.now() + 60_000 }, ...(url.pathname.endsWith('/redeem') ? { matrix_session: matrixSession } : {}) });
      }
      if (url.pathname.endsWith('/ready')) return reply({ v: 1, kind: 'acknowledged' });
      throw new Error('unexpected request');
    }) as typeof fetch;
    const openConnector: OpenProductionConnector = async () => ({
      ports: {} as never, proofSigner: signer,
      channelAccess: { journal,
        devices: { async reserve() { return { kind: 'reserved', deviceId: 'KHALA_device_1' }; },
          async activate(input) { expect(input.matrixSession?.deviceId).toBe(input.deviceId);
            if (firstActivation) { firstActivation = false; return { kind: 'unavailable' }; }
            ready.add(input.deviceId); return { kind: 'ready' }; },
          async status(id) { return ready.has(id) ? 'ready' : 'missing'; } },
        trust: { async initialize() { return { kind: 'initialized', mode: 'review', paused: false }; } },
        async admitted(id, value) { retained.set(id, value as never); },
        async recovered(id) { return retained.get(id) ?? null; } },
      async send(input) { return { kind: 'refused', code: 'not_connected', clientTxnId: input.clientTxnId }; },
      async status() { return nativeAvailable && admittedBinding
        ? { v: 1, connected: true, binding: admittedBinding, route: 'native_cli_queue', sourceCursor: null,
          readiness: { phase: 'ready', prerequisites: {} as never, errorCode: null } }
        : { v: 1, connected: false, binding: null, route: 'unavailable', sourceCursor: null }; },
      async listChannels() { return { kind: 'unavailable' }; }, async listAgents() { return { kind: 'unavailable' }; },
      async inbox() { throw new Error('no binding'); }, async close() {},
    });
    const factory = hostedSessionFactory({ openConnector, credentialClient: discovery, fetch: transport,
      stateDirectory: '/tmp/khala-state/hosted', appOrigin: origin,
      browserBundleDirectory: '/tmp/package/dist/substrate-browser', workdir: '/tmp/project',
      readVersion: async () => '0.154.0', inspectHooks: async () => null,
      resolveCodexExecutable: async () => '/usr/bin/codex',
      async openBrowser() {}, async openInbox() { throw new Error('no binding'); },
    });
    const opened = await factory(SESSION);
    const link = `${origin}/join/inviteRef123`;
    expect(await opened.client.connect(link)).toEqual({ kind: 'unavailable' });
    expect(await opened.client.connect(link)).toEqual({ kind: 'unavailable' });
    nativeAvailable = true;
    expect(await opened.client.connect(link)).toMatchObject({ kind: 'connected', binding: { bindingId: 'bnd_1' } });
    expect(calls).toContain('/api/agent/channel-access/exchange');
    expect(calls).toContain('/api/agent/bootstrap/redeem');
    expect(calls).toContain('/api/agent/channel-access/resume');
    expect(calls).toContain('/api/agent/channel-access/ready');
    expect(await opened.client.connect(`${origin}/channels/room-1`)).toEqual({ kind: 'refused', code: 'invalid_link' });
    await opened.close();
  });
  it('accepts only an exact configured HTTPS origin', () => {
    expect(hostedAppOrigin(undefined)).toBe('https://khala.aiur.team');
    expect(hostedAppOrigin('https://preview.example')).toBe('https://preview.example');
    for (const invalid of ['http://preview.example', 'https://preview.example/path', 'https://preview.example/',
      'https://user@preview.example', 'https://preview.example?x=1', 'not a URL']) {
      expect(() => hostedAppOrigin(invalid)).toThrow('invalid hosted origin');
    }
  });

  it('passes the provider session, native inspection, and endpoint-owned generation into one connector', async () => {
    const close = vi.fn(async () => undefined);
    const listeningModeControl = { read: vi.fn(), set: vi.fn() } as unknown as NonNullable<AgentClientPort['listeningModeControl']>;
    const openConnector = vi.fn<OpenProductionConnector>(async () => ({
      ports: {} as never,
      async send(input) { return { kind: 'refused', code: 'not_connected', clientTxnId: input.clientTxnId }; },
      async status() { return { v: 1, connected: false, binding: null, route: 'unavailable', sourceCursor: null }; },
      async listChannels() { return { kind: 'unavailable' }; },
      async listAgents() { return { kind: 'unavailable' }; },
      listeningModeControl,
      async inbox() { throw new Error('no binding'); },
      close,
    }));
    const factory = hostedSessionFactory({ openConnector,
      stateDirectory: '/tmp/khala-state/hosted', appOrigin: 'https://khala.aiur.team',
      browserBundleDirectory: '/tmp/package/dist/substrate-browser', workdir: '/tmp/project',
      readVersion: async () => '0.154.0', inspectHooks: async () => null,
      resolveCodexExecutable: async () => '/usr/bin/codex',
      async openBrowser() {}, async openInbox() { throw new Error('no binding'); },
    });
    const opened = await factory(SESSION);
    const input = openConnector.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      session: { ...SESSION, workdir: '/tmp/project' },
      stateDirectory: '/tmp/khala-state/hosted',
      browserBundleDirectory: '/tmp/package/dist/substrate-browser',
    });
    const generationFor = vi.fn(async () => 4);
    const inspected = input?.sessionInspection(generationFor);
    expect(await inspected?.inspect({ ...SESSION, workdir: '/tmp/project' })).toMatchObject({
      kind: 'verified', session: { ...SESSION, generation: 4 },
    });
    expect(generationFor).toHaveBeenCalledExactlyOnceWith({ ...SESSION, workdir: '/tmp/project' });
    expect(await input?.inspectHostedCodexHooks()).toBeNull();
    expect(await input?.resolveCodexExecutable()).toBe('/usr/bin/codex');
    expect((await opened.client.status()).connected).toBe(false);
    expect(opened.client.listeningModeControl).toBe(listeningModeControl);
    await opened.close();
    expect(close).toHaveBeenCalledOnce();
  });
});

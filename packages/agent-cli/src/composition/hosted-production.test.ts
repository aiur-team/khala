import { generateKeyPairSync } from 'node:crypto';
import { createProofSigner, decodeActivationRecord, type ChannelAccessActivationStore } from '@khala/connector/bootstrap/index';
import { type DiscoveryCredential, type GrantExchangeRequest, type SessionBinding } from '@khala/contracts/messaging/index';
import sodium from 'libsodium-wrappers';
import { describe, expect, it, vi } from 'vitest';
import { hostedAppOrigin, hostedSessionFactory } from './hosted-production.js';
import type { OpenProductionConnector } from './hosted-production.js';
import type { AgentClientPort } from '../cli/types.js';
import { ReadOperation } from './read.js';

const SESSION = { harness: 'codex', sessionId: '01a0b66b-ce0c-7ee3-823e-14ecdb9f2856' };

describe('installed hosted connector factory', () => {
  it('forwards a redacted connector-open stage to the hosted diagnostic sink', async () => {
    const diagnostics: unknown[] = [];
    const factory = hostedSessionFactory({
      openConnector: async input => {
        input.diagnostic?.({ stage: 'device_resume', result: 'unavailable' });
        throw new Error('private device and session detail');
      },
      stateDirectory: '/tmp/khala-state/hosted', appOrigin: 'https://khala.aiur.team',
      browserBundleDirectory: '/tmp/package/dist/substrate-browser', workdir: '/tmp/project',
      readVersion: async () => null, inspectHooks: async () => null,
      resolveCodexExecutable: async () => null, openBrowser: async () => undefined,
      openInbox: async () => { throw new Error('unused inbox'); },
      diagnostic: event => diagnostics.push(event),
    });
    await expect(factory(SESSION)).rejects.toThrow();
    expect(diagnostics).toEqual([{ component: 'hosted_open', stage: 'device_resume', result: 'unavailable' }]);
  });

  it('reports a fixed post-access decode stage without request identifiers', async () => {
    const origin = 'https://khala.aiur.team';
    const signer = createProofSigner(generateKeyPairSync('ed25519').privateKey);
    const credential = { credentialRef: 'secret', requester: { principal: `agent_${signer.jkt}`,
      origin, sessionGeneration: 0 } } as DiscoveryCredential;
    const diagnostics: unknown[] = [];
    const factory = hostedSessionFactory({
      openConnector: async () => ({ ports: {} as never, proofSigner: signer,
        async send(input) { return { kind: 'refused', code: 'not_connected', clientTxnId: input.clientTxnId }; },
        async status() { return { v: 1, connected: false, binding: null, route: 'unavailable', sourceCursor: null }; },
        async listChannels() { return { kind: 'unavailable' }; }, async listAgents() { return { kind: 'unavailable' }; },
        async inbox() { throw new Error('no binding'); }, async close() {} }),
      credentialClient: { current: () => credential, authorize: async () => ({ kind: 'authorized', credential }),
        refresh: async () => ({ kind: 'missing' }), invalidate() {} },
      fetch: async () => new Response(JSON.stringify({ v: 1, operationId: 'other-operation', outcome: 'approved' }),
        { status: 200, headers: { 'content-type': 'application/json' } }),
      stateDirectory: '/tmp/khala-state/hosted', appOrigin: origin,
      browserBundleDirectory: '/tmp/package/dist/substrate-browser', workdir: '/tmp/project',
      readVersion: async () => '0.159.2', inspectHooks: async () => null,
      resolveCodexExecutable: async () => null, async openBrowser() {},
      async openInbox() { throw new Error('no binding'); }, diagnostic: event => diagnostics.push(event),
    });
    const opened = await factory(SESSION);
    expect(await opened.client.channelAccessStatus?.({ operationId: 'requested-operation', origin }))
      .toEqual({ kind: 'unavailable' });
    expect(diagnostics).toEqual([{ component: 'activation', stage: 'status_decode', result: 'unavailable' }]);
    await opened.close();
  });

  it.each(['connect', 'create'] as const)('activates %s from a simulated approved status and retries a lost redeem response', async mode => {
    const origin = 'https://khala.aiur.team';
    const signer = createProofSigner(generateKeyPairSync('ed25519').privateKey);
    const principal = `agent_${signer.jkt}` as DiscoveryCredential['requester']['principal'];
    const credential = { credentialRef: 'credential_ref', requester: { principal, origin, sessionGeneration: 0,
      proofKey: { algorithm: 'Ed25519', publicKey: signer.publicKey, thumbprint: signer.jkt } } } as DiscoveryCredential;
    let discovered = mode === 'create';
    let dropCurrent = false;
    let heldOrigin = origin;
    const heldCredential = () => ({ ...credential, requester: { ...credential.requester, origin: heldOrigin } });
    const discovery = { current: () => discovered && !dropCurrent ? heldCredential() : null, authorize: async () => {
      discovered = true;
      return { kind: 'authorized' as const, credential: heldCredential() };
    },
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
    let redeemed = false;
    let loseRedeemResponse = true;
    let recoveryReachable = false;
    let grants = 0;
    let matrixLogins = 0;
    let deviceReservations = 0;
    let deviceActivations = 0;
    const bindings = new Set<string>();
    let admittedBinding: SessionBinding | null = null;
    let nativeAvailable = false;
    let createApproved = false;
    let candidateApproved = false;
    let accessApproved = mode === 'create';
    let connectOperationId = '';
    const diagnostics: unknown[] = [];
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body),
      { status, headers: { 'content-type': 'application/json' } });
    const transport = (async (target: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(target));
      calls.push(url.pathname);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      if (url.pathname.endsWith('/authority/challenge')) return reply({ kind: 'issued', nonce: 'N'.repeat(43) });
      if (url.pathname.endsWith('/authority/candidate')) return reply({ kind: candidateApproved ? 'approved' : 'pending_owner',
        operationId: body?.operationId, candidateId: 'C'.repeat(43),
        approveUrl: `${origin}/api/human/channel-discovery/authority/approve?candidate=${'C'.repeat(43)}` }, candidateApproved ? 200 : 202);
      if (url.pathname === '/api/agent/channel-access/create')
        return reply({ v: 1, operationId: body?.operationId, outcome: 'pending_owner' });
      if (url.pathname.endsWith('/status') && url.searchParams.get('operationKind') === 'create')
        return reply({ v: 1, operationId: url.searchParams.get('operationId'),
          outcome: createApproved ? 'approved' : 'pending_owner' });
      if (url.pathname.endsWith('/request') || url.pathname.endsWith('/status'))
        return reply(url.pathname === '/api/agent/channel-link/request'
          ? { v: 1, kind: 'request', operationId: body?.operationId, outcome: accessApproved ? 'approved' : 'pending_owner' }
          : { v: 1, operationId: body?.operationId ?? url.searchParams.get('operationId'), outcome: 'approved' });
      if (url.pathname.endsWith('/exchange')) {
        const exchange = body as unknown as GrantExchangeRequest;
        await sodium.ready;
        if (!grant) grants++;
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
        if (url.pathname.endsWith('/resume') && !redeemed) {
          return reply({ v: 1, kind: 'rejected', code: 'operation_mismatch' }, 409);
        }
        if (url.pathname.endsWith('/resume') && !recoveryReachable) throw new TypeError('recovery temporarily unavailable');
        const deviceId = String(body?.device_id ?? body?.deviceId);
        if (url.pathname.endsWith('/redeem')) expect((init?.headers as Record<string, string>).authorization).toBe(`DPoP ${grant}`);
        if (url.pathname.endsWith('/redeem')) { redeemed = true; matrixLogins++; }
        const binding = { v: 1, bindingId: 'bnd_1', ownerId: 'owner_1', agentParticipantId: 'agent_1',
          deviceId, harness: 'proof-key', sessionId: principal, generation: 0 };
        bindings.add(binding.bindingId);
        admittedBinding = binding as unknown as SessionBinding;
        const matrixSession = { baseUrl: 'https://matrix.example', userId: '@agent:matrix.example', deviceId,
          accessToken: 'matrix-access-token', roomId: '!room:matrix.example',
          ownerUserId: '@owner:matrix.example', ownerParticipantId: `human_${'a'.repeat(40)}` };
        if (url.pathname.endsWith('/redeem') && loseRedeemResponse) {
          loseRedeemResponse = false;
          throw new TypeError('connection lost after redemption');
        }
        const admission = { binding, adapter_capability: { token: 'B'.repeat(43), token_type: 'DPoP',
          scope: ['publish_own', 'receive_released', 'ack_delivery'], binding_id: 'bnd_1', generation: 0,
          expires_at: Date.now() + 60_000 }, matrix_session: matrixSession };
        return reply(admission);
      }
      if (url.pathname.endsWith('/ready')) return reply({ v: 1, kind: 'acknowledged' });
      throw new Error('unexpected request');
    }) as typeof fetch;
    const openConnector: OpenProductionConnector = async () => ({
      ports: { sessions: { async inspect() { return { kind: 'verified', session: { ...SESSION, generation: 0 } }; } } } as never, proofSigner: signer,
      channelAccess: { journal,
        devices: { async reserve() { deviceReservations++; return { kind: 'reserved', deviceId: 'KHALA_device_1' }; },
          async activate(input) { expect(input.matrixSession?.deviceId).toBe(input.deviceId);
            deviceActivations++;
            if (firstActivation) { firstActivation = false; return { kind: 'unavailable' }; }
            ready.add(input.deviceId); return { kind: 'ready' }; },
          async status(id) { return ready.has(id) ? 'ready' : 'missing'; } },
        trust: { async initialize() { return { kind: 'initialized', mode: 'review', paused: false }; } },
        async admitted(id, value) { retained.set(id, value as never); },
        async recovered(id) { return retained.get(id) ?? null; } },
      async send(input) { return nativeAvailable && admittedBinding
        ? { kind: 'accepted', clientTxnId: input.clientTxnId, eventId: 'event-1' }
        : { kind: 'refused', code: 'not_connected', clientTxnId: input.clientTxnId }; },
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
      diagnostic: event => diagnostics.push(event),
      async openBrowser() {}, async openInbox() { throw new Error('no binding'); },
    });
    const opened = await factory(SESSION);
    if (mode === 'create') {
      expect(await opened.client.requestChannelCreate?.({ title: 'Planning', operationId: 'create_123', origin }))
        .toEqual({ kind: 'status', status: { v: 1, operationId: 'create_123', outcome: 'pending_owner' } });
      expect(calls).toContain('/api/agent/channel-access/create');
    }
    const link = `${origin}/join/inviteRef123`;
    if (mode === 'connect') {
      const first = await opened.client.connect(link);
      expect(first).toMatchObject({ kind: 'pending', outcome: 'pending_owner' });
      if (first.kind !== 'pending') throw new Error('expected pending connect');
      connectOperationId = first.operationId;
      expect(discovered).toBe(false);
      expect(calls).not.toContain('/api/agent/channel-access/exchange');
      expect(rows.size).toBe(0);
      expect(deviceReservations).toBe(0);
      expect(deviceActivations).toBe(0);
      candidateApproved = true;
      expect(await opened.client.connect(link)).toEqual(first);
      expect(discovered).toBe(true);
      expect(calls).toContain('/api/agent/channel-link/request');
      expect(calls).not.toContain('/api/agent/channel-access/exchange');
      expect(deviceReservations).toBe(0);
      expect(deviceActivations).toBe(0);
      accessApproved = true;
      await opened.client.connect(link);
    }
    else {
      expect(await opened.client.channelCreateStatus?.({ operationId: 'create_123', origin }))
        .toEqual({ kind: 'status', status: { v: 1, operationId: 'create_123', outcome: 'pending_owner' } });
      expect(calls).not.toContain('/api/agent/channel-access/exchange');
      // The control composition tests own signed-in authorization. This transport
      // supplies a synthetic approved status to exercise only the packaged client.
      createApproved = true;
      await opened.client.channelCreateStatus?.({ operationId: 'create_123', origin });
    }
    const beforeRestart = [...rows.values()].map(row => decodeActivationRecord(JSON.parse(row.record))!);
    expect(beforeRestart).toContainEqual(expect.objectContaining({ phase: 'keyed', binding: null, deviceId: 'KHALA_device_1' }));
    expect(retained.size).toBe(0);
    expect(grants).toBe(1);
    expect(matrixLogins).toBe(1);
    expect(diagnostics).toContainEqual({ component: 'activation', stage: 'resume', result: 'unavailable' });
    await opened.close();
    recoveryReachable = true;
    const restarted = await factory(SESSION);
    if (mode === 'connect') await restarted.client.connect(link);
    else await restarted.client.channelCreateStatus?.({ operationId: 'create_123', origin });
    expect([...retained.values()][0]).toMatchObject({ binding: { bindingId: 'bnd_1' },
      matrixSession: { deviceId: 'KHALA_device_1', accessToken: 'matrix-access-token' } });
    nativeAvailable = true;
    if (mode === 'connect') {
      expect(await restarted.client.connect(link)).toMatchObject({ kind: 'connected', binding: { bindingId: 'bnd_1' } });
    } else {
      expect(await restarted.client.channelCreateStatus?.({ operationId: 'create_123', origin }))
        .toEqual({ kind: 'status', status: { v: 1, operationId: 'create_123', outcome: 'connected' } });
    }
    expect(calls).toContain('/api/agent/channel-access/exchange');
    expect(calls).toContain('/api/agent/bootstrap/redeem');
    expect(calls).toContain('/api/agent/channel-access/resume');
    expect(calls).toContain('/api/agent/channel-access/ready');
    expect(calls.filter(path => path === '/api/agent/bootstrap/redeem')).toHaveLength(1);
    expect(calls.filter(path => path === '/api/agent/channel-access/exchange')).toHaveLength(1);
    expect(grants).toBe(1);
    expect(matrixLogins).toBe(1);
    expect([...bindings]).toEqual(['bnd_1']);
    expect((await restarted.client.status()).binding?.bindingId).toBe('bnd_1');
    if (mode === 'connect') expect(await restarted.client.send({ bindingId: (await restarted.client.status()).binding!.bindingId,
      clientTxnId: 'txn-1', body: 'hello' }))
      .toEqual({ kind: 'accepted', clientTxnId: 'txn-1', eventId: 'event-1' });
    if (mode === 'connect') {
      const heldBinding = (await restarted.client.status()).binding!;
      const read = new ReadOperation({ heldBinding,
        consumer: { async readBatch() { return { token: 'batch-1', items: [] }; }, async release() {} },
        currentBinding: async () => (await restarted.client.status()).binding });
      expect(await read.read({ bindingId: heldBinding.bindingId, maxBytes: 1024 }))
        .toEqual({ kind: 'batch', batch: { token: 'batch-1', items: [] } });
    }
    if (mode === 'connect') {
      const exchangeCount = calls.filter(path => path.endsWith('/exchange')).length;
      dropCurrent = true;
      expect(await restarted.client.connect(link)).toEqual({ kind: 'unavailable' });
      expect(diagnostics).toContainEqual({ component: 'activation', stage: 'activation_no_credential', result: 'unavailable' });
      expect(calls.filter(path => path.endsWith('/exchange'))).toHaveLength(exchangeCount);
      expect(JSON.stringify(diagnostics)).not.toContain(link);
      expect(JSON.stringify(diagnostics)).not.toContain(credential.credentialRef);
      dropCurrent = false;
      heldOrigin = 'https://other.example';
      expect(await restarted.client.channelAccessStatus?.({ operationId: connectOperationId, origin }))
        .toEqual({ kind: 'unavailable' });
      expect(diagnostics).toContainEqual({ component: 'activation', stage: 'activation_origin_mismatch', result: 'unavailable' });
      expect(calls.filter(path => path.endsWith('/exchange'))).toHaveLength(exchangeCount);
      heldOrigin = origin;
      const row = rows.get(connectOperationId)!;
      rows.set(connectOperationId, { ...row, record: JSON.stringify({ ...JSON.parse(row.record) as object,
        origin: 'https://other.example' }) });
      expect(await restarted.client.connect(link)).toEqual({ kind: 'unavailable' });
      expect(diagnostics).toContainEqual({ component: 'activation', stage: 'journal_conflict', result: 'unavailable' });
      expect(calls.filter(path => path.endsWith('/exchange'))).toHaveLength(exchangeCount);
    }
    if (mode === 'connect') {
      expect(await restarted.client.connect(`${origin}/channels/room-1`)).toEqual({ kind: 'refused', code: 'invalid_link' });
      expect(await restarted.client.connect('https://other.example/join/inviteRef123'))
        .toEqual({ kind: 'refused', code: 'untrusted_origin' });
    }
    await restarted.close();
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

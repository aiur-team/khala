import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { decodeDeliveryLimits, type SessionBinding } from '@khala/contracts/delivery/index';
import { openConnectorStorage } from '@khala/connector/storage/open';
import { createBootstrapPersistence } from '@khala/connector/storage/bootstrap';
import { createCapabilityRenewal } from './agent/capability-renewal';
import { nativeCliCapabilities } from '@khala/harnesses/codex/capabilities';
import type { MatrixConnectorInput, MatrixConnectorSubstrate } from '../substrate/matrix';
import { revocationStopId } from '../../../control/src/composition/human/revocation-cleanup';
import { createLocalClosureFence } from './closure/local-fence';
import { openTrustStateStore } from './controls/trust-store';
import { hasProductionBinding, openProductionConnector, subscriptionDiagnostic, supportedBrowserVersion } from './production';

describe('installed hosted connector composition', () => {
  it('reopens an active hosted proof-key binding on the same native session and Matrix device', async () => {
    const directory = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-active-restart-'));
    const session = { harness: 'codex' as const, sessionId: 'thread-active-1', workdir: '/project' };
    const sessionDirectory = path.join(directory, createHash('sha256').update(JSON.stringify([
      'khala.hosted.session.v1', session.harness, session.sessionId, session.workdir,
    ])).digest('hex'));
    const stateDirectory = path.join(sessionDirectory, 'state');
    const appOrigin = 'https://khala.aiur.team';
    const matrixUserId = '@active-agent:example';
    const roomId = '!active:example';
    const deviceId = 'DEVICE_ACTIVE';
    const read = vi.fn(async () => ({ kind: 'page' as const, events: [], nextCursor: 'cursor-1', caughtUp: true }));
    const send = vi.fn(async (_clientTxnId: string, _body: string) => ({ eventId: '$sent:example' }));
    const opens: MatrixConnectorInput[] = [];
    const openMatrix = async (options: MatrixConnectorInput): Promise<MatrixConnectorSubstrate> => {
      opens.push(options);
      return { fingerprint: 'active-device-fingerprint',
        devices: { reserve: async () => ({ kind: 'reserved', deviceId }),
          activate: async () => ({ kind: 'ready' }), status: async () => 'ready' },
        source: { authorize: async () => 'ok', listen: () => () => undefined, read },
        send, trustPeer: async () => undefined, removeOwnDevice: async () => 'removed',
        discardOutboundSession: async () => true, close: async () => undefined };
    };
    const limits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
    if (!limits.ok) throw new Error('test limits invalid');
    let binding: SessionBinding;
    const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200,
      headers: { 'content-type': 'application/json' } });
    try {
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      const storage = await openConnectorStorage({ directory: stateDirectory, mode: 'create', limits: limits.value });
      const trust = await openTrustStateStore({ directory: stateDirectory, mode: 'create' });
      const { signer } = await createBootstrapPersistence(storage);
      binding = { v: 1, bindingId: 'binding-active-restart', ownerId: 'owner-active',
        agentParticipantId: `agent_${createHash('sha256').update(matrixUserId).digest('hex').slice(0, 40)}`,
        deviceId, harness: 'proof-key', sessionId: `agent_${signer.jkt}`, generation: 0 } as SessionBinding;
      expect((await storage.ledger.transaction(tx => tx.putBinding(binding))).kind).toBe('inserted');
      await createCapabilityRenewal({ stateDirectory: sessionDirectory, appOrigin, binding, signer })
        .acceptInitial({ token: 'C'.repeat(43), bindingId: binding.bindingId, generation: 0,
          scope: ['publish_own', 'receive_released', 'ack_delivery'], expiresAt: Date.now() + 3_600_000 });
      await storage.close();
      trust.close();
      await writeFile(path.join(sessionDirectory, 'current-binding.json'), JSON.stringify(binding));
      await writeFile(path.join(sessionDirectory, 'matrix-reservation.json'), JSON.stringify({
        operationId: 'approved-operation', deviceId }));
      await writeFile(path.join(sessionDirectory, 'matrix-session.json'), JSON.stringify({
        baseUrl: 'https://matrix.example', userId: matrixUserId, deviceId,
        accessToken: 'exact-device-access-token', roomId, ownerUserId: '@owner:example',
        ownerParticipantId: 'owner_participant',
      }));
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname.endsWith('/owner-mailbox/poll')) return reply({ v: 1,
          bindingId: binding.bindingId, generation: 0, closing: false, entries: [] });
        if (pathname.endsWith('/owner-device-proof/lookup')) return reply({ v: 1, roomId,
          devices: [{ deviceId: 'OWNER_DEVICE', fingerprint: 'B'.repeat(43) }] });
        if (pathname.endsWith('/room-send/ready') || pathname.endsWith('/room-send/finish')) return reply({ kind: 'applied' });
        if (pathname.endsWith('/room-send/acquire')) return reply({ kind: 'granted', permitId: 'permit-1' });
        if (pathname.endsWith('/room-send/inspect')) return reply({ kind: 'ok', hold: null });
        throw new Error(`unexpected ${pathname}`);
      }));
      const input = { stateDirectory: directory, appOrigin,
        browserBundleDirectory: path.join(directory, 'missing-matrix-browser'), session, openMatrix,
        sessionInspection: () => ({ inspect: async () => ({ kind: 'verified' as const,
          session: { harness: 'codex' as const, sessionId: session.sessionId, generation: 0 },
          capabilities: nativeCliCapabilities('0.154.0', limits.value) }) }),
        inspectHostedCodexHooks: async () => ({ ...nativeCliCapabilities('0.154.0', limits.value),
          modes: { steer: { status: 'unknown', route: 'unproven', evidenceRef: null,
            evidenceRevision: null, reason: 'unproven' },
            sync: { status: 'proven', route: 'codex-hook', testedVersion: '0.154.0',
              evidenceRef: 'hook-proof', evidenceRevision: 'hook-revision', reason: null },
            async: { status: 'unknown', route: 'unproven', evidenceRef: null,
              evidenceRevision: null, reason: 'unproven' } } }), resolveCodexExecutable: async () => null,
        openBrowser: async () => undefined,
        openInbox: async () => ({ enqueue: async () => 'appended' as const,
          notifyListener: async () => 'notified' as const }) };
      const first = await openProductionConnector(input);
      await vi.waitFor(() => expect(read).toHaveBeenCalled());
      expect(await first.status()).toMatchObject({ connected: true,
        readiness: { prerequisites: { harness: 'ready' } } });
      expect((await first.send({ bindingId: binding.bindingId, clientTxnId: 'first-send', body: 'before restart' })).kind)
        .toBe('accepted');
      await first.close();
      const restarted = await openProductionConnector(input);
      try {
        await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(1));
        expect(opens).toHaveLength(2);
        expect(opens.map(value => value.deviceId)).toEqual([deviceId, deviceId]);
        expect(await restarted.status()).toMatchObject({ connected: true,
          readiness: { prerequisites: { harness: 'ready' } } });
        expect((await restarted.send({ bindingId: binding.bindingId, clientTxnId: 'second-send', body: 'after restart' })).kind)
          .toBe('accepted');
        expect(send.mock.calls.map(call => call[1])).toEqual(['before restart', 'after restart']);
      } finally { await restarted.close(); }
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([
    { removalState: 'removed', proofKey: false },
    { removalState: 'unreported', proofKey: false },
    { removalState: 'removed', proofKey: true },
  ] as const)(
    'restarts a locally stopped binding for cleanup with removal $removalState and proof key $proofKey', async ({ removalState, proofKey }) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-revoked-restart-'));
    const session = { harness: 'codex' as const, sessionId: 'thread-revoked-1', workdir: '/project' };
    const sessionDirectory = path.join(directory, createHash('sha256').update(JSON.stringify([
      'khala.hosted.session.v1', session.harness, session.sessionId, session.workdir,
    ])).digest('hex'));
    const stateDirectory = path.join(sessionDirectory, 'state');
    const appOrigin = 'https://khala.aiur.team';
    const matrixUserId = '@khala_agent:example';
    const roomId = '!revoked:example';
    let binding = { v: 1, bindingId: 'binding-revoked-restart', ownerId: 'owner-revoked',
      agentParticipantId: `agent_${createHash('sha256').update(matrixUserId).digest('hex').slice(0, 40)}`,
      deviceId: 'DEVICE_REVOKED', harness: session.harness, sessionId: session.sessionId,
      generation: 2 } as SessionBinding;
    const revokeId = revocationStopId('revocation-restart', binding.bindingId);
    const input = { stateDirectory: directory, appOrigin,
      browserBundleDirectory: path.join(directory, 'missing-matrix-browser'), session,
      sessionInspection: () => ({ inspect: async () => ({ kind: 'missing' as const }) }),
      inspectHostedCodexHooks: vi.fn(async () => null), resolveCodexExecutable: vi.fn(async () => null),
      openBrowser: vi.fn(async () => undefined), openInbox: vi.fn(async () => undefined) };
    const requests: Array<{ method: string; path: string; bindingHint: string | null;
      payload: Record<string, unknown> | null }> = [];
    const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200,
      headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const payload = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      requests.push({ method: init?.method ?? 'GET', path: new URL(String(url)).pathname,
        bindingHint: new Headers(init?.headers).get('x-khala-binding-id'), payload });
      if (new URL(String(url)).pathname.endsWith('/cleanup')) return reply({ v: 1,
        operationId: 'revocation-restart', deviceId: binding.deviceId, deviceKey: 'B'.repeat(43),
        generation: binding.generation, removal: removalState === 'removed' ? 'removed' : null });
      return reply({ v: 1, operationId: 'revocation-restart', removal: payload?.removal });
    }));
    try {
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      const limits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
      if (!limits.ok) throw new Error('test limits invalid');
      const storage = await openConnectorStorage({ directory: stateDirectory, mode: 'create', limits: limits.value });
      const trust = await openTrustStateStore({ directory: stateDirectory, mode: 'create' });
      const { signer } = await createBootstrapPersistence(storage);
      if (proofKey) binding = { ...binding, harness: 'proof-key', sessionId: `agent_${signer.jkt}` };
      expect((await storage.ledger.transaction(tx => tx.putBinding(binding))).kind).toBe('inserted');
      await createCapabilityRenewal({ stateDirectory: sessionDirectory, appOrigin, binding, signer,
        clock: () => Date.now() - 7_200_000 }).acceptInitial({
        token: 'C'.repeat(43), bindingId: binding.bindingId, generation: binding.generation,
        scope: ['publish_own', 'receive_released', 'ack_delivery'], expiresAt: Date.now() - 3_600_000,
      });
      const stop = createLocalClosureFence({ storage, binding, roomId, stateDirectory: sessionDirectory,
        clock: Date.now, quiesce: async () => undefined });
      expect((await stop.stop({ operationId: revokeId, ownerId: binding.ownerId, roomId,
        expectedRoomRevision: 0 })).kind).toBe('stopped');
      await storage.close();
      trust.close();
      await writeFile(path.join(sessionDirectory, 'current-binding.json'), JSON.stringify(binding));
      await writeFile(path.join(sessionDirectory, 'matrix-session.json'), JSON.stringify({
        baseUrl: 'http://127.0.0.1:9', userId: matrixUserId, deviceId: binding.deviceId,
        accessToken: 'offline-device-token-123456', roomId, ownerUserId: '@owner:example',
        ownerParticipantId: 'owner_participant',
      }));
      const opened = await openProductionConnector(input);
      await vi.waitFor(() => expect(requests.some(item => item.path.endsWith('/result'))).toBe(true));
      expect(requests.map(item => item.path)).toEqual([
        '/api/agent/revocation/cleanup', '/api/agent/revocation/result',
      ]);
      expect(requests.map(item => item.bindingHint)).toEqual([binding.bindingId, binding.bindingId]);
      expect(requests[1]?.payload).toMatchObject({ operationId: 'revocation-restart',
        removal: null, localStop: { operationId: revokeId, bindingId: binding.bindingId,
          bindingGeneration: binding.generation, roomId, state: 'stopped' } });
      if (removalState === 'unreported') {
        // The Matrix device is unavailable after removal; no successful
        // exact-device result can be invented from that absence.
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(requests.filter(item => item.payload?.removal === 'removed')).toHaveLength(0);
      }
      expect(await opened.status()).toMatchObject({ connected: false });
      expect((await opened.send({ bindingId: binding.bindingId, clientTxnId: 'after-restart', body: 'blocked' })).kind)
        .toBe('refused');
      expect(() => opened.inbox()).toThrow('production_binding_revoked');
      expect(await opened.ports.devices.status(binding.deviceId)).toBe('unavailable');
      expect(input.openInbox).not.toHaveBeenCalled();
      expect(input.inspectHostedCodexHooks).not.toHaveBeenCalled();
      await opened.close();
      const markerDirectory = path.join(sessionDirectory, 'closure-cleanup');
      const [marker] = await readdir(markerDirectory);
      expect(marker).toMatch(/^[a-f0-9]{64}\.json$/u);
      await rm(path.join(markerDirectory, marker!));
      const before = requests.length;
      await expect(openProductionConnector(input)).rejects.toThrow('production_binding_revoked');
      expect(requests).toHaveLength(before);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('checks only an exact admitted session marker without creating hosted state', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-hosted-presence-'));
    const first = { harness: 'codex', sessionId: 'thread-1', workdir: '/project' };
    const other = { ...first, sessionId: 'thread-2' };
    try {
      expect(await hasProductionBinding(directory, first)).toBe(false);
      expect(await readdir(directory)).toEqual([]);
      const opened = await openProductionConnector({ stateDirectory: directory,
        appOrigin: 'https://khala.aiur.team', browserBundleDirectory: path.join(directory, 'substrate-browser'),
        session: first, sessionInspection: () => ({ inspect: async () => ({ kind: 'missing' as const }) }),
        inspectHostedCodexHooks: async () => null, resolveCodexExecutable: async () => null,
        openBrowser: async () => undefined, openInbox: async () => undefined });
      await opened.close();
      // A pending pair has state, but ordinary tools and hooks still need an admitted binding.
      expect(await hasProductionBinding(directory, first)).toBe(false);
      const [session] = await readdir(directory);
      const marker = path.join(directory, session!, 'current-binding.json');
      await writeFile(marker, '{}');
      expect(await hasProductionBinding(directory, first)).toBe(true);
      expect(await hasProductionBinding(directory, other)).toBe(false);
      await rm(marker);
      await mkdir(path.join(directory, 'target'));
      await symlink(path.join(directory, 'target'), marker);
      expect(await hasProductionBinding(directory, first)).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('distinguishes offline recovery, unsupported substrate, and unknown catch-up from live intake', () => {
    expect(subscriptionDiagnostic({ kind: 'offline', retryAt: null })).toEqual({
      prerequisite: 'offline', errorCode: 'subscription_offline',
    });
    expect(subscriptionDiagnostic({ kind: 'blocked', code: 'unsupported' })).toEqual({
      prerequisite: 'unsupported', errorCode: 'subscription_unsupported',
    });
    expect(subscriptionDiagnostic({ kind: 'blocked', code: 'missing_keys' })).toEqual({
      prerequisite: 'blocked', errorCode: 'subscription_missing_keys',
    });
    expect(subscriptionDiagnostic({ kind: 'catching_up', streamId: 'stream-1' })).toEqual({
      prerequisite: 'unknown', errorCode: 'subscription_starting',
    });
    expect(subscriptionDiagnostic({ kind: 'live', streamId: 'stream-1' })).toBeNull();
  });
  it('admits only the browser majors proven with the pinned driver', () => {
    expect(supportedBrowserVersion('Chromium 150.0.7871.128')).toBe(true);
    expect(supportedBrowserVersion('Google Chrome for Testing 153.0.8010.12')).toBe(true);
    expect(supportedBrowserVersion('Chromium 120.0.0.0')).toBe(false);
    expect(supportedBrowserVersion('Firefox 153.0')).toBe(false);
  });
  it('pins one durable proof key to the same provider-named native session across restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-hosted-production-'));
    const input = { stateDirectory: directory, appOrigin: 'https://khala.aiur.team',
      browserBundleDirectory: path.join(directory, 'substrate-browser'),
      session: { harness: 'codex', sessionId: 'thread-owned-1', workdir: '/project' },
      sessionInspection: () => ({ inspect: async () => ({ kind: 'missing' as const }) }),
      inspectHostedCodexHooks: async () => null, resolveCodexExecutable: async () => null,
      openBrowser: async () => undefined,
      openInbox: async () => undefined };
    try {
      const first = await openProductionConnector(input);
      const key = first.ports.pairing?.jkt;
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(await first.status()).toMatchObject({ connected: false, binding: null, readiness: {
        phase: 'degraded', errorCode: 'binding_not_established', prerequisites: {
          storage: 'ready', device: 'blocked', bootstrap: 'blocked',
          harness: 'unknown', dispatch: 'blocked', recovery: 'unknown',
        },
      } });
      await first.close();
      expect(await first.status()).toMatchObject({ connected: false, readiness: {
        phase: 'stopped', errorCode: 'connector_closed', prerequisites: { storage: 'offline' },
      } });
      const restarted = await openProductionConnector(input);
      expect(restarted.ports.pairing?.jkt).toBe(key);
      await restarted.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('refuses an origin that could redirect consent or DPoP authority', async () => {
    await expect(openProductionConnector({ stateDirectory: '/tmp/khala-invalid',
      appOrigin: 'https://khala.aiur.team/path', browserBundleDirectory: '/tmp/bundle',
      session: { harness: 'codex', sessionId: 'thread-owned-1', workdir: '/project' },
      sessionInspection: () => ({ inspect: async () => ({ kind: 'missing' as const }) }),
      inspectHostedCodexHooks: async () => null, resolveCodexExecutable: async () => null,
      openBrowser: async () => undefined,
      openInbox: async () => undefined,
    })).rejects.toThrow('production_origin_invalid');
  });

  it('refuses a relative browser executable supplied by the installed launcher', async () => {
    await expect(openProductionConnector({ stateDirectory: '/tmp/khala-invalid',
      appOrigin: 'https://khala.aiur.team', browserBundleDirectory: '/tmp/bundle',
      chromiumExecutablePath: '../browser/chrome',
      session: { harness: 'codex', sessionId: 'thread-owned-1', workdir: '/project' },
      sessionInspection: () => ({ inspect: async () => ({ kind: 'missing' as const }) }),
      inspectHostedCodexHooks: async () => null, resolveCodexExecutable: async () => null,
      openBrowser: async () => undefined,
      openInbox: async () => undefined,
    })).rejects.toThrow('production_path_invalid');
  });
});

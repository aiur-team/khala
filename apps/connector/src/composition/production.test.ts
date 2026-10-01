import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeDeliveryLimits, type SessionBinding } from '@khala/contracts/delivery/index';
import { openConnectorStorage } from '@khala/connector/storage/open';
import { createBootstrapPersistence } from '@khala/connector/storage/bootstrap';
import { createConnectorDispatchStorage } from '@khala/connector/storage/dispatch';
import { sha256Digest } from '@khala/connector/storage/payloads';
import { createCapabilityRenewal } from './agent/capability-renewal';
import { nativeCliCapabilities } from '@khala/harnesses/codex/capabilities';
import type { MatrixConnectorInput, MatrixConnectorSubstrate } from '../substrate/matrix';
import { MatrixWriterLockError } from '../substrate/matrix-writer-lock';
import { revocationStopId } from '../../../control/src/composition/human/revocation-cleanup';
import { createLocalClosureFence } from './closure/local-fence';
import { openTrustStateStore } from './controls/trust-store';
import { hasProductionBinding, openProductionConnector, pollOwnerMailboxBeforeRotation, subscriptionDiagnostic, supportedBrowserVersion } from './production';
import { publicStatus } from '../../../../packages/agent-cli/src/cli/runtime';
import { openInbox, type OpenInboxOptions } from '../../../../packages/agent-cli/src/cli/inbox';
import { encodeMessageContent } from '@khala/contracts/messaging/events';

describe('installed hosted connector composition', () => {
  it('polls owner commands before slow rotation inspection and keeps polling after rotation failure', async () => {
    const order: string[] = [];
    let releaseRotation: (() => void) | null = null;
    const diagnostic = vi.fn();
    const mailbox = { pollOnce: vi.fn(async () => { order.push('mailbox'); return 'ok' as const; }) };
    const roomSend = { pollRotation: vi.fn(async () => {
      order.push('rotation');
      await new Promise<void>(resolve => { releaseRotation = resolve; });
      throw new Error('private rotation failure');
    }) };
    const polling = pollOwnerMailboxBeforeRotation(mailbox, roomSend, diagnostic);
    await vi.waitFor(() => expect(releaseRotation).not.toBeNull());
    expect(order).toEqual(['mailbox', 'rotation']);
    releaseRotation!();
    expect(await polling).toBe('ok');
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ stage: 'mailbox_rotation', result: 'unavailable' });
  });

  let chromiumFixtureDirectory: string;
  let chromiumExecutablePath: string;
  const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
  const getgid = Object.getOwnPropertyDescriptor(process, 'getgid');
  beforeAll(async () => {
    Object.defineProperty(process, 'getuid', { configurable: true, value: undefined });
    Object.defineProperty(process, 'getgid', { configurable: true, value: undefined });
    chromiumFixtureDirectory = await mkdtemp(path.join(os.tmpdir(), 'khala-test-chromium-'));
    chromiumExecutablePath = path.join(chromiumFixtureDirectory, 'chromium');
    await writeFile(chromiumExecutablePath, '#!/bin/sh\nprintf "Chromium 153.0.0.0\\n"\n', { mode: 0o700 });
  });
  afterAll(async () => {
    await rm(chromiumFixtureDirectory, { recursive: true, force: true });
    if (getuid) Object.defineProperty(process, 'getuid', getuid);
    if (getgid) Object.defineProperty(process, 'getgid', getgid);
  });

  it('reports only a fixed storage stage and code when a second connector cannot open', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-open-diagnostic-'));
    const diagnostics: unknown[] = [];
    const input = { stateDirectory: directory, appOrigin: 'https://khala.aiur.team',
      chromiumExecutablePath, browserBundleDirectory: path.join(directory, 'unused-browser'),
      session: { harness: 'claude', sessionId: 'owned-session', workdir: '/project' },
      sessionInspection: () => ({ inspect: async () => ({ kind: 'missing' as const }) }),
      inspectHostedCodexHooks: async () => null, resolveCodexExecutable: async () => null,
      openBrowser: async () => undefined, openInbox: async () => undefined,
      diagnostic: (event: unknown) => diagnostics.push(event),
    };
    try {
      const first = await openProductionConnector(input);
      try {
        await expect(openProductionConnector(input)).rejects.toThrow();
        expect(diagnostics).toEqual([{ stage: 'state_storage', result: 'unavailable', errorCode: 'locked' }]);
      } finally { await first.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('forwards active and recovered writer-lock stages through the installed diagnostic sink', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-writer-diagnostic-'));
    const session = { harness: 'codex', sessionId: 'writer-diagnostic', workdir: '/project' };
    const sessionDirectory = path.join(directory, createHash('sha256').update(JSON.stringify([
      'khala.hosted.session.v1', session.harness, session.sessionId, session.workdir,
    ])).digest('hex'));
    const diagnostics: unknown[] = [];
    let attempts = 0;
    let selectedBrowser: string | undefined;
    const openMatrix = async (options: MatrixConnectorInput): Promise<MatrixConnectorSubstrate> => {
      selectedBrowser = options.chromiumExecutablePath;
      if (++attempts === 1) throw new MatrixWriterLockError('active_writer');
      return {
        fingerprint: 'signed-ed25519-fingerprint', writerLock: { kind: 'stale_recovered' },
        participantForDevice: () => null,
        reviewMembers: async () => null,
        devices: { reserve: async () => ({ kind: 'reserved', deviceId: options.deviceId }),
          activate: async () => ({ kind: 'ready' }), status: async () => 'ready' },
        source: { authorize: async () => 'ok', listen: () => () => undefined,
          read: async () => ({ kind: 'page', events: [], nextCursor: '', caughtUp: true }) },
        send: async () => ({ eventId: '$event:example' }), trustPeer: async () => undefined,
        removeOwnDevice: async () => 'removed', discardOutboundSession: async () => true,
        close: async () => undefined,
      };
    };
    const input = { stateDirectory: directory, appOrigin: 'https://khala.aiur.team',
      chromiumExecutablePath, browserBundleDirectory: path.join(directory, 'unused-browser'), session,
      sessionInspection: () => ({ inspect: async () => ({ kind: 'missing' as const }) }),
      inspectHostedCodexHooks: async () => null, resolveCodexExecutable: async () => null,
      openBrowser: async () => undefined, openInbox: async () => undefined,
      diagnostic: (event: unknown) => diagnostics.push(event), openMatrix,
    };
    try {
      const connector = await openProductionConnector(input);
      try {
        const reservation = await connector.ports.devices.reserve('operation-123');
        expect(reservation.kind).toBe('reserved');
        if (reservation.kind !== 'reserved') return;
        await writeFile(path.join(sessionDirectory, 'matrix-session.json'), JSON.stringify({
          baseUrl: 'https://matrix.example', userId: '@agent:example', deviceId: reservation.deviceId,
          accessToken: 'a'.repeat(64), roomId: '!room:example', ownerUserId: '@owner:example',
          ownerParticipantId: `human_${'b'.repeat(40)}`,
        }));
        expect(await connector.ports.devices.status(reservation.deviceId)).toBe('unavailable');
        expect(await connector.ports.devices.status(reservation.deviceId)).toBe('ready');
        expect(selectedBrowser).toBe(chromiumExecutablePath);
        expect(diagnostics).toEqual([
          { stage: 'matrix_writer_active', result: 'unavailable' },
          { stage: 'matrix_writer_recovered', result: 'recovered' },
        ]);
      } finally { await connector.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([
    ['claude', false, false, false], ['codex', false, false, false],
    ['claude', true, false, false], ['claude', false, true, false],
    ['claude', false, false, true],
  ] as const)('releases owner-approved messages to the exact %s manual MCP inbox (early outage: %s, final outage: %s, peer: %s)', async (harness, transientOutage, finalRecheckOutage, peer) => {
    const directory = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-claude-admission-'));
    const session = { harness, sessionId: `${harness}-session-1`, workdir: '/project' };
    const sessionDirectory = path.join(directory, createHash('sha256').update(JSON.stringify([
      'khala.hosted.session.v1', session.harness, session.sessionId, session.workdir,
    ])).digest('hex'));
    const matrixUserId = '@claude-agent:example';
    const agentFingerprint = 'A'.repeat(43);
    const roomId = '!claude:example';
    const payloadA = encodeMessageContent({ v: 1, kind: 'text', body: 'held A' });
    const payloadB = encodeMessageContent({ v: 1, kind: 'text', body: 'approved B' });
    const event = (id: string, payload: Uint8Array, fromPeer = false) => ({ kind: 'decrypted' as const,
      ref: { v: 1 as const, roomId: roomId as never, eventId: id as never,
        authorParticipantId: (fromPeer ? 'peer_participant' : 'owner_participant') as never,
        authorDeviceId: (fromPeer ? 'PEER_DEVICE' : 'OWNER_DEVICE') as never,
        contentDigest: sha256Digest(payload) }, verifiedSenderUserId: fromPeer ? '@peer:example' : '@owner:example',
      verifiedDeviceId: (fromPeer ? 'PEER_DEVICE' : 'OWNER_DEVICE') as never,
      canonicalPayload: payload });
    const events = [event('event_A', payloadA), event('event_B', payloadB, peer)];
    let onText: MatrixConnectorInput['onText'];
    const read = vi.fn(async () => {
      for (const item of events) await onText?.({ roomId, eventId: item.ref.eventId, authorName: 'Owner' });
      return { kind: 'page' as const, events, nextCursor: 'cursor-1', caughtUp: true };
    });
    const send = vi.fn(async () => ({ eventId: '$claude-sent:example' }));
    const openMatrix = async (options: MatrixConnectorInput): Promise<MatrixConnectorSubstrate> => {
      onText = options.onText;
      return ({
      fingerprint: agentFingerprint, writerLock: { kind: 'acquired' },
      participantForDevice: (_room, userId) => (userId === '@peer:example' ? 'peer_participant' : 'owner_participant') as never,
      reviewMembers: async () => [
        'owner_participant', `agent_${createHash('sha256').update(matrixUserId).digest('hex').slice(0, 40)}`,
        ...(peer ? ['peer_participant'] : []),
      ] as never,
      devices: { reserve: async () => ({ kind: 'reserved', deviceId: options.deviceId }),
        activate: async () => ({ kind: 'ready' }), status: async () => 'ready' },
      source: { authorize: async () => 'ok', listen: () => () => undefined, read },
      send, trustPeer: async () => undefined, removeOwnDevice: async () => 'removed',
      discardOutboundSession: async () => true, close: async () => undefined,
      });
    };
    const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200,
      headers: { 'content-type': 'application/json' } });
    let ownerAuthorized = true;
    let closeOnAcquire = false;
    let denyOnAcquire = false;
    let blockAcquire = false;
    let releaseAcquire: (() => void) | null = null;
    let outageOnAcquire = false;
    let authorizationOutagePending = false;
    let ownerTrusted = true;
    let approvalRevoked = false;
    const commands: unknown[] = [];
    const completions: unknown[] = [];
    let approvalExecuting = false;
    let approvalAuthorizationChecks = 0;
    let releaseAuthorizationFailed = false;
    let finalRecheckFailures = 0;
    const sendAttempts = new Map<string, number>();
    const attestationPaths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.startsWith('/api/agent/device-attestation/')) attestationPaths.push(pathname);
      if (pathname.endsWith('/device-attestation/challenge')) return reply({ v: 1, nonce: 'N'.repeat(43), expiresAt: Date.now() + 60_000 });
      if (pathname.endsWith('/device-attestation/register')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ fingerprint: agentFingerprint });
        return reply({ v: 1, kind: 'attested' });
      }
      if (pathname.endsWith('/owner-mailbox/poll') && approvalRevoked) return new Response(null, { status: 403 });
      if (pathname.endsWith('/owner-mailbox/poll') && authorizationOutagePending) {
        authorizationOutagePending = false;
        return new Response(null, { status: 503 });
      }
      if (pathname.endsWith('/owner-mailbox/poll')) {
        if (approvalExecuting && ++approvalAuthorizationChecks === 2 && transientOutage) {
          releaseAuthorizationFailed = true;
          approvalExecuting = false;
          return new Response(null, { status: 503 });
        }
        if (approvalExecuting && finalRecheckOutage && finalRecheckFailures < 2
          && approvalAuthorizationChecks >= 3) {
          finalRecheckFailures += 1;
          return new Response(null, { status: 503 });
        }
        const entries = commands.splice(0);
        if (entries.length > 0) approvalExecuting = true;
        return reply({ v: 1, bindingId: 'binding-claude', generation: 0,
          closing: !ownerAuthorized, entries });
      }
      if (pathname.endsWith('/owner-mailbox/complete')) {
        completions.push(JSON.parse(String(init?.body)));
        return reply({ v: 1, operationId: 'approve_B_0001' });
      }
      if (pathname.endsWith('/owner-device-proof/lookup')) return reply({ v: 1, roomId,
        devices: ownerTrusted ? [{ deviceId: 'OWNER_DEVICE', fingerprint: 'B'.repeat(43) }] : [] });
      if (pathname.endsWith('/room-send/ready') || pathname.endsWith('/room-send/finish')) return reply({ kind: 'applied' });
      if (pathname.endsWith('/room-send/acquire')) {
        if (blockAcquire) await new Promise<void>(resolve => { releaseAcquire = resolve; });
        if (denyOnAcquire) return new Response(JSON.stringify({ code: 'channel_closing' }), { status: 403,
          headers: { 'content-type': 'application/json' } });
        if (outageOnAcquire) authorizationOutagePending = true;
        if (closeOnAcquire) ownerAuthorized = false;
        const txnId = (JSON.parse(String(init?.body)) as { clientTxnId: string }).clientTxnId;
        const attempt = sendAttempts.get(txnId) ?? 0;
        sendAttempts.set(txnId, attempt + 1);
        return reply({ kind: 'granted', permitId: 'permit-1', attempt });
      }
      if (pathname.endsWith('/room-send/inspect')) return reply({ kind: 'ok', hold: null });
      throw new Error(`unexpected ${pathname}`);
    }));
    const input = { stateDirectory: directory, appOrigin: 'https://khala.aiur.team', chromiumExecutablePath,
      browserBundleDirectory: path.join(directory, 'missing-matrix-browser'), session, openMatrix,
      sessionInspection: () => ({ inspect: async () => ({ kind: 'verified' as const,
        session: { harness, sessionId: session.sessionId, generation: 0 },
        capabilities: { harness, version: '1.2.3', support: 'unsupported' } as never }) }),
      inspectHostedCodexHooks: vi.fn(async () => null), resolveCodexExecutable: vi.fn(async () => null),
      openBrowser: async () => undefined,
      openInbox: vi.fn(async (bindingId: string, generation: number, options?: Pick<OpenInboxOptions, 'recordAcknowledgement'>) => {
        expect([bindingId, generation, options]).toEqual(['binding-claude', 0, expect.any(Object)]);
        return openInbox({ stateDirectory: path.join(directory, 'inbox'), bindingId, generation,
          maxPayloadBytes: 64 * 1024, maxSelectionEvents: 20,
          ...(options?.recordAcknowledgement ? { recordAcknowledgement: options.recordAcknowledgement } : {}) });
      }),
    };
    try {
      const connector = await openProductionConnector(input);
      try {
        expect(await connector.status()).toMatchObject({ connected: false,
          readiness: { errorCode: 'binding_not_established' } });
        const reservation = await connector.ports.devices.reserve('approved-operation');
        expect(reservation.kind).toBe('reserved');
        if (reservation.kind !== 'reserved' || !connector.proofSigner) throw new Error('missing admission proof');
        const binding = { v: 1, bindingId: 'binding-claude', ownerId: 'owner-claude',
          agentParticipantId: `agent_${createHash('sha256').update(matrixUserId).digest('hex').slice(0, 40)}`,
          deviceId: reservation.deviceId, harness: 'proof-key', sessionId: `agent_${connector.proofSigner.jkt}`,
          generation: 0 } as SessionBinding;
        const matrixSession = { baseUrl: 'https://matrix.example', userId: matrixUserId,
          deviceId: reservation.deviceId, accessToken: 'exact-device-access-token', roomId,
          ownerUserId: '@owner:example', ownerParticipantId: 'owner_participant' };
        expect(await connector.ports.devices.activate({ operationId: 'approved-operation',
          deviceId: reservation.deviceId, binding, matrixSession,
          capability: { token: 'C'.repeat(43), bindingId: binding.bindingId, generation: 0,
            scope: ['publish_own', 'receive_released', 'ack_delivery'], expiresAt: Date.now() + 3_600_000 },
        })).toEqual({ kind: 'ready' });
        await vi.waitFor(async () => expect(await connector.status()).toMatchObject({ connected: true,
          route: 'manual_mcp', binding, readiness: { phase: 'ready', prerequisites: {
            subscription: 'ready', controls: 'ready', dispatch: 'blocked', review: 'ready' } } }));
        expect(attestationPaths).toEqual(['/api/agent/device-attestation/challenge', '/api/agent/device-attestation/register']);
        expect(publicStatus(await connector.status())).toMatchObject({ connected: true,
          route: 'manual_mcp', binding, readiness: { prerequisites: { review: 'ready', dispatch: 'blocked' } } });
        expect(await connector.listeningModeControl.read()).toMatchObject({ ok: true,
          view: { bindingId: binding.bindingId, generation: 0, effective: null,
            support: { steer: { status: 'unsupported' }, sync: { status: 'unsupported' },
              async: { status: 'unsupported' } } } });
        expect(await connector.listeningModeControl.set({ commandId: 'manual_mode_0001' as never,
          expectedVersion: 1, requested: 'async', issuedAt: '2026-09-30T00:00:00Z' })).toMatchObject({
          outcome: 'refused', effective: null, reason: expect.stringContaining('receipt proof') });
        expect(await connector.listeningMode()).toMatchObject({ effective: null });
        expect((await connector.send({ bindingId: binding.bindingId,
          clientTxnId: 'claude-send', body: 'manual reply' })).kind).toBe('accepted');
        expect(send).toHaveBeenCalledOnce();
        outageOnAcquire = true;
        expect(await connector.send({ bindingId: binding.bindingId,
          clientTxnId: 'retry-after-authority-outage', body: 'eventual reply' }))
          .toEqual({ kind: 'refused', code: 'transport_unavailable', clientTxnId: 'retry-after-authority-outage' });
        outageOnAcquire = false;
        expect((await connector.send({ bindingId: binding.bindingId,
          clientTxnId: 'retry-after-authority-outage', body: 'eventual reply' })).kind).toBe('accepted');
        expect(sendAttempts.get('retry-after-authority-outage')).toBe(2);
        expect(send).toHaveBeenCalledTimes(2);
        denyOnAcquire = true;
        expect(await connector.send({ bindingId: binding.bindingId,
          clientTxnId: 'server-stopped-send', body: 'blocked' }))
          .toEqual({ kind: 'refused', code: 'not_connected', clientTxnId: 'server-stopped-send' });
        expect(send).toHaveBeenCalledTimes(2);
        denyOnAcquire = false;
        blockAcquire = true;
        const overlapping = connector.send({ bindingId: binding.bindingId,
          clientTxnId: 'overlapping-send', body: 'one send' });
        await vi.waitFor(() => expect(releaseAcquire).not.toBeNull());
        expect(await connector.send({ bindingId: binding.bindingId,
          clientTxnId: 'overlapping-send', body: 'one send' }))
          .toEqual({ kind: 'refused', code: 'transport_unavailable', clientTxnId: 'overlapping-send' });
        blockAcquire = false;
        releaseAcquire!();
        expect((await overlapping).kind).toBe('accepted');
        closeOnAcquire = true;
        expect(await connector.send({ bindingId: binding.bindingId,
          clientTxnId: 'stop-between-permit-and-send', body: 'blocked' }))
          .toEqual({ kind: 'refused', code: 'not_connected', clientTxnId: 'stop-between-permit-and-send' });
        expect(send).toHaveBeenCalledTimes(3);
        closeOnAcquire = false;
        ownerAuthorized = true;
        expect(await connector.inbox(binding.bindingId, 0)).toBeDefined();
        expect(input.openInbox).toHaveBeenCalledWith(binding.bindingId, 0, expect.any(Object));
        expect(input.inspectHostedCodexHooks).not.toHaveBeenCalled();
        expect(input.resolveCodexExecutable).not.toHaveBeenCalled();
        const before = await connector.inbox(binding.bindingId, 0);
        const beforeConsumer = await before.acquireCallConsumer!();
        expect(await beforeConsumer.readBatch({ maxBytes: 64 * 1024, explicitRead: true })).toBeNull();
        await beforeConsumer.release();
        commands.push({ operationId: 'approve_B_0001', kind: 'review_approve', outcome: null,
          authority: { ownerId: binding.ownerId, issuer: 'https://issuer.example', subject: 'owner',
            authenticatedAt: '2026-09-30T00:00:00Z', authorizationId: 'authz_owner' },
          body: { v: 1, commandId: 'approve_B_0001', roomId, bindingId: binding.bindingId,
            expectedPolicyVersion: 0, expectedBindingGeneration: 0, selection: [events[1]!.ref],
            issuedAt: '2026-09-30T00:00:00Z' } });
        await vi.waitFor(() => expect(completions).toHaveLength(1), { timeout: 5_000 });
        expect(completions[0]).toMatchObject({ outcome: { ok: true } });
        if (transientOutage) expect(releaseAuthorizationFailed).toBe(true);
        if (finalRecheckOutage) expect(finalRecheckFailures).toBe(1);
        const approved = await connector.inbox(binding.bindingId, 0);
        if (transientOutage || finalRecheckOutage) expect(await approved.readNext()).toBeNull();
        await vi.waitFor(async () => expect(await approved.readNext()).not.toBeNull(), { timeout: 5_000 });
        if (finalRecheckOutage) expect(finalRecheckFailures).toBe(2);
        const reader = await approved.acquireCallConsumer!();
        const batch = await reader.readBatch({ maxBytes: 64 * 1024, explicitRead: true });
        expect(batch?.items).toHaveLength(1);
        expect(Buffer.from(batch!.items[0]!.payload).toString()).toContain('approved B');
        expect(Buffer.from(batch!.items[0]!.payload).toString()).not.toContain('held A');
        expect(await reader.readBatch({ maxBytes: 64 * 1024, acknowledgeToken: batch!.token,
          explicitRead: true })).toBeNull();
        await reader.release();

        commands.push({ operationId: 'manual_sync_0001', kind: 'listening_set', outcome: null,
          authority: { ownerId: binding.ownerId, issuer: 'https://issuer.example', subject: 'owner',
            authenticatedAt: '2026-09-30T00:00:00Z', authorizationId: 'authz_owner' },
          body: { v: 1, commandId: 'manual_sync_0001', bindingId: binding.bindingId,
            expectedBindingGeneration: 0, expectedVersion: 1, requested: 'sync',
            issuedAt: '2026-09-30T00:00:00Z' } });
        await vi.waitFor(() => expect(completions).toHaveLength(2), { timeout: 5_000 });
        expect(completions[1]).toMatchObject({ outcome: { outcome: 'refused', effective: null,
          reason: expect.stringContaining('native Sync delivery hook') } });
        expect(await connector.listeningModeControl.read()).toMatchObject({ ok: true,
          view: { effective: null, support: { async: { status: 'proven' },
            sync: { status: 'unsupported' }, steer: { status: 'unsupported' } } } });
        commands.push({ operationId: 'manual_async_0001', kind: 'listening_set', outcome: null,
          authority: { ownerId: binding.ownerId, issuer: 'https://issuer.example', subject: 'owner',
            authenticatedAt: '2026-09-30T00:00:00Z', authorizationId: 'authz_owner' },
          body: { v: 1, commandId: 'manual_async_0001', bindingId: binding.bindingId,
            expectedBindingGeneration: 0, expectedVersion: 1, requested: 'async',
            issuedAt: '2026-09-30T00:00:00Z' } });
        await vi.waitFor(() => expect(completions).toHaveLength(3), { timeout: 5_000 });
        expect(completions[2]).toMatchObject({ outcome: { outcome: 'applied', effective: 'async' } });
        expect(await connector.listeningMode()).toMatchObject({ effective: 'async' });

        ownerAuthorized = false;
        expect(await connector.status()).toMatchObject({ connected: false,
          readiness: { errorCode: 'channel_closing' } });
        expect(await connector.listeningModeControl.read()).toEqual({ ok: false, code: 'unavailable' });
        expect(await connector.listeningMode()).toMatchObject({ effective: null });
        expect((await connector.send({ bindingId: binding.bindingId,
          clientTxnId: 'revoked-send', body: 'blocked' })).kind).toBe('refused');
        ownerAuthorized = true;
        ownerTrusted = false;
        expect(await connector.status()).toMatchObject({ connected: false,
          readiness: { errorCode: 'binding_revoked' } });
        expect((await connector.send({ bindingId: binding.bindingId,
          clientTxnId: 'untrusted-send', body: 'blocked' })).kind).toBe('refused');
        await rm(path.join(sessionDirectory, 'current-binding.json'));
        expect(await connector.status()).toMatchObject({ connected: false,
          readiness: { errorCode: 'binding_revoked' } });
        expect((await connector.send({ bindingId: binding.bindingId,
          clientTxnId: 'lost-binding-send', body: 'blocked' })).kind).toBe('refused');
        await writeFile(path.join(sessionDirectory, 'current-binding.json'), JSON.stringify(binding));
        approvalRevoked = true;
        expect(await connector.status()).toMatchObject({ connected: false,
          readiness: { errorCode: 'binding_revoked' } });
        expect((await connector.send({ bindingId: binding.bindingId,
          clientTxnId: 'revoked-approval-send', body: 'blocked' })).kind).toBe('refused');
      } finally { await connector.close(); }
      expect(await hasProductionBinding(directory, { ...session, sessionId: 'different-session' })).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

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
    const agentFingerprint = 'D'.repeat(43);
    const read = vi.fn(async () => ({ kind: 'page' as const, events: [], nextCursor: 'cursor-1', caughtUp: true }));
    const send = vi.fn(async (clientTxnId: string, body: string) => {
      if (!clientTxnId || !body) throw new Error('test send missing transaction or body');
      return { eventId: '$sent:example' };
    });
    const opens: MatrixConnectorInput[] = [];
    const openMatrix = async (options: MatrixConnectorInput): Promise<MatrixConnectorSubstrate> => {
      opens.push(options);
      return { fingerprint: agentFingerprint, writerLock: { kind: 'acquired' },
        participantForDevice: () => null,
        reviewMembers: async () => null,
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
      expect(await storage.bindDeviceIdentity({ deviceId: binding.deviceId, fingerprint: agentFingerprint }))
        .toEqual({ kind: 'bound' });
      expect((await storage.ledger.transaction(tx => tx.putBinding(binding))).kind).toBe('inserted');
      expect(await createConnectorDispatchStorage(storage).applyEffectivePolicy({ binding,
        policy: { version: 0, armedAt: 0, paused: false, expiresAt: null,
          listening: { version: 0, requested: 'sync', effective: null, evidenceRevision: null } },
      })).toEqual({ kind: 'applied' });
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
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname.endsWith('/device-attestation/challenge')) return reply({ v: 1, nonce: 'N'.repeat(43), expiresAt: Date.now() + 60_000 });
        if (pathname.endsWith('/device-attestation/register')) {
          expect(JSON.parse(String(init?.body))).toMatchObject({ fingerprint: agentFingerprint });
          return reply({ v: 1, kind: 'attested' });
        }
        if (pathname.endsWith('/owner-mailbox/poll')) return reply({ v: 1,
          bindingId: binding.bindingId, generation: 0, closing: false, entries: [] });
        if (pathname.endsWith('/owner-device-proof/lookup')) return reply({ v: 1, roomId,
          devices: [{ deviceId: 'OWNER_DEVICE', fingerprint: 'B'.repeat(43) }] });
        if (pathname.endsWith('/room-send/ready') || pathname.endsWith('/room-send/finish')) return reply({ kind: 'applied' });
        if (pathname.endsWith('/room-send/acquire')) return reply({ kind: 'granted', permitId: 'permit-1', attempt: 0 });
        if (pathname.endsWith('/room-send/inspect')) return reply({ kind: 'ok', hold: null });
        throw new Error(`unexpected ${pathname}`);
      }));
      const input = { stateDirectory: directory, appOrigin, chromiumExecutablePath,
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
    const input = { stateDirectory: directory, appOrigin, chromiumExecutablePath,
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
      const opened = await openProductionConnector({ stateDirectory: directory, chromiumExecutablePath,
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
    const input = { stateDirectory: directory, appOrigin: 'https://khala.aiur.team', chromiumExecutablePath,
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

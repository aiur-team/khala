import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer as createTcpServer, connect, type Server as TcpServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import type { ParticipantId } from '@khala/contracts/messaging/index';
import { proof } from '../../../../../experiments/backend/check';
import { openMatrixConnectorSubstrate } from '../matrix';

const experiment = fileURLToPath(new URL('../../../../../experiments/browser-crypto/', import.meta.url));
function fixtureSynapse(baseUrl: string): string {
  const hostPort = new URL(baseUrl).port;
  const ids = execFileSync('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.service=synapse'], { encoding: 'utf8' }).trim().split(/\s+/);
  for (const id of ids) {
    if (!id) continue;
    const info = JSON.parse(execFileSync('docker', ['inspect', id], { encoding: 'utf8' }))[0] as {
      Config: { Labels: Record<string, string> }; NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[]> } };
    const project = info.Config.Labels['com.docker.compose.project'];
    if (project?.startsWith('khala-backend-spike-')
      && info.NetworkSettings.Ports['8008/tcp']?.some(port => port.HostIp === '127.0.0.1' && port.HostPort === hostPort)) return id;
  }
  throw new Error('owned_synapse_container_not_found');
}

test('real Synapse encrypted source: verified sender, replay, and durable same device', { timeout: 300_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'khala-matrix-live-'));
  const peerServer = await preview({ root: experiment, preview: { host: '127.0.0.1', port: 0 } });
  const peerOrigin = peerServer.resolvedUrls?.local[0];
  assert.ok(peerOrigin);
  let forwarding: TcpServer | null = null;
  const forwardedSockets = new Set<Socket>();
  try {
    await proof(async ({ baseUrl, alice, bob }) => {
      const api = async (route: string, token: string, payload: unknown) => {
        const response = await fetch(baseUrl + '/_matrix/client/v3' + route, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        assert.ok(response.ok, `Matrix fixture POST ${route} failed: ${response.status}`);
        return response.json() as Promise<{ room_id: string }>;
      };
      const { room_id: roomId } = await api('/createRoom', alice.access_token, {
        visibility: 'private', invite: [bob.user_id],
        initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
      });
      await api(`/join/${encodeURIComponent(roomId)}`, bob.access_token, {});
      const peer = await chromium.launchPersistentContext(join(scratch, 'peer'), {
        executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'],
      });
      let substrate: Awaited<ReturnType<typeof openMatrixConnectorSubstrate>> | null = null;
      try {
        const page = await peer.newPage();
        await page.goto(peerOrigin);
        await page.waitForFunction(() => !!(window as any).peer);
        const aliceKeys = await page.evaluate(input => (window as any).peer.open(input), {
          baseUrl, userId: alice.user_id, deviceId: alice.device_id, accessToken: alice.access_token,
        }) as { ed25519: string };
        const input = {
          baseUrl, userId: bob.user_id, deviceId: bob.device_id, accessToken: bob.access_token,
          roomId, profileDirectory: join(scratch, 'connector'),
          participantIdFor: (userId: string) => userId === alice.user_id ? 'alice' as ParticipantId : null,
        };
        substrate = await openMatrixConnectorSubstrate(input);
        const identity = substrate.fingerprint;
        const untrusted = await page.evaluate(room => (window as any).peer.send(room, 'synthetic-unverified-recipient-denial'), roomId) as { event_id: string };
        const beforeTrust = await substrate.source.read({ cursor: null, limit: 100 });
        assert.equal(beforeTrust.kind, 'page');
        if (beforeTrust.kind === 'page') {
          const concealed = beforeTrust.events.find(event => event.ref.eventId === untrusted.event_id);
          assert.equal(concealed?.kind, 'undecryptable', 'unverified recipient received no Megolm key');
        }
        await assert.rejects(substrate.trustPeer(alice.user_id, alice.device_id, 'wrong'), /matrix_fingerprint_mismatch/);
        assert.equal(await page.evaluate(({ userId, deviceId, fingerprint }) =>
          (window as any).peer.trust(userId, deviceId, fingerprint),
        { userId: bob.user_id, deviceId: bob.device_id, fingerprint: identity }), true);
        await substrate.trustPeer(alice.user_id, alice.device_id, aliceKeys.ed25519);
        await page.evaluate(room => (window as any).peer.rotate(room), roomId);
        await assert.rejects(openMatrixConnectorSubstrate(input), /matrix_device_locked/);
        const marker = 'synthetic-verified-encrypted-replay';
        const sent = await page.evaluate(({ roomId, marker }) => (window as any).peer.send(roomId, marker), { roomId, marker }) as { event_id: string };
        const rawResponse = await fetch(`${baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(sent.event_id)}`, {
          headers: { Authorization: `Bearer ${bob.access_token}` },
        });
        const raw = await rawResponse.json() as { type: string; content: { body?: string } };
        assert.equal(raw.type, 'm.room.encrypted');
        assert.notEqual(raw.content.body, marker);
        let first = await substrate.source.read({ cursor: beforeTrust.kind === 'page' ? beforeTrust.nextCursor : null, limit: 100 });
        for (let attempt = 0; attempt < 20 && first.kind === 'page' && !first.events.some(event => event.ref.eventId === sent.event_id); attempt++) {
          await new Promise(resolve => setTimeout(resolve, 250));
          first = await substrate.source.read({ cursor: first.nextCursor, limit: 100 });
        }
        assert.equal(first.kind, 'page');
        if (first.kind !== 'page') return;
        const delivered = first.events.find(event => event.ref.eventId === sent.event_id);
        assert.equal(delivered?.kind, 'decrypted', JSON.stringify({ delivered, page: first.kind === 'page' ? first.events.map(event => ({ kind: event.kind, eventId: event.ref.eventId })) : first }));
        if (delivered?.kind !== 'decrypted') return;
        assert.equal(delivered.verifiedDeviceId, alice.device_id);
        assert.match(Buffer.from(delivered.canonicalPayload).toString(), /synthetic-verified-encrypted-replay/);
        const firstCursor = first.nextCursor;
        await substrate.close(); substrate = null;
        const reopened = await openMatrixConnectorSubstrate(input);
        substrate = reopened;
        assert.equal(reopened.fingerprint, identity);
        let replay = await reopened.source.read({ cursor: beforeTrust.kind === 'page' ? beforeTrust.nextCursor : null, limit: 100 });
        for (let attempt = 0; attempt < 20 && replay.kind === 'page' && !replay.events.some(event => event.ref.eventId === sent.event_id); attempt++) {
          await new Promise(resolve => setTimeout(resolve, 250));
          replay = await reopened.source.read({ cursor: replay.nextCursor, limit: 100 });
        }
        assert.equal(replay.kind, 'page');
        if (replay.kind === 'page') assert.ok(replay.events.some(event => event.ref.eventId === sent.event_id && event.kind === 'decrypted'));
        const next = await reopened.source.read({ cursor: firstCursor, limit: 100 });
        assert.equal(next.kind, 'page');
        const synapseId = fixtureSynapse(baseUrl);
        execFileSync('docker', ['stop', '--time', '5', synapseId], { stdio: 'ignore' });
        try { assert.equal(await reopened.source.authorize(), 'unavailable'); }
        finally { execFileSync('docker', ['start', synapseId], { stdio: 'ignore' }); }
        const replacementPort = execFileSync('docker', ['port', synapseId, '8008/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1)!;
        const originalPort = new URL(baseUrl).port;
        if (replacementPort !== originalPort) {
          forwarding = createTcpServer(inbound => {
            forwardedSockets.add(inbound);
            const outbound = connect(Number(replacementPort), '127.0.0.1');
            forwardedSockets.add(outbound);
            inbound.on('close', () => forwardedSockets.delete(inbound));
            outbound.on('close', () => forwardedSockets.delete(outbound));
            inbound.on('error', () => outbound.destroy());
            outbound.on('error', () => inbound.destroy());
            inbound.pipe(outbound).pipe(inbound);
          });
          await new Promise<void>((resolve, reject) => { forwarding!.once('error', reject); forwarding!.listen(Number(originalPort), '127.0.0.1', resolve); });
        }
        let directReady = false;
        for (let attempt = 0; attempt < 90 && !directReady; attempt++) {
          try { directReady = (await fetch(baseUrl + '/_matrix/client/versions', { signal: AbortSignal.timeout(2000) })).ok; }
          catch { /* server still starting */ }
          if (!directReady) await new Promise(resolve => setTimeout(resolve, 1000));
        }
        assert.equal(directReady, true, 'owned Synapse restarted');
        let authority = await reopened.source.authorize();
        for (let attempt = 0; attempt < 40 && authority !== 'ok'; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 500));
          authority = await reopened.source.authorize();
        }
        assert.equal(authority, 'ok');
        const afterOffline = await reopened.source.read({ cursor: beforeTrust.kind === 'page' ? beforeTrust.nextCursor : null, limit: 100 });
        assert.equal(afterOffline.kind, 'page');
        await reopened.close(); substrate = null;
        const markerFile = JSON.parse(await readFile(join(input.profileDirectory, 'identity.json'), 'utf8')) as { fingerprint: string };
        assert.equal(markerFile.fingerprint, identity);
        await rm(join(input.profileDirectory, 'profile'), { recursive: true, force: true });
        await assert.rejects(openMatrixConnectorSubstrate(input), /matrix_crypto_store_lost/);
      } finally {
        await substrate?.close();
        await peer.close();
      }
    });
  } finally {
    for (const socket of forwardedSockets) socket.destroy();
    if (forwarding) await new Promise<void>(resolve => forwarding!.close(() => resolve()));
    await new Promise<void>(resolve => peerServer.httpServer.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});

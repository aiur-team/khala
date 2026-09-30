import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runCli } from '@aiur/khala/cli/app';
import { openInbox } from '@aiur/khala/cli/inbox';
import { createInternalClient } from '@aiur/khala/composition/internal';
import { createInternalDelivery } from '@aiur/khala/composition/internal-delivery';
import { encodeInternalDescriptor } from '@khala/contracts/internal/descriptor';
import type { DeviceId, OwnerId, ParticipantId } from '@khala/contracts/messaging/index';
import { createSqliteListeningModeRepository } from '../../listening-mode-store/sqlite';
import { startChannelServer } from '../../server/channel-server';
import { mintCredential } from '../../server/credentials';
import { bob, bobBinding, channelId, createChannelFixture } from '../../server/fixtures/channel-fixture';
import { createDiscoveryStore } from '../../store/discovery-store';
import { createInternalReleaseFeed } from './release-feed';

// Real SQLite + HTTP + separate disk inboxes + runCli, in a disposable environment.
describe('four participant naming proof', () => {
  it('preserves ownership, historical agent bylines, ordered rename and replay for two agents and two humans', async () => {
    const now = Date.now();
    const fixture = createChannelFixture({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'khala-naming-proof-')), now });
    const theo = { participantId: 'human-theo' as ParticipantId, ownerId: 'owner-theo' as OwnerId, kind: 'human' as const, displayName: 'Theo' };
    const scout = { ...theo, participantId: 'agent-scout' as ParticipantId, kind: 'agent' as const, displayName: 'Bob' };
    const theoDevice = 'device-theo' as DeviceId;
    const scoutDevice = 'device-scout' as DeviceId;
    const scoutBinding = { ...bobBinding, ownerId: theo.ownerId, agentParticipantId: scout.participantId,
      deviceId: scoutDevice, bindingId: 'binding-scout' as typeof bobBinding.bindingId, sessionId: 'session-scout' };
    for (const [participant, deviceId] of [[theo, theoDevice], [scout, scoutDevice]] as const) {
      expect(fixture.store.registerParticipant(participant).kind).toBe('done');
      expect(fixture.store.registerDevice({ participantId: participant.participantId, deviceId }).kind).toBe('done');
      expect(fixture.store.setMembership({ channelId, participantId: participant.participantId, membership: 'joined' }).kind).toBe('done');
    }
    expect(createDiscoveryStore(fixture.handle).activate({ operationKey: 'proof-scout', binding: scoutBinding, channelId,
      sessionGeneration: 1, history: 'shared' }).kind).toBe('activated');
    const scoutCredential = { credential: mintCredential(), binding: scoutBinding, channels: [channelId] };
    const theoBootstrap = { ...fixture.bootstrap, credential: mintCredential(), human: { participantId: theo.participantId, ownerId: theo.ownerId, deviceId: theoDevice } };
    let sequence = 0;
    const server = await startChannelServer({ store: fixture.store, bootstrap: [fixture.bootstrap, theoBootstrap],
      bindings: [fixture.bob, scoutCredential], releases: createInternalReleaseFeed({ store: fixture.store,
        listeningModes: createSqliteListeningModeRepository(fixture.handle) }), startPort: 0,
      newId: () => `proof-event-${++sequence}`, clock: () => now });
    try {
      const session = async (credential: string) => {
        const response = await fetch(`${server.origin}/__khala/session`, { method: 'POST', headers: { origin: server.origin,
          'content-type': 'application/json' }, body: JSON.stringify({ credential, channelId }) });
        expect(response.status).toBe(200);
        const value = await response.json() as { requestSecret: string };
        return { cookie: response.headers.getSetCookie()[0]!.split(';')[0]!, 'x-khala-request-secret': value.requestSecret, origin: server.origin };
      };
      const mayaHeaders = await session(fixture.bootstrap.credential);
      const theoHeaders = await session(theoBootstrap.credential);
      const write = (headers: Record<string, string>, clientTxnId: string, content: object) => fetch(`${server.origin}/api/v1/channels/${channelId}/messages`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ clientTxnId, content }) });
      const rename = { v: 1, kind: 'agent_rename', agentParticipantId: bob.participantId, body: 'Dolan' };
      const bobHeaders = { authorization: `Bearer ${fixture.bob.credential}` };
      expect((await write(theoHeaders, 'proof-foreign', rename)).status).toBe(403);
      expect((await write(bobHeaders, 'proof-agent-rename', rename)).status).toBe(403);
      expect((await write(bobHeaders, 'proof-before', { v: 1, kind: 'text', body: 'agent before rename' })).status).toBe(201);
      expect((await write(mayaHeaders, 'proof-rename', rename)).status).toBe(201);
      expect((await write(mayaHeaders, 'proof-rename', rename)).status).toBe(200);
      expect((await write(bobHeaders, 'proof-after', { v: 1, kind: 'text', body: 'agent after rename' })).status).toBe(201);
      expect((await write(theoHeaders, 'proof-human-after', { v: 1, kind: 'text', body: 'human after rename' })).status).toBe(201);
      for (const headers of [mayaHeaders, theoHeaders]) {
        const response = await fetch(`${server.origin}/api/v1/channels/${channelId}/timeline?limit=10`, { headers });
        expect(response.status).toBe(200);
        const timeline = await response.json() as { events: { content: { kind: string } }[] };
        expect(timeline.events.filter(event => event.content.kind === 'agent_rename')).toHaveLength(1);
      }
      expect(fixture.store.nameProjection(channelId)!.currentNames.get(bob.participantId)).toBe('Dolan');
      expect(fixture.store.nameProjection(channelId)!.currentNames.get(scout.participantId)).toBe('Bob');
      const read = async (credential: typeof fixture.bob, label: string) => {
        const stateDirectory = path.join(fixture.root, label);
        const descriptorPath = path.join(fixture.root, `${label}.json`);
        fs.writeFileSync(descriptorPath, encodeInternalDescriptor({ v: 1, channelId, origin: server.origin,
          transportCapability: mintCredential(), grantRef: `grant-${label}`, bindingId: credential.binding.bindingId,
          bindingCapability: credential.credential }), { mode: 0o600 });
        const stdout = new PassThrough(); const stderr = new PassThrough();
        let out = ''; let err = '';
        stdout.on('data', chunk => { out += String(chunk); }); stderr.on('data', chunk => { err += String(chunk); });
        const code = await runCli(['--internal-descriptor', descriptorPath, 'read'], { client: null as never,
          inbox: (bindingId, generation) => openInbox({ stateDirectory, bindingId, generation, maxPayloadBytes: 64 * 1024, maxSelectionEvents: 32 }),
          stdin: new PassThrough(), stdout, stderr, internalClient: async descriptor => createInternalClient({ descriptorPath: descriptor }),
          internalDelivery: async descriptor => createInternalDelivery({ descriptorPath: descriptor, stateDirectory }) });
        expect({ code, err }).toEqual({ code: 0, err: '' });
        return out;
      };
      const scoutRead = await read(scoutCredential, 'scout');
      expect(scoutRead.indexOf('agent before rename')).toBeLessThan(scoutRead.indexOf('khala.agent-rename.v1'));
      expect(scoutRead.indexOf('khala.agent-rename.v1')).toBeLessThan(scoutRead.indexOf('agent after rename'));
      expect(scoutRead).toContain('"agent before rename","Bob"'); expect(scoutRead).toContain('"agent after rename","Dolan"');
      expect(scoutRead.split('khala.agent-rename.v1')).toHaveLength(2);
      expect(await read(scoutCredential, 'scout')).toBe(scoutRead);
      const bobRead = await read(fixture.bob, 'bob');
      expect(bobRead.indexOf('khala.agent-rename.v1')).toBeLessThan(bobRead.indexOf('human after rename'));
      expect(bobRead.split('khala.agent-rename.v1')).toHaveLength(2);
      expect(await read(fixture.bob, 'bob')).toBe(bobRead);
    } finally { await server.close(); fixture.dispose(); }
  });
});

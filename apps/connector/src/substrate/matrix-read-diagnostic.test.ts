import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ParticipantId } from '@khala/contracts/messaging/index';
import type { HostedSubscriptionDiagnostic } from '@khala/connector/subscription/diagnostic';
import { openMatrixConnectorSubstrate } from './matrix';

let root: string | null = null;
afterEach(async () => {
  delete (globalThis as { __khalaFakeBridge?: unknown }).__khalaFakeBridge;
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

it('reports distinct redacted Matrix read boundaries without changing unavailable results', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'khala-matrix-read-'));
  const driver = path.join(root, 'driver');
  const bundle = path.join(root, 'bundle');
  await mkdir(driver);
  await mkdir(bundle);
  await writeFile(path.join(driver, 'package.json'), '{"type":"commonjs"}');
  await writeFile(path.join(bundle, 'index.html'), '<!doctype html>');
  await writeFile(path.join(driver, 'index.js'), `module.exports = { chromium: {
    launchPersistentContext: async () => ({
      newPage: async () => ({
        exposeFunction: async () => {}, goto: async () => {}, waitForFunction: async () => {},
        evaluate: async (_fn, args) => globalThis.__khalaFakeBridge[args[0]](...args[1]),
      }),
      close: async () => {},
    }),
  } };`);

  const owner = '@owner:example';
  const stranger = '@stranger:example';
  const room = '!room:example';
  const event = (senderUserId: string) => ({ eventId: '$event:example', roomId: room,
    senderUserId, senderDeviceId: 'DEVICE', receivedAt: '2026-09-30T00:00:00.000Z',
    body: null, agentParticipantId: null, failure: 'missing_keys' as const });
  let mode: 'bridge' | 'members' | 'participants' | 'missing_keys' | 'callback' = 'bridge';
  const bridge = {
    open: async () => ({ fingerprint: 'A'.repeat(43), deviceId: 'AGENT' }),
    read: async () => {
      if (mode === 'bridge') throw new Error('private bridge details');
      return { events: mode === 'missing_keys' ? [event(stranger)]
        : mode === 'callback' ? [event(owner)] : [], nextCursor: 'cursor', limited: false };
    },
    members: async () => {
      if (mode === 'members') throw new Error('private member details');
      return [owner];
    },
    close: async () => undefined,
  };
  (globalThis as { __khalaFakeBridge?: unknown }).__khalaFakeBridge = bridge;
  const diagnostics: HostedSubscriptionDiagnostic[] = [];
  const substrate = await openMatrixConnectorSubstrate({ baseUrl: 'https://matrix.example',
    userId: '@agent:example', deviceId: 'AGENT', accessToken: 'private-token', roomId: room,
    profileDirectory: path.join(root, 'profile'), browserBundleDirectory: bundle,
    browserDriverDirectory: driver,
    participantIdFor: userId => userId === owner ? 'human_owner' as ParticipantId : null,
    resolveParticipants: async () => mode === 'participants' ? null : new Map([
      [owner, { participantId: 'human_owner' as ParticipantId, ownerId: 'owner' as never,
        kind: 'human' as const, initialName: 'Owner' }],
      [stranger, { participantId: 'human_stranger' as ParticipantId, ownerId: 'owner' as never,
        kind: 'human' as const, initialName: 'Stranger' }],
    ]),
    onText: async () => false,
    diagnostic: value => diagnostics.push(value),
  });
  try {
    for (const [failure, stage] of [
      ['bridge', 'matrix_read_bridge'],
      ['members', 'matrix_read_members'],
      ['participants', 'matrix_read_participants'],
      ['missing_keys', 'matrix_read_missing_keys'],
      ['callback', 'matrix_read_callback'],
    ] as const) {
      mode = failure;
      expect(await substrate.source.read({ cursor: null, limit: 10 })).toEqual({ kind: 'unavailable' });
      expect(diagnostics.pop()).toEqual({ stage, result: 'unavailable' });
    }
    expect(diagnostics).toEqual([]);
  } finally { await substrate.close(); }
});

it('ingests a verified peer agent as its own participant and excludes its own sends', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'khala-matrix-peer-'));
  const driver = path.join(root, 'driver');
  const bundle = path.join(root, 'bundle');
  await mkdir(driver);
  await mkdir(bundle);
  await writeFile(path.join(driver, 'package.json'), '{"type":"commonjs"}');
  await writeFile(path.join(bundle, 'index.html'), '<!doctype html>');
  await writeFile(path.join(driver, 'index.js'), `module.exports = { chromium: {
    launchPersistentContext: async () => ({
      newPage: async () => ({
        exposeFunction: async () => {}, goto: async () => {}, waitForFunction: async () => {},
        evaluate: async (_fn, args) => globalThis.__khalaFakeBridge[args[0]](...args[1]),
      }), close: async () => {},
    }),
  } };`);
  const room = '!room:example';
  const peer = '@peer:example';
  const own = '@self:example';
  const stale = '@stale:example';
  const unknown = '@unknown:example';
  const trusted: unknown[] = [];
  const observed: string[] = [];
  const renamed: string[] = [];
  let includeUnknown = false;
  const event = (senderUserId: string, eventId: string, senderDeviceId: string,
    agentParticipantId: string | null = null) => ({
    senderUserId, eventId, senderDeviceId, roomId: room, receivedAt: '2026-09-30T00:00:00.000Z',
    body: 'hello', agentParticipantId, failure: null,
  });
  (globalThis as { __khalaFakeBridge?: unknown }).__khalaFakeBridge = {
    open: async () => ({ fingerprint: 'A'.repeat(43), deviceId: 'SELF' }),
    read: async () => {
      expect(trusted).toEqual([[peer, 'SELF', 'B'.repeat(43)]]);
      if (includeUnknown) return { events: [event(unknown, '$unknown:example', 'OTHER')],
        nextCursor: 'cursor-2', limited: false };
      return { events: [event(stale, '$stale:example', 'OLD'),
        event(peer, '$wrong-device:example', 'OTHER'),
        event(peer, '$forged-rename:example', 'SELF', 'agent_self'),
        event(peer, '$peer:example', 'SELF'), event(own, '$self:example', 'SELF')],
        nextCursor: 'cursor', limited: false };
    },
    members: async () => [peer, own, stale], trustPeer: async (...args: unknown[]) => { trusted.push(args); },
    close: async () => undefined,
  };
  const substrate = await openMatrixConnectorSubstrate({ baseUrl: 'https://matrix.example',
    userId: own, deviceId: 'SELF', accessToken: 'private-token', roomId: room,
    profileDirectory: path.join(root, 'profile'), browserBundleDirectory: bundle,
    browserDriverDirectory: driver,
    participantIdFor: userId => userId === own ? 'agent_self' as ParticipantId : null,
    resolveParticipants: async userIds => userIds.includes(unknown) ? null : new Map([
      [peer, { participantId: 'agent_peer' as ParticipantId, ownerId: 'owner' as never,
        kind: 'agent' as const, initialName: 'Peer', deviceId: 'SELF', fingerprint: 'B'.repeat(43) }],
      [own, { participantId: 'agent_self' as ParticipantId, ownerId: 'owner' as never,
        kind: 'agent' as const, initialName: 'Self' }],
      [stale, { participantId: 'agent_stale' as ParticipantId, ownerId: 'owner' as never,
        kind: 'agent' as const, initialName: 'Stale' }],
    ]),
    onText: async item => { observed.push(item.eventId); return true; },
    onRename: async item => { renamed.push(item.eventId); return true; },
  });
  try {
    const page = await substrate.source.read({ cursor: null, limit: 10 });
    expect(page.kind).toBe('page');
    if (page.kind !== 'page') return;
    expect(page.events).toHaveLength(1);
    expect(observed).toEqual(['$peer:example']);
    expect(renamed).toEqual([]);
    expect(trusted).toEqual([[peer, 'SELF', 'B'.repeat(43)]]);
    expect(page.events[0]).toMatchObject({ kind: 'decrypted', ref: {
      eventId: '$peer:example', authorParticipantId: 'agent_peer', authorDeviceId: 'SELF',
    }, verifiedSenderUserId: peer, verifiedDeviceId: 'SELF' });
    expect(substrate.participantForDevice(room as never, peer, 'SELF' as never)).toBe('agent_peer');
    expect(substrate.participantForDevice(room as never, own, 'SELF' as never)).toBeNull();
    expect(substrate.participantForDevice(room as never, peer, 'OTHER' as never)).toBeNull();
    expect(substrate.participantForDevice('!other:example' as never, peer, 'PEER' as never)).toBeNull();
    expect(await substrate.reviewMembers()).toEqual(['agent_peer']);
    includeUnknown = true;
    expect(await substrate.source.read({ cursor: 'cursor', limit: 10 })).toEqual({ kind: 'unavailable' });
    expect(observed).toEqual(['$peer:example']);
  } finally { await substrate.close(); }
});

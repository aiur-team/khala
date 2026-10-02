import { describe, expect, it, vi } from 'vitest';
import type { OwnerId, ParticipantId, ParticipantView, RoomId } from '@khala/contracts/messaging/index';
import type { MatrixClient } from 'matrix-js-sdk';
import { guardedListeningModeSetter } from './listening-modes';
import { readListeningMode, sendListeningMode } from './matrix-browser';

const roomId = '!room:khala.example' as RoomId;
const mira = 'owner_mira' as OwnerId;
const viewer: ParticipantView = { participantId: 'p_mira' as ParticipantId, kind: 'human', ownerId: mira, displayName: 'Mira', deviceIds: [] };
const owners: Record<string, string> = { agent_own: mira, agent_theo: 'owner_theo' };
const users: Record<string, string> = { agent_own: '@agent-own:khala.example', agent_theo: '@agent-theo:khala.example' };

function setter(overrides: Partial<Parameters<typeof guardedListeningModeSetter>[0]> = {}) {
  const send = vi.fn(async () => 'sent' as const);
  const set = guardedListeningModeSetter({ roomId, viewer, ownerOf: id => owners[id], joined: () => true,
    matrixUserId: id => users[id], send, ...overrides });
  return { set, send: overrides.send ?? send };
}

describe('guardedListeningModeSetter', () => {
  it('sends the owner’s command to their agent’s Matrix user', async () => {
    const { set, send } = setter();
    await expect(set('agent_own', 'async')).resolves.toBe('sent');
    expect(send).toHaveBeenCalledExactlyOnceWith(roomId, '@agent-own:khala.example', 'async', expect.stringMatching(/^txn_/));
  });

  it('refuses another owner’s agent without sending', async () => {
    const { set, send } = setter();
    await expect(set('agent_theo', 'steer')).resolves.toBe('failed');
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses an agent viewer, a viewer who left, and an unknown Matrix user', async () => {
    for (const overrides of [{ viewer: { ...viewer, kind: 'agent' as const } }, { joined: () => false }, { matrixUserId: () => undefined }]) {
      const { set, send } = setter(overrides);
      await expect(set('agent_own', 'steer')).resolves.toBe('failed');
      expect(send).not.toHaveBeenCalled();
    }
  });
});

describe('listening mode on Matrix', () => {
  function client(content: unknown, encrypted = true) {
    const member = { getContent: () => content };
    return {
      getRoom: vi.fn(() => ({ hasEncryptionStateEvent: () => encrypted,
        currentState: { getStateEvents: vi.fn((type: string, key: string) => type === 'm.room.member' && key === '@a:x' ? member : null) } })),
      sendEvent: vi.fn(async () => ({ event_id: '$1' })),
    } as unknown as Pick<MatrixClient, 'getRoom' | 'sendEvent'>;
  }

  it('reads the member key, defaulting to sync', () => {
    expect(readListeningMode(client({ membership: 'join', 'com.khala.listening_mode': 'async' }), roomId, '@a:x')).toBe('async');
    expect(readListeningMode(client({ membership: 'join' }), roomId, '@a:x')).toBe('sync');
    expect(readListeningMode(client({ 'com.khala.listening_mode': 'async' }), roomId, '@other:x')).toBe('sync');
  });

  it('sends exactly the command content, only in an encrypted room', async () => {
    const encrypted = client({});
    await expect(sendListeningMode(encrypted, roomId, '@a:x', 'steer', 'txn_1')).resolves.toBe('sent');
    expect(encrypted.sendEvent).toHaveBeenCalledExactlyOnceWith(roomId, 'com.khala.listening_mode.v1', { v: 1, agent: '@a:x', mode: 'steer' }, 'txn_1');
    const plain = client({}, false);
    await expect(sendListeningMode(plain, roomId, '@a:x', 'steer', 'txn_2')).resolves.toBe('failed');
    expect(plain.sendEvent).not.toHaveBeenCalled();
  });

  it('reports a failed send', async () => {
    const failing = client({});
    vi.mocked(failing.sendEvent).mockRejectedValueOnce(new Error('offline'));
    await expect(sendListeningMode(failing, roomId, '@a:x', 'sync', 'txn_3')).resolves.toBe('failed');
  });
});

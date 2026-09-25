import { describe, expect, it } from 'vitest';
import {
  decodeChannelSnapshot,
  decodeChannelSummary,
  type ChannelPort,
  type ChannelRejection,
  type ChannelSnapshot,
  type ChannelSummary,
} from './channels';
import {
  decodeRoomSnapshot,
  decodeRoomSummary,
  type RoomPort,
  type RoomRejection,
  type RoomSnapshot,
  type RoomSummary,
} from './rooms';

describe('deprecated room contract aliases', () => {
  it('resolve to the canonical channel decoders', () => {
    expect(decodeRoomSummary).toBe(decodeChannelSummary);
    expect(decodeRoomSnapshot).toBe(decodeChannelSnapshot);
  });

  it('remain assignable without changing wire fields', () => {
    const summary: ChannelSummary = {
      roomId: 'room_compat' as ChannelSummary['roomId'],
      title: null,
      membership: 'joined',
      revision: 'rev_1',
    };
    const legacySummary: RoomSummary = summary;
    const snapshot: ChannelSnapshot = { room: summary, items: [], snapshotRevision: 'snapshot_1', generation: 1 };
    const legacySnapshot: RoomSnapshot = snapshot;
    const channelPort = null as unknown as ChannelPort;
    const roomPort: RoomPort = channelPort;
    const rejection: ChannelRejection = 'not_found';
    const legacyRejection: RoomRejection = rejection;

    expect(legacySummary).toBe(summary);
    expect(legacySnapshot.room).toBe(summary);
    expect(roomPort).toBe(channelPort);
    expect(legacyRejection).toBe('not_found');
  });
});

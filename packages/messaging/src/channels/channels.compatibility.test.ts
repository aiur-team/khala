import { describe, expect, it } from 'vitest';
import {
  createChannelService,
  createMemoryChannelJournal,
  type ChannelJournal,
  type ChannelService,
  type ChannelSubstrate,
} from './index';
import {
  createMemoryRoomJournal,
  createRoomService,
  type RoomJournal,
  type RoomService,
  type RoomSubstrate,
} from '../rooms/index';

describe('deprecated room messaging exports', () => {
  it('resolve to the canonical channel implementations', () => {
    expect(createRoomService).toBe(createChannelService);
    expect(createMemoryRoomJournal).toBe(createMemoryChannelJournal);
  });

  it('remain type-compatible', () => {
    const channelJournal: ChannelJournal = createMemoryChannelJournal();
    const roomJournal: RoomJournal = channelJournal;
    const channelService = null as unknown as ChannelService;
    const roomService: RoomService = channelService;
    const channelSubstrate = null as unknown as ChannelSubstrate;
    const roomSubstrate: RoomSubstrate = channelSubstrate;

    expect(roomJournal).toBe(channelJournal);
    expect(roomService).toBe(channelService);
    expect(roomSubstrate).toBe(channelSubstrate);
  });
});

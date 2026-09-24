import { describe, expect, expectTypeOf, it } from 'vitest';
import { ChannelScreen, RoomScreen, type ChannelScreenProps, type RoomScreenProps } from './ChannelScreen';
import {
  createChannelController,
  createRoomController,
  type ChannelController,
  type ChannelControllerConfig,
  type ChannelView,
  type RoomController,
  type RoomControllerConfig,
  type RoomView,
} from './controller';
import type { ChannelUiPort, RoomUiPort } from './ports';

describe('channel compatibility aliases', () => {
  it('keeps the deprecated room values on the canonical implementation', () => {
    expect(RoomScreen).toBe(ChannelScreen);
    expect(createRoomController).toBe(createChannelController);
  });

  it('keeps the deprecated room types assignable', () => {
    expectTypeOf<RoomScreenProps>().toEqualTypeOf<ChannelScreenProps>();
    expectTypeOf<RoomController>().toEqualTypeOf<ChannelController>();
    expectTypeOf<RoomControllerConfig>().toEqualTypeOf<ChannelControllerConfig>();
    expectTypeOf<RoomView>().toEqualTypeOf<ChannelView>();
    expectTypeOf<RoomUiPort>().toEqualTypeOf<ChannelUiPort>();
  });
});

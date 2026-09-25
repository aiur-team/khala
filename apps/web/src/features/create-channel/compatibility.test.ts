import { describe, expect, expectTypeOf, it } from 'vitest';
import { CreateChannelScreen, CreateChatScreen } from './CreateChannelScreen';
import { createCreateChannelController, createChatController, type CreateChannelController, type CreateChatController } from './controller';
import type { CreateChannelPhase, CreateChannelView, CreateChatPhase, CreateChatView } from './model';
import type { CreateChannelPorts, CreateChatPorts } from './ports';

describe('create-channel compatibility aliases', () => {
  it('keeps the deprecated create-chat values on the canonical implementation', () => {
    expect(CreateChatScreen).toBe(CreateChannelScreen);
    expect(createChatController).toBe(createCreateChannelController);
  });

  it('keeps the deprecated create-chat types assignable', () => {
    expectTypeOf<CreateChatController>().toEqualTypeOf<CreateChannelController>();
    expectTypeOf<CreateChatPhase>().toEqualTypeOf<CreateChannelPhase>();
    expectTypeOf<CreateChatView>().toEqualTypeOf<CreateChannelView>();
    expectTypeOf<CreateChatPorts>().toEqualTypeOf<CreateChannelPorts>();
  });
});

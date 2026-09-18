import { describe, expect, it, vi } from 'vitest';
import type { AdmissionPort, RoomId, RoomPort, RoomSummary, SendState } from '@khala/contracts/messaging';
import { ok, outcomeUnknown } from '@khala/contracts/messaging';
import { createChatController } from './controller';

/**
 * Screen-local fixture adapters, test code only (see `check:boundaries`, which
 * refuses any production import of a `fixtures`-named path). Each factory below
 * builds on `@khala/contracts` fixtures' shapes without importing production
 * KHA105 fixtures directly, since this feature owns no runtime dependency on them.
 */
const ROOM_ID = 'room_demo' as RoomId;
const ROOM: RoomSummary = { roomId: ROOM_ID, title: null, membership: 'joined', revision: 'rev_1' };

function sendState(clientTxnId: string, state: SendState['state']): SendState {
  return {
    clientTxnId,
    state,
    eventRef:
      state === 'accepted'
        ? {
            v: 1,
            roomId: ROOM_ID,
            eventId: `event_${clientTxnId}` as never,
            authorParticipantId: 'participant_1' as never,
            authorDeviceId: 'device_1' as never,
            contentDigest: `sha256:${'a'.repeat(64)}`,
          }
        : null,
  };
}

function fakePorts(roomOverrides: Partial<RoomPort> = {}, admissionOverrides: Partial<AdmissionPort> = {}) {
  const room: RoomPort = {
    create: vi.fn().mockResolvedValue(ok(ROOM)),
    prepareIntro: vi.fn().mockResolvedValue(ok([])),
    resumeIntro: vi.fn().mockResolvedValue(ok([])),
    send: vi.fn(),
    timeline: vi.fn(),
    observe: vi.fn(() => () => {}),
    ...roomOverrides,
  };
  const admission: AdmissionPort = {
    share: vi.fn().mockResolvedValue(ok({ inviteRef: 'invite_1', shareUrl: 'https://khala.aiur.team/i/1', expiresAt: null })),
    inspect: vi.fn(),
    admit: vi.fn(),
    ...admissionOverrides,
  };
  return { room, admission };
}

describe('create-chat operation journal fixtures', () => {
  it('two pending intros resolve to a "resolving" state distinct from ready', async () => {
    const { room, admission } = fakePorts({ prepareIntro: vi.fn().mockResolvedValue(ok([sendState('t1', 'pending'), sendState('t2', 'pending')])) });
    const controller = createChatController({ room, admission });
    controller.addIntro();
    controller.addIntro();
    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('resolving'));
    expect(controller.getView().roomId).toBe(ROOM_ID);
  });

  it('partial acceptance (one accepted, one outcome_unknown) is distinct from a full failure', async () => {
    const { room, admission } = fakePorts({
      prepareIntro: vi.fn().mockResolvedValue(ok([sendState('t1', 'accepted'), sendState('t2', 'outcome_unknown')])),
    });
    const controller = createChatController({ room, admission });
    controller.addIntro();
    controller.addIntro();
    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('resolving'));
    expect(controller.getView().errorCode).toBeNull();
  });

  it('a fully failed intro item surfaces as "failed" with an error code, distinct from "resolving"', async () => {
    const { room, admission } = fakePorts({ prepareIntro: vi.fn().mockResolvedValue(ok([sendState('t1', 'failed')])) });
    const controller = createChatController({ room, admission });
    controller.addIntro();
    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('failed'));
    expect(controller.getView().errorCode).not.toBeNull();
  });

  it('an unknown outcome on share is "resolving" while retaining the created room, distinct from "ready"', async () => {
    const { room, admission } = fakePorts({}, { share: vi.fn().mockResolvedValue(outcomeUnknown('op_1')) });
    const controller = createChatController({ room, admission });
    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('resolving'));
    expect(controller.getView().roomId).toBe(ROOM_ID);
    expect(controller.getView().shareUrl).toBeNull();
  });

  it('an empty chat (no introductions) reaches "ready" without an intro step', async () => {
    const { room, admission } = fakePorts();
    const controller = createChatController({ room, admission });
    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('ready'));
    expect(room.prepareIntro).not.toHaveBeenCalled();
    expect(controller.getView().shareUrl).toBe('https://khala.aiur.team/i/1');
  });
});

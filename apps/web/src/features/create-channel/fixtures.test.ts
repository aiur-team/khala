import { describe, expect, it, vi } from 'vitest';
import type { AdmissionPort, ContentLimits, RoomId, ChannelPort, ChannelSummary, SendState } from '@khala/contracts/messaging/index';
import { decodeContentLimits, ok, outcomeUnknown } from '@khala/contracts/messaging/index';
import { createCreateChannelController } from './controller';

const LIMITS: ContentLimits = (() => {
  const decoded = decodeContentLimits({ maxBodyBytes: 4096, maxDisplayNameBytes: 64, maxRoomTitleBytes: 128 });
  if (!decoded.ok) throw new Error('invalid fixture limits');
  return decoded.value;
})();

/**
 * Screen-local fixture adapters, test code only (see `check:boundaries`, which
 * refuses any production import of a `fixtures`-named path). Each factory below
 * builds on `@khala/contracts` fixtures' shapes without importing production
 * KHA105 fixtures directly, since this feature owns no runtime dependency on them.
 */
const ROOM_ID = 'room_demo' as RoomId;
const CHANNEL: ChannelSummary = { roomId: ROOM_ID, title: null, membership: 'joined', revision: 'rev_1' };

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

function fakePorts(roomOverrides: Partial<ChannelPort> = {}, admissionOverrides: Partial<AdmissionPort> = {}) {
  const room: ChannelPort = {
    create: vi.fn().mockResolvedValue(ok(CHANNEL)),
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
  return { room, admission, limits: LIMITS };
}

describe('create-channel operation journal fixtures', () => {
  it('two pending intros resolve to a "resolving" state distinct from ready', async () => {
    const ports = fakePorts({ prepareIntro: vi.fn().mockResolvedValue(ok([sendState('t1', 'pending'), sendState('t2', 'pending')])) });
    const controller = createCreateChannelController(ports);
    controller.addIntro();
    controller.addIntro();
    const [first, second] = controller.getView().intros;
    controller.updateIntro(first!.localId, 'Hello there.');
    controller.updateIntro(second!.localId, 'Second message.');
    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('resolving'));
    expect(controller.getView().roomId).toBe(ROOM_ID);
  });

  it('partial acceptance (one accepted, one outcome_unknown) is distinct from a full failure', async () => {
    const ports = fakePorts({
      prepareIntro: vi.fn().mockResolvedValue(ok([sendState('t1', 'accepted'), sendState('t2', 'outcome_unknown')])),
    });
    const controller = createCreateChannelController(ports);
    controller.addIntro();
    controller.addIntro();
    const [first, second] = controller.getView().intros;
    controller.updateIntro(first!.localId, 'Hello there.');
    controller.updateIntro(second!.localId, 'Second message.');
    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('resolving'));
    expect(controller.getView().errorCode).toBeNull();
  });

  it('a fully failed intro item surfaces as "failed" with an error code, distinct from "resolving"', async () => {
    const ports = fakePorts({ prepareIntro: vi.fn().mockResolvedValue(ok([sendState('t1', 'failed')])) });
    const controller = createCreateChannelController(ports);
    controller.addIntro();
    controller.updateIntro(controller.getView().intros[0]!.localId, 'Hello there.');
    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('failed'));
    expect(controller.getView().errorCode).not.toBeNull();
  });

  it('an unknown outcome on share is "resolving" while retaining the created channel, distinct from "ready"', async () => {
    const ports = fakePorts({}, { share: vi.fn().mockResolvedValue(outcomeUnknown('op_1')) });
    const controller = createCreateChannelController(ports);
    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('resolving'));
    expect(controller.getView().roomId).toBe(ROOM_ID);
    expect(controller.getView().shareUrl).toBeNull();
  });

  it('an empty channel (no introductions) reaches "ready" without an intro step', async () => {
    const ports = fakePorts();
    const controller = createCreateChannelController(ports);
    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('ready'));
    expect(ports.room.prepareIntro).not.toHaveBeenCalled();
    expect(controller.getView().shareUrl).toBe('https://khala.aiur.team/i/1');
  });
});

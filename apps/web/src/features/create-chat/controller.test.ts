import { describe, expect, it, vi } from 'vitest';
import type { AdmissionPort, RoomId, RoomPort, RoomSummary, SendState } from '@khala/contracts/messaging';
import { ok, rejected, unavailable } from '@khala/contracts/messaging';
import { createChatController } from './controller';

const ROOM_ID = 'room_1' as RoomId;
const ROOM: RoomSummary = { roomId: ROOM_ID, title: null, membership: 'joined', revision: 'rev_1' };

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {});
}

type Resolved<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

function fakeRoomPort(overrides: Partial<RoomPort> = {}): RoomPort {
  return {
    create: vi.fn(() => pendingPromise<Resolved<RoomPort['create']>>()),
    prepareIntro: vi.fn(() => pendingPromise<Resolved<RoomPort['prepareIntro']>>()),
    resumeIntro: vi.fn(() => pendingPromise<Resolved<RoomPort['resumeIntro']>>()),
    send: vi.fn(() => pendingPromise<Resolved<RoomPort['send']>>()),
    timeline: vi.fn(() => pendingPromise<Resolved<RoomPort['timeline']>>()),
    observe: vi.fn(() => () => {}),
    ...overrides,
  };
}

function fakeAdmissionPort(overrides: Partial<AdmissionPort> = {}): AdmissionPort {
  return {
    share: vi.fn(() => pendingPromise<Resolved<AdmissionPort['share']>>()),
    inspect: vi.fn(() => pendingPromise<Resolved<AdmissionPort['inspect']>>()),
    admit: vi.fn(() => pendingPromise<Resolved<AdmissionPort['admit']>>()),
    ...overrides,
  };
}

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

function makeCreateId() {
  let counter = 0;
  return () => `id_${(counter += 1)}`;
}

describe('createChatController', () => {
  it('maps an unnamed title to null and preserves intro order and body bytes', async () => {
    const create = vi.fn().mockResolvedValue(ok(ROOM));
    const share = vi.fn().mockResolvedValue(ok({ inviteRef: 'invite_1', shareUrl: 'https://khala.aiur.team/i/1', expiresAt: null }));
    const room = fakeRoomPort({ create, prepareIntro: vi.fn().mockResolvedValue(ok([sendState('t1', 'accepted'), sendState('t2', 'accepted')])) });
    const admission = fakeAdmissionPort({ share });
    const controller = createChatController({ room, admission }, { createId: makeCreateId() });

    controller.addIntro();
    controller.addIntro();
    const [first, second] = controller.getView().intros;
    controller.updateIntro(first!.localId, 'Hello there.');
    controller.updateIntro(second!.localId, 'Second message.');

    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('ready'));

    expect(create).toHaveBeenCalledWith({ operationId: expect.any(String), title: null });
    const prepareCall = room.prepareIntro as ReturnType<typeof vi.fn>;
    expect(prepareCall.mock.calls[0]![0].messages).toEqual([
      { v: 1, kind: 'text', body: 'Hello there.' },
      { v: 1, kind: 'text', body: 'Second message.' },
    ]);
  });

  it('does not call create twice on a double submit', async () => {
    let resolveCreate!: (value: ReturnType<RoomPort['create']> extends Promise<infer T> ? T : never) => void;
    const create = vi.fn(
      () =>
        new Promise(resolve => {
          resolveCreate = resolve;
        }),
    );
    const room = fakeRoomPort({ create: create as unknown as RoomPort['create'] });
    const admission = fakeAdmissionPort();
    const controller = createChatController({ room, admission }, { createId: makeCreateId() });

    controller.submit();
    controller.submit();
    controller.submit();

    expect(create).toHaveBeenCalledTimes(1);
    resolveCreate(ok(ROOM));
    await vi.waitFor(() => expect(controller.getView().phase).not.toBe('creating'));
  });

  it('AE1: resumes the same intro batch after one accepted and one unknown outcome, never re-creating the room or a fresh batch', async () => {
    const create = vi.fn().mockResolvedValue(ok(ROOM));
    const prepareIntro = vi.fn().mockResolvedValue(ok([sendState('t1', 'accepted'), sendState('t2', 'outcome_unknown')]));
    const resumeIntro = vi.fn().mockResolvedValue(ok([sendState('t1', 'accepted'), sendState('t2', 'accepted')]));
    const share = vi.fn().mockResolvedValue(ok({ inviteRef: 'invite_1', shareUrl: 'https://khala.aiur.team/i/1', expiresAt: null }));
    const room = fakeRoomPort({ create, prepareIntro, resumeIntro });
    const admission = fakeAdmissionPort({ share });
    const controller = createChatController({ room, admission }, { createId: makeCreateId() });

    controller.addIntro();
    controller.addIntro();
    controller.submit();

    await vi.waitFor(() => expect(controller.getView().phase).toBe('resolving'));
    expect(prepareIntro).toHaveBeenCalledTimes(1);
    const firstBatchId = prepareIntro.mock.calls[0]![0].batchId;

    controller.retry();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('ready'));

    expect(create).toHaveBeenCalledTimes(1);
    expect(prepareIntro).toHaveBeenCalledTimes(1);
    expect(resumeIntro).toHaveBeenCalledTimes(1);
    expect(resumeIntro).toHaveBeenCalledWith(firstBatchId);
  });

  it('a rejected creation lets the user fix input and resubmit with a fresh operation, never duplicating an accepted room', async () => {
    const create = vi.fn().mockResolvedValueOnce(rejected('invalid_request')).mockResolvedValueOnce(ok(ROOM));
    const share = vi.fn().mockResolvedValue(ok({ inviteRef: 'invite_1', shareUrl: 'https://khala.aiur.team/i/1', expiresAt: null }));
    const room = fakeRoomPort({ create });
    const admission = fakeAdmissionPort({ share });
    const controller = createChatController({ room, admission }, { createId: makeCreateId() });

    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('failed'));
    expect(controller.getView().errorCode).toBe('invalid_request');

    controller.setTitle('Fixed title');
    expect(controller.getView().phase).toBe('editing');

    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('ready'));
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0].operationId).not.toBe(create.mock.calls[0]![0].operationId);
  });

  it('an unavailable share keeps the accepted room and resumes with the same share operation on retry', async () => {
    const create = vi.fn().mockResolvedValue(ok(ROOM));
    const share = vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(ok({ inviteRef: 'invite_1', shareUrl: 'https://khala.aiur.team/i/1', expiresAt: null }));
    const room = fakeRoomPort({ create });
    const admission = fakeAdmissionPort({ share });
    const controller = createChatController({ room, admission }, { createId: makeCreateId() });

    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('failed'));
    expect(controller.getView().roomId).toBe(ROOM_ID);

    controller.retry();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('ready'));
    expect(create).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]![0].operationId).toBe(share.mock.calls[1]![0].operationId);
  });

  it('skips the intro step and shares directly when there are no drafted introductions', async () => {
    const create = vi.fn().mockResolvedValue(ok(ROOM));
    const prepareIntro = vi.fn();
    const share = vi.fn().mockResolvedValue(ok({ inviteRef: 'invite_1', shareUrl: 'https://khala.aiur.team/i/1', expiresAt: null }));
    const room = fakeRoomPort({ create, prepareIntro });
    const admission = fakeAdmissionPort({ share });
    const controller = createChatController({ room, admission }, { createId: makeCreateId() });

    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('ready'));
    expect(prepareIntro).not.toHaveBeenCalled();
  });

  it('a thrown port call fails rather than leaving the journal stuck busy, and retry resumes it', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(ok(ROOM));
    const share = vi.fn().mockResolvedValue(ok({ inviteRef: 'invite_1', shareUrl: 'https://khala.aiur.team/i/1', expiresAt: null }));
    const room = fakeRoomPort({ create });
    const admission = fakeAdmissionPort({ share });
    const controller = createChatController({ room, admission }, { createId: makeCreateId() });

    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('failed'));
    expect(controller.getView().errorCode).toBe('unavailable');

    controller.retry();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('ready'));
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0].operationId).toBe(create.mock.calls[0]![0].operationId);
  });

  it('applies no state after dispose, even if a pending promise resolves later', async () => {
    let resolveCreate!: (value: unknown) => void;
    const create = vi.fn(() => new Promise(resolve => (resolveCreate = resolve)));
    const room = fakeRoomPort({ create: create as unknown as RoomPort['create'] });
    const admission = fakeAdmissionPort();
    const controller = createChatController({ room, admission }, { createId: makeCreateId() });

    controller.submit();
    controller.dispose();
    resolveCreate(ok(ROOM));
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getView().phase).toBe('creating');
  });
});

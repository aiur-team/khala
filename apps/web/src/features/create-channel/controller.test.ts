import { describe, expect, it, vi } from 'vitest';
import type { AdmissionPort, ContentLimits, RoomId, ChannelPort, ChannelSummary, SendState } from '@khala/contracts/messaging/index';
import { decodeContentLimits, ok, rejected, unavailable } from '@khala/contracts/messaging/index';
import { createCreateChannelController } from './controller';

const ROOM_ID = 'room_1' as RoomId;
const CHANNEL: ChannelSummary = { roomId: ROOM_ID, title: null, membership: 'joined', revision: 'rev_1' };

const LIMITS: ContentLimits = (() => {
  const decoded = decodeContentLimits({ maxBodyBytes: 4096, maxDisplayNameBytes: 64, maxRoomTitleBytes: 128 });
  if (!decoded.ok) throw new Error('invalid fixture limits');
  return decoded.value;
})();

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {});
}

type Resolved<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

function fakeChannelPort(overrides: Partial<ChannelPort> = {}): ChannelPort {
  return {
    create: vi.fn(() => pendingPromise<Resolved<ChannelPort['create']>>()),
    prepareIntro: vi.fn(() => pendingPromise<Resolved<ChannelPort['prepareIntro']>>()),
    resumeIntro: vi.fn(() => pendingPromise<Resolved<ChannelPort['resumeIntro']>>()),
    send: vi.fn(() => pendingPromise<Resolved<ChannelPort['send']>>()),
    timeline: vi.fn(() => pendingPromise<Resolved<ChannelPort['timeline']>>()),
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

describe('createCreateChannelController', () => {
  it('maps an unnamed title to null and preserves intro order and body bytes', async () => {
    const create = vi.fn().mockResolvedValue(ok(CHANNEL));
    const share = vi.fn().mockResolvedValue(ok({ inviteRef: 'invite_1', shareUrl: 'https://khala.aiur.team/i/1', expiresAt: null }));
    const room = fakeChannelPort({ create, prepareIntro: vi.fn().mockResolvedValue(ok([sendState('t1', 'accepted'), sendState('t2', 'accepted')])) });
    const admission = fakeAdmissionPort({ share });
    const controller = createCreateChannelController({ room, admission, limits: LIMITS }, { createId: makeCreateId() });

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

  it.each([
    ['link_no_history', null, { v: 1, kind: 'link', history: 'none' }],
    ['named_no_history', 'coworker@example.test', { v: 1, kind: 'named_email', email: 'coworker@example.test', history: 'none' }],
    ['link_full_history', null, { v: 1, kind: 'link', history: 'full' }],
  ] as const)('passes the selected %s policy to admission.share unchanged', async (choice, email, policy) => {
    const create = vi.fn().mockResolvedValue(ok(CHANNEL));
    const share = vi.fn().mockResolvedValue(ok({ inviteRef: 'invite_1', shareUrl: 'https://khala.aiur.team/i/1', expiresAt: null }));
    const controller = createCreateChannelController(
      { room: fakeChannelPort({ create }), admission: fakeAdmissionPort({ share }), limits: LIMITS },
      { createId: makeCreateId() },
    );
    controller.setAdmissionPolicy(choice);
    if (email) controller.setNamedEmail(email);

    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('ready'));

    expect(share).toHaveBeenCalledWith({ operationId: expect.any(String), roomId: ROOM_ID, policy });
  });

  it('defaults new chats to a link with no earlier history', () => {
    const controller = createCreateChannelController(
      { room: fakeChannelPort(), admission: fakeAdmissionPort(), limits: LIMITS },
      { createId: makeCreateId() },
    );

    expect(controller.getView().admissionPolicy).toBe('link_no_history');
  });

  it('validates the named recipient before creating the channel', () => {
    const create = vi.fn().mockResolvedValue(ok(CHANNEL));
    const controller = createCreateChannelController(
      { room: fakeChannelPort({ create }), admission: fakeAdmissionPort(), limits: LIMITS },
      { createId: makeCreateId() },
    );
    controller.setAdmissionPolicy('named_no_history');
    controller.setNamedEmail('not-an-email');

    controller.submit();

    expect(controller.getView().namedEmailError).toBe('email_invalid');
    expect(create).not.toHaveBeenCalled();
  });

  it('does not call create twice on a double submit', async () => {
    let resolveCreate!: (value: ReturnType<ChannelPort['create']> extends Promise<infer T> ? T : never) => void;
    const create = vi.fn(
      () =>
        new Promise(resolve => {
          resolveCreate = resolve;
        }),
    );
    const room = fakeChannelPort({ create: create as unknown as ChannelPort['create'] });
    const admission = fakeAdmissionPort();
    const controller = createCreateChannelController({ room, admission, limits: LIMITS }, { createId: makeCreateId() });

    controller.submit();
    controller.submit();
    controller.submit();

    expect(create).toHaveBeenCalledTimes(1);
    resolveCreate(ok(CHANNEL));
    await vi.waitFor(() => expect(controller.getView().phase).not.toBe('creating'));
  });

  it('AE1: re-prepares the same intro batch after one accepted and one unknown outcome, never re-creating the channel or a fresh batch', async () => {
    const create = vi.fn().mockResolvedValue(ok(CHANNEL));
    const prepareIntro = vi
      .fn()
      .mockResolvedValueOnce(ok([sendState('t1', 'accepted'), sendState('t2', 'outcome_unknown')]))
      .mockResolvedValueOnce(ok([sendState('t1', 'accepted'), sendState('t2', 'accepted')]));
    const share = vi.fn().mockResolvedValue(ok({ inviteRef: 'invite_1', shareUrl: 'https://khala.aiur.team/i/1', expiresAt: null }));
    const room = fakeChannelPort({ create, prepareIntro });
    const admission = fakeAdmissionPort({ share });
    const controller = createCreateChannelController({ room, admission, limits: LIMITS }, { createId: makeCreateId() });

    controller.addIntro();
    controller.addIntro();
    const [first, second] = controller.getView().intros;
    controller.updateIntro(first!.localId, 'Hello there.');
    controller.updateIntro(second!.localId, 'Second message.');
    controller.submit();

    await vi.waitFor(() => expect(controller.getView().phase).toBe('resolving'));
    expect(prepareIntro).toHaveBeenCalledTimes(1);
    const firstBatchId = prepareIntro.mock.calls[0]![0].batchId;

    controller.retry();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('ready'));

    expect(create).toHaveBeenCalledTimes(1);
    expect(prepareIntro).toHaveBeenCalledTimes(2);
    expect(prepareIntro.mock.calls[1]![0].batchId).toBe(firstBatchId);
    expect(prepareIntro.mock.calls[1]![0].messages).toEqual(prepareIntro.mock.calls[0]![0].messages);
  });

  it('a batch rejected before the journal ever wrote it (for example forbidden) reopens intro editing with a fresh batch, not a dead resumeIntro', async () => {
    const create = vi.fn().mockResolvedValue(ok(CHANNEL));
    const prepareIntro = vi.fn().mockResolvedValueOnce(rejected('forbidden')).mockResolvedValueOnce(ok([sendState('t1', 'accepted')]));
    const resumeIntro = vi.fn();
    const share = vi.fn().mockResolvedValue(ok({ inviteRef: 'invite_1', shareUrl: 'https://khala.aiur.team/i/1', expiresAt: null }));
    const room = fakeChannelPort({ create, prepareIntro, resumeIntro });
    const admission = fakeAdmissionPort({ share });
    const controller = createCreateChannelController({ room, admission, limits: LIMITS }, { createId: makeCreateId() });

    controller.addIntro();
    controller.updateIntro(controller.getView().intros[0]!.localId, 'Hello there.');
    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('editing'));
    expect(controller.getView().roomId).toBe(ROOM_ID);
    expect(controller.getView().errorCode).toBe('forbidden');

    const firstBatchId = prepareIntro.mock.calls[0]![0].batchId;
    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('ready'));

    expect(create).toHaveBeenCalledTimes(1);
    expect(resumeIntro).not.toHaveBeenCalled();
    expect(prepareIntro).toHaveBeenCalledTimes(2);
    expect(prepareIntro.mock.calls[1]![0].batchId).not.toBe(firstBatchId);
  });

  it('a rejected creation lets the user fix input and resubmit with a fresh operation, never duplicating an accepted channel', async () => {
    const create = vi.fn().mockResolvedValueOnce(rejected('invalid_request')).mockResolvedValueOnce(ok(CHANNEL));
    const share = vi.fn().mockResolvedValue(ok({ inviteRef: 'invite_1', shareUrl: 'https://khala.aiur.team/i/1', expiresAt: null }));
    const room = fakeChannelPort({ create });
    const admission = fakeAdmissionPort({ share });
    const controller = createCreateChannelController({ room, admission, limits: LIMITS }, { createId: makeCreateId() });

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

  it('an unavailable share keeps the accepted channel and resumes with the same share operation on retry', async () => {
    const create = vi.fn().mockResolvedValue(ok(CHANNEL));
    const share = vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(ok({ inviteRef: 'invite_1', shareUrl: 'https://khala.aiur.team/i/1', expiresAt: null }));
    const room = fakeChannelPort({ create });
    const admission = fakeAdmissionPort({ share });
    const controller = createCreateChannelController({ room, admission, limits: LIMITS }, { createId: makeCreateId() });

    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('failed'));
    expect(controller.getView().roomId).toBe(ROOM_ID);

    controller.retry();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('ready'));
    expect(create).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]![0].operationId).toBe(share.mock.calls[1]![0].operationId);
    expect(share.mock.calls[0]![0].policy).toEqual(share.mock.calls[1]![0].policy);
  });

  it('skips the intro step and shares directly when there are no drafted introductions', async () => {
    const create = vi.fn().mockResolvedValue(ok(CHANNEL));
    const prepareIntro = vi.fn();
    const share = vi.fn().mockResolvedValue(ok({ inviteRef: 'invite_1', shareUrl: 'https://khala.aiur.team/i/1', expiresAt: null }));
    const room = fakeChannelPort({ create, prepareIntro });
    const admission = fakeAdmissionPort({ share });
    const controller = createCreateChannelController({ room, admission, limits: LIMITS }, { createId: makeCreateId() });

    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('ready'));
    expect(prepareIntro).not.toHaveBeenCalled();
  });

  it('a thrown port call fails rather than leaving the journal stuck busy, and retry resumes it', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(ok(CHANNEL));
    const share = vi.fn().mockResolvedValue(ok({ inviteRef: 'invite_1', shareUrl: 'https://khala.aiur.team/i/1', expiresAt: null }));
    const room = fakeChannelPort({ create });
    const admission = fakeAdmissionPort({ share });
    const controller = createCreateChannelController({ room, admission, limits: LIMITS }, { createId: makeCreateId() });

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
    const room = fakeChannelPort({ create: create as unknown as ChannelPort['create'] });
    const admission = fakeAdmissionPort();
    const controller = createCreateChannelController({ room, admission, limits: LIMITS }, { createId: makeCreateId() });

    controller.submit();
    controller.dispose();
    resolveCreate(ok(CHANNEL));
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getView().phase).toBe('creating');
  });

  it('rejects an empty or oversized intro locally, attaches the error to that field, and never calls the server', async () => {
    const create = vi.fn().mockResolvedValue(ok(CHANNEL));
    const prepareIntro = vi.fn();
    const room = fakeChannelPort({ create, prepareIntro });
    const admission = fakeAdmissionPort();
    const controller = createCreateChannelController({ room, admission, limits: LIMITS }, { createId: makeCreateId() });

    controller.addIntro();
    controller.addIntro();
    const [first, second] = controller.getView().intros;
    controller.updateIntro(first!.localId, '   ');
    controller.updateIntro(second!.localId, 'x'.repeat(LIMITS.maxBodyBytes + 1));

    controller.submit();

    expect(controller.getView().phase).toBe('editing');
    expect(controller.getView().intros[0]!.error).toBe('message_empty');
    expect(controller.getView().intros[1]!.error).toBe('message_too_long');
    expect(create).not.toHaveBeenCalled();
    expect(prepareIntro).not.toHaveBeenCalled();
  });

  it('trims the title and rejects one over the channel title limit locally', async () => {
    const create = vi.fn().mockResolvedValue(ok(CHANNEL));
    const share = vi.fn().mockResolvedValue(ok({ inviteRef: 'invite_1', shareUrl: 'https://khala.aiur.team/i/1', expiresAt: null }));
    const room = fakeChannelPort({ create });
    const admission = fakeAdmissionPort({ share });
    const controller = createCreateChannelController({ room, admission, limits: LIMITS }, { createId: makeCreateId() });

    controller.setTitle('  Hi  ');
    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('ready'));
    expect(create).toHaveBeenCalledWith({ operationId: expect.any(String), title: 'Hi' });

    const controller2 = createCreateChannelController({ room: fakeChannelPort(), admission: fakeAdmissionPort(), limits: LIMITS }, { createId: makeCreateId() });
    controller2.setTitle('x'.repeat(LIMITS.maxRoomTitleBytes + 1));
    controller2.submit();
    expect(controller2.getView().phase).toBe('editing');
    expect(controller2.getView().titleError).toBe('title_too_long');
  });

  it.each([
    ['a right-to-left override', 'Pay\u202Eroll'],
    ['a zero-width space', 'Pay\u200Broll'],
    ['a control character', 'Pay\u0007roll'],
  ])('rejects a title containing %s locally, before any create call', (_label, title) => {
    const create = vi.fn().mockResolvedValue(ok(CHANNEL));
    const controller = createCreateChannelController(
      { room: fakeChannelPort({ create }), admission: fakeAdmissionPort(), limits: LIMITS },
      { createId: makeCreateId() },
    );
    controller.setTitle(title);
    controller.submit();
    expect(controller.getView().phase).toBe('editing');
    expect(controller.getView().titleError).toBe('title_invalid');
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps ZWJ, which emoji sequences need, as a valid title', async () => {
    const create = vi.fn().mockResolvedValue(ok(CHANNEL));
    const share = vi.fn().mockResolvedValue(ok({ inviteRef: 'invite_1', shareUrl: 'https://khala.aiur.team/i/1', expiresAt: null }));
    const controller = createCreateChannelController(
      { room: fakeChannelPort({ create }), admission: fakeAdmissionPort({ share }), limits: LIMITS },
      { createId: makeCreateId() },
    );
    controller.setTitle('Team \u{1F469}\u200D\u{1F4BB}');
    controller.submit();
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    expect(controller.getView().titleError).toBeNull();
  });
});

import { describe, expect, expectTypeOf, it } from 'vitest';
import { type SessionBinding, decodeSessionBinding, sameSessionBinding } from './binding';
import { decodeDeliveryLimits } from './decode';
import {
  type EventRef, decodeEventRef, decodeEventSelection, sameEventIdentity, sameEventRef,
} from './events';
import {
  type DeviceId, type OwnerId, decodeBindingId, decodeDeviceId, decodeOwnerId,
} from './ids';
import { type UnverifiedReleasedJob, decodeReleasedJob, validatePayloadBytes } from './jobs';

const digestA = 'sha256:f16c1e5a70000f33eebc69c8ecf82d1ab7360fcdd15121ac3293f1afd4d4ea6b';
const digestB = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const limits = (() => {
  const decoded = decodeDeliveryLimits({ maxSelectionEvents: 2, maxPayloadBytes: 4096 });
  if (!decoded.ok) throw new Error('test limits must decode');
  return decoded.value;
})();

const eventA = {
  v: 1,
  roomId: 'room-1',
  eventId: 'event-a-7',
  authorParticipantId: 'agent-a',
  authorDeviceId: 'dev-a',
  contentDigest: digestA,
};

const eventB = {
  ...eventA,
  eventId: 'event-a-8',
  contentDigest: digestB,
};

const binding = {
  v: 1,
  bindingId: 'bind-b-1',
  ownerId: 'owner-b',
  agentParticipantId: 'agent-b',
  deviceId: 'dev-b',
  harness: 'codex',
  sessionId: 'thread-existing-b',
  generation: 0,
};

const job = {
  v: 1,
  releaseId: 'release-1',
  approval: { commandId: 'approve-1', policyVersion: 3, bindingGeneration: 0 },
  binding,
  policyVersion: 3,
  events: [eventA, eventB],
  payloadRef: 'payload-ledger-1',
  payloadDigest: digestB,
  causalRootId: 'root-1',
};

describe('delivery limits', () => {
  it('requires both positive safe configured limits and supplies no defaults', () => {
    expect(decodeDeliveryLimits({ maxSelectionEvents: 2, maxPayloadBytes: 4096 }))
      .toEqual({ ok: true, value: { maxSelectionEvents: 2, maxPayloadBytes: 4096 } });
    expect(decodeDeliveryLimits({ maxSelectionEvents: 2 }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'maxPayloadBytes' });
    expect(decodeDeliveryLimits({ maxSelectionEvents: 0, maxPayloadBytes: 4096 }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'maxSelectionEvents' });
    expect(decodeDeliveryLimits({ maxSelectionEvents: 2, maxPayloadBytes: Number.MAX_SAFE_INTEGER + 1 }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'maxPayloadBytes' });
    expect(decodeDeliveryLimits({ maxSelectionEvents: 2, maxPayloadBytes: 4096, defaultBusy: 'queue' }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'defaultBusy' });
  });

  it('returns a safe failure for hostile object access instead of throwing', () => {
    const input = Object.defineProperty({ maxPayloadBytes: 4096 }, 'maxSelectionEvents', {
      enumerable: true,
      get: () => { throw new Error('untrusted plaintext'); },
    });
    expect(decodeDeliveryLimits(input))
      .toEqual({ ok: false, code: 'invalid_field', field: 'maxSelectionEvents' });
  });

  it('turns any other thrown error into a plaintext-free failure', () => {
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('untrusted plaintext'); } });
    expect(decodeEventRef(hostile)).toEqual({ ok: false, code: 'invalid_field', field: '' });
    expect(decodeDeliveryLimits(hostile)).toEqual({ ok: false, code: 'invalid_field', field: '' });
  });
});

describe('independent branded identifiers', () => {
  type MessagingOwnerIdMirror = string & { readonly __khala: 'OwnerId' };

  it('is structurally compatible with the independently declared messaging brand', () => {
    expectTypeOf<OwnerId>().toEqualTypeOf<MessagingOwnerIdMirror>();
    expectTypeOf<DeviceId>().not.toMatchTypeOf<OwnerId>();
    expectTypeOf<string>().not.toMatchTypeOf<OwnerId>();
    expectTypeOf<OwnerId>().toMatchTypeOf<string>();
  });

  it('brands identifiers without changing their bytes', () => {
    expect(decodeOwnerId('Owner Mixed Case')).toEqual({ ok: true, value: 'Owner Mixed Case' });
    expect(decodeDeviceId('dev-a')).toEqual({ ok: true, value: 'dev-a' });
  });

  it('enforces nonempty, control-free, well-formed identifiers', () => {
    expect(decodeOwnerId('')).toEqual({ ok: false, code: 'invalid_field', field: '' });
    expect(decodeOwnerId('owner\nadmin')).toEqual({ ok: false, code: 'invalid_field', field: '' });
    expect(decodeOwnerId(`owner${String.fromCharCode(0x85)}admin`))
      .toEqual({ ok: false, code: 'invalid_field', field: '' });
    expect(decodeOwnerId('broken-\ud800')).toEqual({ ok: false, code: 'invalid_field', field: '' });
  });

  it('caps identifiers at 512 UTF-8 bytes, including multibyte boundaries', () => {
    expect(decodeBindingId('a'.repeat(512)).ok).toBe(true);
    expect(decodeBindingId('\u00e9'.repeat(256)).ok).toBe(true);
    expect(decodeBindingId(`${'a'.repeat(511)}\u00e9`))
      .toEqual({ ok: false, code: 'limit_exceeded', field: '' });
  });

  it('counts three- and four-byte UTF-8 characters exactly', () => {
    // U+20AC is 3 bytes; U+1F44D is 4 bytes (a surrogate pair in UTF-16).
    expect(decodeBindingId(`${'\u20ac'.repeat(170)}aa`).ok).toBe(true);
    expect(decodeBindingId(`${'\u20ac'.repeat(170)}aaa`))
      .toEqual({ ok: false, code: 'limit_exceeded', field: '' });
    expect(decodeBindingId('\u{1f44d}'.repeat(128)).ok).toBe(true);
    expect(decodeBindingId(`${'\u{1f44d}'.repeat(128)}a`))
      .toEqual({ ok: false, code: 'limit_exceeded', field: '' });
  });
});

describe('EventRef', () => {
  it('decodes the exact version 1 shape unchanged', () => {
    expect(decodeEventRef(eventA)).toEqual({ ok: true, value: eventA });
  });

  it('rejects missing and extra protocol fields', () => {
    const missing = structuredClone(eventA) as Record<string, unknown>;
    delete missing.eventId;
    expect(decodeEventRef(missing)).toEqual({ ok: false, code: 'invalid_field', field: 'eventId' });
    expect(decodeEventRef({ ...eventA, renderedBody: 'not canonical' }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'renderedBody' });
  });

  it('distinguishes unsupported versions from invalid fields', () => {
    expect(decodeEventRef({ ...eventA, v: 2 }))
      .toEqual({ ok: false, code: 'invalid_version', field: 'v' });
    expect(decodeEventRef({ ...eventA, v: '1' }))
      .toEqual({ ok: false, code: 'invalid_version', field: 'v' });
  });

  it('accepts only lowercase sha256 digests', () => {
    expect(decodeEventRef({ ...eventA, contentDigest: digestA.toUpperCase() }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'contentDigest' });
    expect(decodeEventRef({ ...eventA, contentDigest: 'sha256:abc' }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'contentDigest' });
  });

  it('compares event identity separately from the full immutable reference', () => {
    const reattributed = { ...eventA, authorParticipantId: 'agent-other', contentDigest: digestB } as EventRef;
    expect(sameEventIdentity(eventA as EventRef, reattributed)).toBe(true);
    expect(sameEventRef(eventA as EventRef, reattributed)).toBe(false);
    expect(sameEventRef(eventA as EventRef, { ...eventA } as EventRef)).toBe(true);
  });

  // One case per compared field: an approval for this event must not match any other.
  const substitutions: { [Field in keyof EventRef]: unknown } = {
    v: 2,
    roomId: 'room-2',
    eventId: 'event-a-9',
    authorParticipantId: 'agent-x',
    authorDeviceId: 'dev-x',
    contentDigest: digestB,
  };

  it('compares every reference field', () => {
    expect(Object.keys(substitutions).sort()).toEqual(Object.keys(eventA).sort());
  });

  it.each(Object.entries(substitutions))('refuses a reference differing only in %s', (field, value) => {
    const ref = eventA as EventRef;
    expect(sameEventRef(ref, { ...ref, [field]: value } as EventRef)).toBe(false);
    expect(sameEventRef({ ...ref, [field]: value } as EventRef, ref)).toBe(false);
  });

  it.each([['roomId', 'room-2'], ['eventId', 'event-a-9']])('refuses an identity differing only in %s', (field, value) => {
    const ref = eventA as EventRef;
    expect(sameEventIdentity(ref, { ...ref, [field]: value } as EventRef)).toBe(false);
    expect(sameEventIdentity({ ...ref, [field]: value } as EventRef, ref)).toBe(false);
  });
});

describe('event selections', () => {
  it('preserves intentional event ordering', () => {
    expect(decodeEventSelection([eventB, eventA], limits))
      .toEqual({ ok: true, value: [eventB, eventA] });
  });

  it('rejects empty and over-limit selections without truncating', () => {
    expect(decodeEventSelection([], limits))
      .toEqual({ ok: false, code: 'invalid_field', field: '' });
    expect(decodeEventSelection([eventA, eventB, { ...eventB, eventId: 'event-a-9' }], limits))
      .toEqual({ ok: false, code: 'limit_exceeded', field: '' });
  });

  it('rejects duplicate room/event identity even when another field differs', () => {
    expect(decodeEventSelection([eventA, { ...eventA, contentDigest: digestB }], limits))
      .toEqual({ ok: false, code: 'invalid_field', field: '[1].eventId' });
  });

  it('rejects mixed-room selections', () => {
    expect(decodeEventSelection([eventA, { ...eventB, roomId: 'room-2' }], limits))
      .toEqual({ ok: false, code: 'invalid_field', field: '[1].roomId' });
  });
});

describe('SessionBinding', () => {
  it('matches the messaging version 1 field set and preserves the existing session', () => {
    expect(decodeSessionBinding(binding)).toEqual({ ok: true, value: binding });
    const decoded = decodeSessionBinding(binding);
    if (decoded.ok) {
      expectTypeOf(decoded.value).toEqualTypeOf<SessionBinding>();
      expect(decoded.value.sessionId).toBe('thread-existing-b');
    }
  });

  it('rejects missing, extra and unsafe generation fields', () => {
    const missing = structuredClone(binding) as Record<string, unknown>;
    delete missing.harness;
    expect(decodeSessionBinding(missing)).toEqual({ ok: false, code: 'invalid_field', field: 'harness' });
    expect(decodeSessionBinding({ ...binding, model: 'gpt' }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'model' });
    for (const generation of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(decodeSessionBinding({ ...binding, generation }))
        .toEqual({ ok: false, code: 'invalid_field', field: 'generation' });
    }
  });

  it('matches an identical binding', () => {
    const value = binding as SessionBinding;
    expect(sameSessionBinding(value, { ...value })).toBe(true);
  });

  // One case per compared field: a release approved for this binding must not match any other.
  const substitutions: { [Field in keyof SessionBinding]: unknown } = {
    v: 2,
    bindingId: 'bind-b-2',
    ownerId: 'owner-c',
    agentParticipantId: 'agent-c',
    deviceId: 'dev-c',
    harness: 'claude',
    sessionId: 'thread-other',
    generation: 1,
  };

  it('compares every binding field', () => {
    expect(Object.keys(substitutions).sort()).toEqual(Object.keys(binding).sort());
  });

  it.each(Object.entries(substitutions))('refuses a binding differing only in %s', (field, value) => {
    const original = binding as SessionBinding;
    expect(sameSessionBinding(original, { ...original, [field]: value } as SessionBinding)).toBe(false);
    expect(sameSessionBinding({ ...original, [field]: value } as SessionBinding, original)).toBe(false);
  });
});

describe('ReleasedJob', () => {
  it('decodes the exact release as unverified and preserves event ordering', () => {
    expect(decodeReleasedJob(job, limits)).toEqual({ ok: true, value: job });
    const decoded = decodeReleasedJob(job, limits);
    if (decoded.ok) expectTypeOf(decoded.value).toEqualTypeOf<UnverifiedReleasedJob>();
  });

  it('rejects missing and extra release fields', () => {
    const missing = structuredClone(job) as Record<string, unknown>;
    delete missing.payloadRef;
    expect(decodeReleasedJob(missing, limits))
      .toEqual({ ok: false, code: 'invalid_field', field: 'payloadRef' });
    expect(decodeReleasedJob({ ...job, retry: true }, limits))
      .toEqual({ ok: false, code: 'invalid_field', field: 'retry' });
  });

  it('rejects unsafe versions, policy values, digests and identifiers', () => {
    expect(decodeReleasedJob({ ...job, v: 2 }, limits))
      .toEqual({ ok: false, code: 'invalid_version', field: 'v' });
    expect(decodeReleasedJob({ ...job, policyVersion: Number.NaN }, limits))
      .toEqual({ ok: false, code: 'invalid_field', field: 'policyVersion' });
    expect(decodeReleasedJob({ ...job, payloadDigest: 'SHA256:not-a-digest' }, limits))
      .toEqual({ ok: false, code: 'invalid_field', field: 'payloadDigest' });
    expect(decodeReleasedJob({ ...job, releaseId: '' }, limits))
      .toEqual({ ok: false, code: 'invalid_field', field: 'releaseId' });
  });

  it('applies configured selection limits and same-room identity rules', () => {
    const oneEventLimit = decodeDeliveryLimits({ maxSelectionEvents: 1, maxPayloadBytes: 4096 });
    if (!oneEventLimit.ok) throw new Error('test limits must decode');
    expect(decodeReleasedJob(job, oneEventLimit.value))
      .toEqual({ ok: false, code: 'limit_exceeded', field: 'events' });
    expect(decodeReleasedJob({ ...job, events: [eventA, { ...eventB, roomId: 'room-2' }] }, limits))
      .toEqual({ ok: false, code: 'invalid_field', field: 'events[1].roomId' });
  });

  it('applies the configured payload byte limit without selecting a default', () => {
    expect(validatePayloadBytes(new Uint8Array(4096), limits).ok).toBe(true);
    expect(validatePayloadBytes(new Uint8Array(4097), limits))
      .toEqual({ ok: false, code: 'limit_exceeded', field: 'payload' });
    expect(validatePayloadBytes('not bytes', limits))
      .toEqual({ ok: false, code: 'invalid_field', field: 'payload' });
  });
});

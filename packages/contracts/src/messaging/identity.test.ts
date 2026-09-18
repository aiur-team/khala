import { describe, expect, expectTypeOf, it } from 'vitest';
import intro from '../../fixtures/messaging/exact-intro.json';
import { decodeContentLimits } from './decode';
import type { DevicePort } from './devices';
import {
  type AuthPrincipal, type SessionBinding, MAX_RETURN_PATH_BYTES, decodeAuthPrincipal, decodeParticipantView,
  decodeSessionBinding, isSameOriginReturnPath, sameProviderIdentity, sameSessionBinding,
} from './identity';
import { type DeviceId, type OwnerId, decodeDeviceId, decodeOwnerId } from './ids';

const principal = intro.principal as AuthPrincipal;
const binding = intro.binding as SessionBinding;
const limits = (() => {
  const decoded = decodeContentLimits(intro.limits);
  if (!decoded.ok) throw new Error('fixture limits must decode');
  return decoded.value;
})();

describe('branded identifiers', () => {
  it('refuses one identifier kind where another is expected', () => {
    expectTypeOf<DeviceId>().not.toMatchTypeOf<OwnerId>();
    expectTypeOf<string>().not.toMatchTypeOf<OwnerId>();
    expectTypeOf<OwnerId>().toMatchTypeOf<string>();
    const ensureReady = (port: DevicePort, deviceId: DeviceId, ownerId: OwnerId) => {
      // @ts-expect-error a device ID is not an owner ID
      void port.ensureReady(deviceId);
      void port.ensureReady(ownerId);
    };
    expect(ensureReady).toBeTypeOf('function');
  });

  it('brands decoded values without changing their bytes', () => {
    expect(decodeOwnerId('owner_alice')).toEqual({ ok: true, value: 'owner_alice' });
    expect(decodeDeviceId('')).toEqual({ ok: false, error: { path: '', code: 'empty' } });
    const decoded = decodeSessionBinding(intro.binding);
    if (decoded.ok) expectTypeOf(decoded.value.deviceId).toEqualTypeOf<DeviceId>();
  });
});

describe('AuthPrincipal', () => {
  it('decodes the worked principal', () => {
    expect(decodeAuthPrincipal(intro.principal)).toEqual({ ok: true, value: intro.principal });
  });

  it('keeps the same verified email from two issuers as two identities', () => {
    const other = { ...principal, ownerId: 'owner_alice_work', providerIssuer: 'https://login.microsoftonline.com/tenant' };
    expect(decodeAuthPrincipal(other).ok).toBe(true);
    expect(sameProviderIdentity(principal, other as AuthPrincipal)).toBe(false);
  });

  it('distinguishes identities differing only in subject', () => {
    expect(sameProviderIdentity(principal, { ...principal, providerSubject: '109876543211' })).toBe(false);
  });

  it('keeps one identity across an email change', () => {
    expect(sameProviderIdentity(principal, { ...principal, verifiedEmail: 'alice@new.example' })).toBe(true);
  });

  it('keeps subjects byte-exact', () => {
    expect(sameProviderIdentity(principal, { ...principal, providerSubject: principal.providerSubject.toUpperCase() + 'X' })).toBe(false);
    const cased = { ...principal, providerSubject: 'AbC' };
    expect(decodeAuthPrincipal(cased)).toEqual({ ok: true, value: cased });
  });
});

describe('participants', () => {
  it('attributes the human and their agent as distinct participants of one owner', () => {
    const human = decodeParticipantView(intro.participants.human, limits);
    const agent = decodeParticipantView(intro.participants.agent, limits);
    if (!human.ok || !agent.ok) throw new Error('fixture participants must decode');
    expect(human.value.ownerId).toBe(agent.value.ownerId);
    expect(human.value.kind).toBe('human');
    expect(agent.value.kind).toBe('agent');
    expect(human.value.participantId).not.toBe(agent.value.participantId);
    expect(human.value.deviceIds).not.toEqual(agent.value.deviceIds);
  });

  it('rejects C1 control characters in display names', () => {
    const nextLine = String.fromCharCode(0x85);
    expect(decodeParticipantView({ ...intro.participants.agent, displayName: `Alice${nextLine}Admin` }, limits))
      .toEqual({ ok: false, error: { path: 'displayName', code: 'control_character' } });
  });

  it('keeps joiners that scripts and emoji sequences need', () => {
    for (const displayName of ['\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645', '\u{1F469}\u200d\u{1F4BB}']) {
      const input = { ...intro.participants.agent, displayName };
      expect(decodeParticipantView(input, limits)).toEqual({ ok: true, value: input });
    }
  });
});

describe('SessionBinding', () => {
  it('decodes the worked binding', () => {
    expect(decodeSessionBinding(intro.binding)).toEqual({ ok: true, value: intro.binding });
  });

  it('requires another binding for another session', () => {
    expect(sameSessionBinding(binding, { ...binding, sessionId: 'thread_fresh_1' })).toBe(false);
  });

  // One case per compared field: a release approved for this binding must not match any other.
  const substitutions: { [Field in keyof SessionBinding]: unknown } = {
    v: 2,
    bindingId: 'binding_a2',
    ownerId: 'owner_bob',
    agentParticipantId: 'agent_bob',
    deviceId: 'device_a2',
    harness: 'claude',
    sessionId: 'thread_existing_8',
    generation: 2,
  };

  it('compares every binding field', () => {
    expect(Object.keys(substitutions).sort()).toEqual(Object.keys(binding).sort());
  });

  it.each(Object.entries(substitutions))('refuses a binding differing only in %s', (field, value) => {
    expect(sameSessionBinding(binding, { ...binding, [field]: value } as SessionBinding)).toBe(false);
    expect(sameSessionBinding({ ...binding, [field]: value } as SessionBinding, binding)).toBe(false);
  });

  it('matches an identical binding', () => {
    expect(sameSessionBinding(binding, { ...binding })).toBe(true);
  });
});

describe('isSameOriginReturnPath', () => {
  it.each(['/', '/chats/room_demo', '/join/invite_7?x=1#y'])('accepts %s', path => {
    expect(isSameOriginReturnPath(path)).toBe(true);
  });

  it.each(['', 'chats', '//evil.example', '/\\evil.example', 'https://evil.example/', '/a\nb'])('rejects %j', path => {
    expect(isSameOriginReturnPath(path)).toBe(false);
  });

  it('caps the path at its UTF-8 byte limit', () => {
    expect(MAX_RETURN_PATH_BYTES).toBe(2048);
    expect(isSameOriginReturnPath(`/${'a'.repeat(2047)}`)).toBe(true);
    expect(isSameOriginReturnPath(`/${'a'.repeat(2048)}`)).toBe(false);
    expect(isSameOriginReturnPath(`/${'\u00e9'.repeat(1024)}`)).toBe(false);
  });
});

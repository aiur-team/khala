import { describe, expect, it } from 'vitest';
import intro from '../../fixtures/messaging/exact-intro.json';
import {
  type AuthPrincipal, type SessionBinding, decodeAuthPrincipal, decodeParticipantView, decodeSessionBinding,
  isSameOriginReturnPath, sameProviderIdentity, sameSessionBinding,
} from './identity';

const principal = intro.principal as AuthPrincipal;
const binding = intro.binding as SessionBinding;

describe('AuthPrincipal', () => {
  it('decodes the worked principal', () => {
    expect(decodeAuthPrincipal(intro.principal)).toEqual({ ok: true, value: intro.principal });
  });

  it('keeps the same verified email from two issuers as two identities', () => {
    const other: AuthPrincipal = { ...principal, ownerId: 'owner_alice_work', providerIssuer: 'https://login.microsoftonline.com/tenant' };
    expect(decodeAuthPrincipal(other).ok).toBe(true);
    expect(sameProviderIdentity(principal, other)).toBe(false);
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
    const human = decodeParticipantView(intro.participants.human, intro.limits);
    const agent = decodeParticipantView(intro.participants.agent, intro.limits);
    if (!human.ok || !agent.ok) throw new Error('fixture participants must decode');
    expect(human.value.ownerId).toBe(agent.value.ownerId);
    expect(human.value.kind).toBe('human');
    expect(agent.value.kind).toBe('agent');
    expect(human.value.participantId).not.toBe(agent.value.participantId);
    expect(human.value.deviceIds).not.toEqual(agent.value.deviceIds);
  });

  it('rejects C1 control characters in display names', () => {
    const nextLine = String.fromCharCode(0x85);
    expect(decodeParticipantView({ ...intro.participants.agent, displayName: `Alice${nextLine}Admin` }, intro.limits))
      .toEqual({ ok: false, error: { path: 'displayName', code: 'control_character' } });
  });
});

describe('SessionBinding', () => {
  it('decodes the worked binding', () => {
    expect(decodeSessionBinding(intro.binding)).toEqual({ ok: true, value: intro.binding });
  });

  it('rejects the next generation substituted into a release targeting generation 1', () => {
    expect(sameSessionBinding(binding, { ...binding, generation: 2 })).toBe(false);
  });

  it('requires another binding for another session', () => {
    expect(sameSessionBinding(binding, { ...binding, sessionId: 'thread_fresh_1' })).toBe(false);
  });
});

describe('isSameOriginReturnPath', () => {
  it.each(['/', '/chats/room_demo', '/join/invite_7?x=1#y'])('accepts %s', path => {
    expect(isSameOriginReturnPath(path)).toBe(true);
  });

  it.each(['', 'chats', '//evil.example', '/\\evil.example', 'https://evil.example/', '/a\nb'])('rejects %j', path => {
    expect(isSameOriginReturnPath(path)).toBe(false);
  });
});

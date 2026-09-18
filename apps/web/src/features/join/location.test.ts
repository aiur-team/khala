import { describe, expect, test } from 'vitest';
import { buildReturnPath, MAX_INVITE_REF_BYTES, parseJoinLocation } from './location';

describe('parseJoinLocation', () => {
  test('reads the opaque invite reference from an origin-relative URL', () => {
    expect(parseJoinLocation('/join?invite=abc123')).toEqual({ inviteRef: 'abc123' });
  });

  test('reads the opaque invite reference from an absolute URL', () => {
    expect(parseJoinLocation('https://khala.aiur.team/join?invite=abc123')).toEqual({ inviteRef: 'abc123' });
  });

  test('an external or scheme-relative locator resolves against a fixed base, never a foreign origin', () => {
    expect(parseJoinLocation('//evil.example/join?invite=abc123')).toEqual({ inviteRef: 'abc123' });
    expect(parseJoinLocation('https://evil.example/join?invite=abc123')).toEqual({ inviteRef: 'abc123' });
  });

  test('a missing invite parameter is invalid', () => {
    expect(parseJoinLocation('/join')).toEqual({ error: 'invalid_location' });
    expect(parseJoinLocation('/join?invite=')).toEqual({ error: 'invalid_location' });
  });

  test('malformed input is invalid, not a throw', () => {
    expect(parseJoinLocation('')).toEqual({ error: 'invalid_location' });
    expect(parseJoinLocation(`not a url at all ${String.fromCharCode(0)}`)).toEqual({ error: 'invalid_location' });
  });

  test('an overlong invite reference is invalid', () => {
    const overlong = 'a'.repeat(MAX_INVITE_REF_BYTES + 1);
    expect(parseJoinLocation(`/join?invite=${overlong}`)).toEqual({ error: 'invalid_location' });

    const atLimit = 'a'.repeat(MAX_INVITE_REF_BYTES);
    expect(parseJoinLocation(`/join?invite=${atLimit}`)).toEqual({ inviteRef: atLimit });
  });

  test('a control or invisible character in the invite reference is invalid', () => {
    expect(parseJoinLocation('/join?invite=abc%00def')).toEqual({ error: 'invalid_location' });
    expect(parseJoinLocation('/join?invite=abc%E2%80%8Bdef')).toEqual({ error: 'invalid_location' });
  });

  test('the invite reference is returned byte-for-byte, never trimmed or normalised', () => {
    expect(parseJoinLocation('/join?invite=abc%20def')).toEqual({ inviteRef: 'abc def' });
  });
});

describe('buildReturnPath', () => {
  test('produces a same-origin relative path carrying the invite reference', () => {
    expect(buildReturnPath('abc123')).toBe('/join?invite=abc123');
  });

  test('encodes characters that would otherwise change the path shape', () => {
    expect(buildReturnPath('abc def&x=1')).toBe('/join?invite=abc%20def%26x%3D1');
  });

  test('the produced path always round-trips back through parseJoinLocation', () => {
    const inviteRef = 'weird ref/with?chars#here';
    const path = buildReturnPath(inviteRef);
    expect(parseJoinLocation(path)).toEqual({ inviteRef });
  });
});

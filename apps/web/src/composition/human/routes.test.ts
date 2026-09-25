import { describe, expect, test } from 'vitest';
import { createHumanRouteCodec } from './routes';

describe('createHumanRouteCodec', () => {
  const codec = createHumanRouteCodec({ origin: 'https://khala.aiur.team', basePath: '/' });

  test('maps create, join and opaque room locations', () => {
    expect(codec.parse('https://khala.aiur.team/new')).toEqual({ kind: 'create', path: '/new' });
    expect(codec.parse('https://khala.aiur.team/')).toEqual({ kind: 'not_found', path: '/' });
    expect(codec.parse('/join?invite=invite_1')).toEqual({ kind: 'join', path: '/join?invite=invite_1', inviteRef: 'invite_1' });
    expect(codec.parse('/channels/room_1')).toEqual({ kind: 'channel', path: '/channels/room_1', roomId: 'room_1' });
  });

  test('accepts the canonical /join/<inviteRef> share-link form', () => {
    expect(codec.parse('https://khala.aiur.team/join/invite_1')).toEqual({ kind: 'join', path: '/join?invite=invite_1', inviteRef: 'invite_1' });
    expect(codec.parseJoinLocation('https://khala.aiur.team/join/invite_1')).toEqual({ inviteRef: 'invite_1' });
    expect(codec.parse('/join/')).toEqual({ kind: 'not_found', path: '/join/' });
    expect(codec.parse('/join/invite_1/extra')).toEqual({ kind: 'not_found', path: '/join/invite_1/extra' });
    expect(codec.parse('/join/%E0%A4%A')).toEqual({ kind: 'not_found', path: '/join/%E0%A4%A' });
    expect(codec.parse('/join/invite_1?invite=other')).toEqual({ kind: 'not_found', path: '/join/invite_1?invite=other' });
  });

  test('keeps a configured base path in every generated route', () => {
    const based = createHumanRouteCodec({ origin: 'https://preview.example', basePath: '/khala' });
    expect(based.createPath()).toBe('/khala/new');
    expect(based.joinPath('invite 1')).toBe('/khala/join?invite=invite%201');
    expect(based.roomPath('room_1')).toBe('/khala/channels/room_1');
    expect(based.parse('/khala/channels/room_1')).toEqual({ kind: 'channel', path: '/khala/channels/room_1', roomId: 'room_1' });
  });

  test('rejects foreign origins, reserved API paths and malformed identifiers', () => {
    expect(codec.parse('https://evil.example/join?invite=invite_1')).toEqual({ kind: 'not_found', path: '/join?invite=invite_1' });
    expect(codec.parse('/api/human/auth/callback')).toEqual({ kind: 'not_found', path: '/api/human/auth/callback' });
    expect(codec.parse('/join?invite=')).toEqual({ kind: 'not_found', path: '/join?invite=' });
    expect(codec.parse('/channels/%00')).toEqual({ kind: 'not_found', path: '/channels/%00' });
  });

  test('validates the injected origin and base path', () => {
    expect(() => createHumanRouteCodec({ origin: 'http://khala.aiur.team', basePath: '/' })).toThrow(/https origin/);
    expect(() => createHumanRouteCodec({ origin: 'https://khala.aiur.team/path', basePath: '/' })).toThrow(/exact origin/);
    expect(() => createHumanRouteCodec({ origin: 'https://khala.aiur.team', basePath: '//evil.example' })).toThrow(/base path/);
  });
});

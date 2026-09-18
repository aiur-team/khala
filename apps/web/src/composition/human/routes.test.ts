import { describe, expect, test } from 'vitest';
import { createHumanRouteCodec } from './routes';

describe('createHumanRouteCodec', () => {
  const codec = createHumanRouteCodec({ origin: 'https://khala.aiur.team', basePath: '/' });

  test('maps create, join and opaque room locations', () => {
    expect(codec.parse('https://khala.aiur.team/')).toEqual({ kind: 'create', path: '/' });
    expect(codec.parse('/join?invite=invite_1')).toEqual({ kind: 'join', path: '/join?invite=invite_1', inviteRef: 'invite_1' });
    expect(codec.parse('/rooms/room_1')).toEqual({ kind: 'room', path: '/rooms/room_1', roomId: 'room_1' });
  });

  test('keeps a configured base path in every generated route', () => {
    const based = createHumanRouteCodec({ origin: 'https://preview.example', basePath: '/khala' });
    expect(based.createPath()).toBe('/khala/');
    expect(based.joinPath('invite 1')).toBe('/khala/join?invite=invite%201');
    expect(based.roomPath('room_1')).toBe('/khala/rooms/room_1');
    expect(based.parse('/khala/rooms/room_1')).toEqual({ kind: 'room', path: '/khala/rooms/room_1', roomId: 'room_1' });
  });

  test('rejects foreign origins, reserved API paths and malformed identifiers', () => {
    expect(codec.parse('https://evil.example/join?invite=invite_1')).toEqual({ kind: 'not_found', path: '/' });
    expect(codec.parse('/api/human/auth/callback')).toEqual({ kind: 'not_found', path: '/' });
    expect(codec.parse('/join?invite=')).toEqual({ kind: 'not_found', path: '/' });
    expect(codec.parse('/rooms/%00')).toEqual({ kind: 'not_found', path: '/' });
  });

  test('validates the injected origin and base path', () => {
    expect(() => createHumanRouteCodec({ origin: 'http://khala.aiur.team', basePath: '/' })).toThrow(/https origin/);
    expect(() => createHumanRouteCodec({ origin: 'https://khala.aiur.team/path', basePath: '/' })).toThrow(/exact origin/);
    expect(() => createHumanRouteCodec({ origin: 'https://khala.aiur.team', basePath: '//evil.example' })).toThrow(/base path/);
  });
});

import { describe, expect, it } from 'vitest';
import { createLocalRouteCodec } from './routes';

const ORIGIN = 'http://127.0.0.1:4871';
const routes = createLocalRouteCodec(ORIGIN);

describe('local route codec', () => {
  it('accepts only the exact loopback origin', () => {
    for (const origin of ['https://khala.aiur.team', 'http://localhost:4871', 'http://127.0.0.1:4871/']) {
      expect(() => createLocalRouteCodec(origin)).toThrow();
    }
  });

  it('maps the root to private create and channel paths to channels', () => {
    expect(routes.parse('/')).toEqual({ kind: 'create', path: '/' });
    expect(routes.parse('/channels/ch_abc')).toEqual({ kind: 'channel', path: '/channels/ch_abc', roomId: 'ch_abc' });
    expect(routes.parse(`${ORIGIN}/channels/ch_abc`)).toMatchObject({ kind: 'channel', roomId: 'ch_abc' });
    expect(routes.roomPath('ch_abc')).toBe('/channels/ch_abc');
    expect(routes.createPath()).toBe('/');
  });

  it('maps a channel’s Make-external page', () => {
    expect(routes.parse('/channels/ch_abc/make-external')).toEqual({
      kind: 'make_external', path: '/channels/ch_abc/make-external', roomId: 'ch_abc',
    });
    expect(routes.makeExternalPath('ch_abc')).toBe('/channels/ch_abc/make-external');
    for (const path of ['/channels//make-external', '/channels/a/b/make-external', '/channels/ch_abc/make-external?x=1']) {
      expect(routes.parse(path).kind, path).toBe('not_found');
    }
  });

  it('has no join, share, sign-in, recovery or hosted create route', () => {
    for (const path of [
      '/join?invite=abc', '/join/abc', '/new', '/recovery', '/api/human/auth/login', '/?mount=hosted-content',
      '/channels/', '/channels/a/b', '/channels/ch_abc?x=1', '/channels/%E0%A4%A', 'http://localhost:4871/channels/ch_abc',
      'https://khala.aiur.team/channels/ch_abc',
    ]) {
      expect(routes.parse(path).kind, path).toBe('not_found');
    }
  });
});

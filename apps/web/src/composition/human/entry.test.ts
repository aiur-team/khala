import { describe, expect, test } from 'vitest';
import { readHumanEntry } from './entry';

describe('readHumanEntry', () => {
  test('boots standalone by default and keeps the path untouched', () => {
    expect(readHumanEntry({ pathname: '/new', search: '' })).toEqual({ mode: 'standalone', path: '/new' });
    expect(readHumanEntry({ pathname: '/join', search: '?invite=invite_1' })).toEqual({ mode: 'standalone', path: '/join?invite=invite_1' });
  });

  test('honours hosted-content and strips the entry parameter before routing', () => {
    expect(readHumanEntry({ pathname: '/new', search: '?mount=hosted-content' })).toEqual({ mode: 'hosted-content', path: '/new' });
    expect(readHumanEntry({ pathname: '/join', search: '?mount=hosted-content&invite=invite_1' }))
      .toEqual({ mode: 'hosted-content', path: '/join?invite=invite_1' });
  });

  test('falls back to standalone for unknown or repeated values', () => {
    expect(readHumanEntry({ pathname: '/new', search: '?mount=embedded' })).toEqual({ mode: 'standalone', path: '/new' });
    expect(readHumanEntry({ pathname: '/new', search: '?mount=hosted-content&mount=hosted-content' })).toEqual({ mode: 'standalone', path: '/new' });
  });
});

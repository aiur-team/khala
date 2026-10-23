import { describe, expect, it } from 'vitest';
import { ARCHIVED_MEMBER_KEY, memberArchived } from './archive';

describe('memberArchived', () => {
  it('is true only for a literal true flag', () => {
    expect(memberArchived({ membership: 'join', [ARCHIVED_MEMBER_KEY]: true })).toBe(true);
    for (const value of [undefined, false, 'true', 1, null]) expect(memberArchived({ [ARCHIVED_MEMBER_KEY]: value })).toBe(false);
    expect(memberArchived(undefined)).toBe(false);
    expect(memberArchived(null)).toBe(false);
  });
});

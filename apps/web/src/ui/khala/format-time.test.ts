import { describe, expect, it } from 'vitest';
import { clockLabel, dayLabel, dayTime } from './format-time';

const utc = { timeZone: 'UTC' };

describe('clockLabel', () => {
  it('shows h:mm with no meridiem', () => {
    expect(clockLabel(new Date('2026-09-30T22:05:00Z'), utc)).toBe('10:05');
    expect(clockLabel(new Date('2026-09-30T09:41:00Z'), utc)).toBe('9:41');
    expect(clockLabel(new Date('2026-09-30T00:07:00Z'), utc)).toBe('12:07');
  });

  it('follows the given time zone', () => {
    expect(clockLabel(new Date('2026-09-30T22:05:00Z'), { timeZone: 'America/New_York' })).toBe('6:05');
  });
});

describe('dayLabel', () => {
  const now = new Date('2026-10-01T15:00:00Z'); // a Thursday

  it.each([
    ['2026-10-01T00:01:00Z', 'Today'],
    ['2026-09-30T23:59:00Z', 'Yesterday'],
    ['2026-09-28T12:00:00Z', 'Monday'],
    ['2026-09-25T12:00:00Z', 'Friday'],
    ['2026-09-24T12:00:00Z', 'Thu, Sep 24'],
    ['2025-10-01T12:00:00Z', 'Wed, Oct 1'],
  ])('%s → %s', (iso, expected) => {
    expect(dayLabel(new Date(iso), now, utc)).toBe(expected);
  });

  it('compares calendar days in the given time zone', () => {
    // 02:00 UTC on Oct 1 is still Sep 30 in New York.
    expect(dayLabel(new Date('2026-10-01T02:00:00Z'), now, { timeZone: 'America/New_York' })).toBe('Yesterday');
  });
});

describe('dayTime', () => {
  it('shows h:mm AM', () => {
    expect(dayTime(new Date('2026-09-30T09:41:00Z'), utc)).toBe('9:41 AM');
    expect(dayTime(new Date('2026-09-30T22:05:00Z'), utc)).toBe('10:05 PM');
  });
});

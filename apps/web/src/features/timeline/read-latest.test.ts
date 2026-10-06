import { expect, it, vi } from 'vitest';
import type { EventId } from '@khala/contracts/messaging/ids';
import { createLatestReadTracker } from './read-latest';

const latest = '$latest' as EventId;
const reading = { atLatest: true, focused: true, visible: true };
it('marks an open, focused channel once after its latest event is visible', () => {
  const mark = vi.fn(); const check = createLatestReadTracker(mark);
  check(latest, { ...reading, visible: false }); expect(mark).not.toHaveBeenCalled();
  check(latest, reading); check(latest, reading);
  expect(mark).toHaveBeenCalledExactlyOnceWith(latest);
});
it('keeps a scrolled-up or unfocused channel unread', () => {
  const mark = vi.fn(); const check = createLatestReadTracker(mark);
  check(latest, { ...reading, atLatest: false });
  check(latest, { ...reading, focused: false });
  expect(mark).not.toHaveBeenCalled();
  check(latest, reading); expect(mark).toHaveBeenCalledOnce();
});
it('marks each new event while the reader remains at latest', () => {
  const mark = vi.fn(); const check = createLatestReadTracker(mark);
  check(latest, reading); check('$next' as EventId, reading); check('$next' as EventId, reading);
  expect(mark.mock.calls).toEqual([[latest], ['$next']]);
});
it('retries a failed durable mark on the next visibility check', async () => {
  const mark = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const check = createLatestReadTracker(mark);
  check(latest, reading); await Promise.resolve(); await Promise.resolve(); check(latest, reading);
  expect(mark).toHaveBeenCalledTimes(2);
});

import { expect, it, vi } from 'vitest';
import { archiveChannel } from './ArchivedChannelsRoute';

it('reports archive and unarchive failures so the list and the archived page can show them', async () => {
  const sent = vi.fn(async () => 'sent' as const);
  const failed = vi.fn(async () => 'failed' as const);
  expect(await archiveChannel(sent, '!r:hs', true)).toBe(true);
  expect(sent).toHaveBeenCalledWith('!r:hs', true);
  expect(await archiveChannel(failed, '!r:hs', false)).toBe(false);
  expect(await archiveChannel(sent, '', true)).toBe(false);
  expect(await archiveChannel(undefined, '!r:hs', true)).toBe(false);
});

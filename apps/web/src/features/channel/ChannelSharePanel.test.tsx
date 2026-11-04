import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RoomId } from '@khala/contracts/messaging/index';
import { useChannelLink, type ChannelLink } from './ChannelSharePanel';

const roomId = '!release:khala.example' as RoomId;
const shareUrl = 'https://khala.example/c/release';

// No DOM environment: each static render stands in for one popover open (a fresh mount).
function open(source: Parameters<typeof useChannelLink>[1], admission = { share: vi.fn() }): ChannelLink {
  let link: ChannelLink | undefined;
  function Probe() { link = useChannelLink(admission, source, roomId, { onCopy: async () => ({ ok: true }) }); return null; }
  renderToStaticMarkup(<Probe />);
  return link!;
}

describe('useChannelLink', () => {
  it('keeps a loaded link, so reopening shows it at once and copies without a request', async () => {
    const personal = vi.fn(async () => ({ v: 1 as const, kind: 'personal_link' as const, shareUrl, expiresAt: null }));
    const links = { personal };
    const first = open(links);
    expect(first.url).toBeNull();
    await first.copy();
    expect(personal).toHaveBeenCalledTimes(1);

    const reopened = open(links);
    expect(reopened).toMatchObject({ url: shareUrl, status: 'ready' });
    expect(await reopened.copy()).toEqual({ ok: true });
    expect(personal).toHaveBeenCalledTimes(1);
  });

  it('fetches again once the kept link has expired', async () => {
    const personal = vi.fn(async () => ({ v: 1 as const, kind: 'personal_link' as const, shareUrl, expiresAt: '2000-01-01T00:00:00Z' }));
    const links = { personal };
    await open(links).copy();
    expect(open(links)).toMatchObject({ url: null, status: 'idle' });
  });
});

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CHANNEL_EVENT_STATUSES, type ChannelEventContent } from '@khala/contracts/m1/channel-event';
import { clockLabel } from '../../ui/khala/format-time';
import { ChannelEventPill } from './ChannelEventPill';

const content: ChannelEventContent = { v: 1, body: 'review requested', kind: 'pr.ready_for_review', summary: 'review requested',
  subject: { ticket: 'AIUR-395', branch: 'feat/events-cursor' }, status: 'pending',
  url: 'https://github.com/aiur-team/aiur/pull/412', occurred_at: '2026-10-01T10:09:00.000Z' };
const render = (value: ChannelEventContent) => renderToStaticMarkup(<ChannelEventPill id="$ev1" content={value}
  senderName="Claude · Kevin" receivedAt="2026-10-01T10:10:30.000Z" timeOptions={{ timeZone: 'UTC' }} />);

describe('ChannelEventPill', () => {
  it('renders the formatted event, time and safe external link', () => {
    const html = render(content);
    expect(html).toContain('AIUR-395 review requested · feat/events-cursor');
    expect(html).toContain('>10:09</time>');
    expect(html).toContain('dateTime="2026-10-01T10:09:00.000Z"');
    expect(html).toContain('href="https://github.com/aiur-team/aiur/pull/412"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('title="From Claude · Kevin"');
    expect(html).toContain('data-event-id="$ev1"');
  });
  it('formats its time like a message row in the given time zone', () => {
    const at = '2026-10-01T04:44:00.000Z';
    const timeOptions = { timeZone: 'Asia/Kolkata' };
    const html = renderToStaticMarkup(<ChannelEventPill id="$ev1" content={{ ...content, occurred_at: at }}
      senderName="Claude · Kevin" receivedAt={at} timeOptions={timeOptions} />);
    expect(clockLabel(new Date(at), timeOptions)).toBe('10:14');
    expect(html).toContain(`>${clockLabel(new Date(at), timeOptions)}</time>`);
  });
  it.each(CHANNEL_EVENT_STATUSES)('uses the %s status dot', status => {
    expect(render({ ...content, status })).toContain(`channel-event-pill__dot--${status}`);
  });
  it('renders unknown kinds as information without a link and falls back to receipt time', () => {
    const html = render({ v: 1, body: 'staging deployed', kind: 'deploy.finished', summary: 'staging deployed' });
    expect(html).toContain('channel-event-pill__dot--info');
    expect(html).toContain('>staging deployed</span>');
    expect(html).toContain('<div class="channel-event-pill__link"');
    expect(html).not.toContain('href=');
    expect(html).toContain('>10:10</time>');
  });
  it('renders HTML and markdown syntax as plain text', () => {
    const html = render({ ...content, summary: '<b>x</b> **y**' });
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt; **y**');
    expect(html).not.toContain('<b>');
  });
});

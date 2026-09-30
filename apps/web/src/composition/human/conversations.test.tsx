import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { ConversationList, type ConversationSummary } from '../../ui/conversation';
import { sortConversations } from './conversations';

const items: readonly ConversationSummary[] = [
  { id: 'older', title: 'Older', preview: 'Decrypted text', timestamp: '2026-09-25T00:00:00.000Z', unreadCount: null },
  { id: 'newer', title: 'Newer', preview: null, timestamp: '2026-09-28T00:00:00.000Z', unreadCount: null },
  { id: 'empty', title: 'Empty', preview: null, timestamp: null, unreadCount: null },
];

describe('conversation index presentation', () => {
  test('sorts by latest decrypted activity with stable empty-room ordering', () => {
    expect(sortConversations(items).map(item => item.id)).toEqual(['newer', 'older', 'empty']);
    expect(items.map(item => item.id)).toEqual(['older', 'newer', 'empty']);
  });

  test('filters authorized input locally without rendering excluded room metadata', () => {
    const html = renderToStaticMarkup(<ConversationList conversations={items} query="decrypted" onQueryChange={vi.fn()} onSelect={vi.fn()} status="ready" />);
    expect(html).toContain('Older');
    expect(html).not.toContain('Newer');
    expect(html).not.toContain('Empty');
    expect(html).toContain('Search channels');
  });

  test('does not call encrypted activity an empty conversation', () => {
    const html = renderToStaticMarkup(<ConversationList conversations={items} query="" onQueryChange={vi.fn()} onSelect={vi.fn()} status="ready" />);
    expect(html).toContain('Message unavailable on this device');
    expect(html).toContain('No messages yet');
  });

  test('shows an unread summary from authorized room counts', () => {
    const html = renderToStaticMarkup(<ConversationList conversations={[{ ...items[0]!, unreadCount: 2 }, ...items.slice(1)]}
      query="" onQueryChange={vi.fn()} onSelect={vi.fn()} status="ready" />);
    expect(html).toContain('2 unread');
    expect(html).toContain('2 unread notifications');
  });
});

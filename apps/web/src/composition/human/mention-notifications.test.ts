import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParticipantView, RoomId, TimelineItem } from '@khala/contracts/messaging/index';
import type { TimelineEntriesView } from '../../features/timeline/controller';
import type { HumanRouteContext } from './application';
import { createMentionNotificationPreference, MENTION_NOTIFICATIONS_KEY, mentionsViewer, observeMentionNotifications } from './mention-notifications';

const roomId = '!room:test' as RoomId;
const viewer = { participantId: 'viewer', ownerId: 'owner', kind: 'human', displayName: 'Global' } as ParticipantView;
const sender = { participantId: 'sender', ownerId: 'owner', kind: 'agent', displayName: 'Global agent' } as ParticipantView;
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static instances: FakeNotification[] = [];
  static requestPermission = vi.fn(async () => FakeNotification.permission = 'granted' as const);
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
  constructor(public title: string, public options: NotificationOptions) { FakeNotification.instances.push(this); }
}
function item(id: string, body = '@Kev hello', participant = sender): TimelineItem {
  return { ref: { eventId: id, roomId }, participant, content: { v: 1, kind: 'text', body },
    receivedAt: new Date(Date.now() + 1000).toISOString(), clientTxnId: null } as TimelineItem;
}
function harness(baseline = true) {
  let receive: (view: TimelineEntriesView) => void = () => undefined;
  const removeRoom = vi.fn();
  const removeIndex = vi.fn();
  const members = [{ ...viewer, displayName: 'Kev' }, { ...sender, displayName: 'Opus' }];
  const context = { generation: 1, principal: { ownerId: 'owner' }, participant: () => viewer,
    conversations: { snapshot: () => [{ id: roomId, title: 'Channel' }], subscribe: () => removeIndex },
    room: { observeEntries: (_id: RoomId, listener: typeof receive) => { receive = listener; return removeRoom; } },
    roomParticipants: async () => members,
  } as unknown as HumanRouteContext;
  const open = vi.fn();
  const preference = createMentionNotificationPreference();
  const dispose = observeMentionNotifications(context, preference, open);
  const emit = (items: TimelineItem[], historicalEventIds: string[] = [], entries?: TimelineEntriesView['entries']) => receive({ roomId, generation: 1,
    room: { roomId, title: 'Channel', membership: 'joined' } as TimelineEntriesView['room'],
    entries: entries ?? items.map(item => ({ kind: 'message', item })), historicalEventIds: historicalEventIds as never });
  if (baseline) emit([{ ...item('old'), receivedAt: new Date(Date.now() - 60_000).toISOString() }]);
  return { context, emit, dispose, open, removeRoom, removeIndex, preference };
}
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
beforeEach(() => {
  FakeNotification.instances = [];
  FakeNotification.permission = 'granted';
  FakeNotification.requestPermission.mockClear();
  vi.stubGlobal('Notification', FakeNotification);
  vi.stubGlobal('localStorage', { getItem: () => 'on', setItem: vi.fn() });
  vi.stubGlobal('document', { hidden: true, hasFocus: () => false, querySelector: () => ({ href: '/favicon.svg' }) });
  vi.stubGlobal('window', { focus: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe('mention notifications', () => {
  it('notifies once per new message with channel names, preview, icon and replacement tag; click focuses and routes', async () => {
    const h = harness();
    h.emit([item('new', '@Kev ' + 'hello '.repeat(30))]);
    h.emit([item('new', '@Kev ' + 'hello '.repeat(30))]);
    await settle();
    expect(FakeNotification.instances).toHaveLength(1);
    const notification = FakeNotification.instances[0]!;
    expect(notification.title).toBe('Channel');
    expect(notification.options).toMatchObject({ icon: '/favicon.svg', tag: `khala-mention:${roomId}` });
    expect(notification.options.body).toMatch(/^Opus: @Kev hello/u);
    expect(notification.options.body).toHaveLength(120);
    notification.onclick!();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(h.open).toHaveBeenCalledWith(roomId, 'new');
    h.emit([item('next')]);
    await settle();
    expect(FakeNotification.instances[1]?.options.tag).toBe(notification.options.tag);
    h.dispose();
    expect(h.removeRoom).toHaveBeenCalledOnce();
    expect(h.removeIndex).toHaveBeenCalledOnce();
  });
  it.each(['own', 'focused', 'denied', 'off', 'not-mentioned', 'history', 'code'])('suppresses %s messages', async reason => {
    const h = harness();
    if (reason === 'focused') vi.stubGlobal('document', { hidden: false, hasFocus: () => true });
    if (reason === 'denied') FakeNotification.permission = 'denied';
    if (reason === 'off') await h.preference.toggle();
    const body = reason === 'not-mentioned' ? '@Nobody hello' : reason === 'code' ? '`@Kev`' : '@Kev hello';
    h.emit([item('new', body, reason === 'own' ? viewer : sender)], reason === 'history' ? ['new'] : []);
    await settle();
    expect(FakeNotification.instances).toHaveLength(0);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    h.dispose();
  });
  it('notifies when visible but unfocused', async () => {
    vi.stubGlobal('document', { hidden: false, hasFocus: () => false, querySelector: () => null });
    const h = harness(); h.emit([item('new')]); await settle();
    expect(FakeNotification.instances).toHaveLength(1); h.dispose();
  });
  it('waits for live decryption but never replays initial encrypted history', async () => {
    const h = harness();
    h.emit([], [], [{ kind: 'unavailable', eventId: 'encrypted' as never, receivedAt: new Date().toISOString() }]);
    h.emit([item('encrypted')]); await settle();
    expect(FakeNotification.instances).toHaveLength(1); h.dispose();
  });
  it('notifies on the first live update when attaching to an already-observed channel', async () => {
    const h = harness(false);
    h.emit([item('first-live')]); await settle();
    expect(FakeNotification.instances).toHaveLength(1); h.dispose();
  });
  it('never replays initially encrypted history when it decrypts later', async () => {
    const h = harness(false);
    h.emit([], [], [{ kind: 'unavailable', eventId: 'old-encrypted' as never, receivedAt: new Date(Date.now() - 60_000).toISOString() }]);
    h.emit([item('old-encrypted')]); await settle();
    expect(FakeNotification.instances).toHaveLength(0); h.dispose();
  });
  it('retries a failed roster read without losing a channel-name mention', async () => {
    const h = harness();
    const original = h.context.roomParticipants!;
    vi.spyOn(h.context, 'roomParticipants').mockResolvedValueOnce(null).mockImplementation(original);
    h.emit([item('retry')]); await settle();
    expect(FakeNotification.instances).toHaveLength(0);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(FakeNotification.instances).toHaveLength(1);
    h.emit([item('retry')]); await settle();
    expect(FakeNotification.instances).toHaveLength(1); h.dispose();
  });
  it('cancels a roster retry on disposal', async () => {
    const h = harness();
    const read = vi.spyOn(h.context, 'roomParticipants').mockResolvedValue(null);
    h.emit([item('retry')]); await settle(); h.dispose();
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(read).toHaveBeenCalledOnce(); expect(FakeNotification.instances).toHaveLength(0);
  });
  it('drops pending work on disposal', async () => {
    const h = harness(); h.emit([item('new')]); h.dispose(); await settle();
    expect(FakeNotification.instances).toHaveLength(0);
  });
});

describe('permission preference', () => {
  it('asks only on toggle and remembers the choice', async () => {
    FakeNotification.permission = 'default';
    const preference = createMentionNotificationPreference();
    expect(preference.state()).toBe('off');
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    await preference.toggle();
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
    expect(localStorage.setItem).toHaveBeenCalledWith(MENTION_NOTIFICATIONS_KEY, 'on');
    expect(preference.state()).toBe('on');
    await preference.toggle(); expect(preference.state()).toBe('off');
  });
  it('respects denied permission and unavailable API', async () => {
    FakeNotification.permission = 'denied'; const p = createMentionNotificationPreference();
    expect(p.state()).toBe('blocked'); await p.toggle();
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    vi.stubGlobal('Notification', undefined); expect(p.state()).toBe('unsupported'); await p.toggle();
  });
  it('continues when storage throws', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } });
    const p = createMentionNotificationPreference(); expect(p.state()).toBe('off'); await p.toggle(); expect(p.state()).toBe('on');
  });
  it('matches viewer names with timeline boundaries and excludes code', () => {
    const roster = [{ participantId: 'viewer', label: 'Kev', kind: 'human' as const, hue: 0 }];
    expect(mentionsViewer('@kev hello', roster, 'viewer')).toBe(true);
    for (const body of ['x@Kev', '@Kevin', '`@Kev`', '```txt\n@Kev\n```']) expect(mentionsViewer(body, roster, 'viewer')).toBe(false);
  });
});

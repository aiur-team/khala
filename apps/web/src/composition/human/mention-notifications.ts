import type { Disposer, ParticipantView, RoomId, TimelineItem } from '@khala/contracts/messaging/index';
import { segmentMentions, type MentionCandidate } from '../../features/timeline/mentions';
import { projectTimelineNames } from '../../features/timeline/names';
import type { HumanRouteContext } from './application';

export const MENTION_NOTIFICATIONS_KEY = 'khala.mention-notifications.v1';
export type NotificationState = 'on' | 'off' | 'blocked' | 'unsupported';

/** Browser permission is requested only by the Settings action. Storage is best-effort. */
export function createMentionNotificationPreference() {
  let enabled = false;
  try { enabled = globalThis.localStorage?.getItem(MENTION_NOTIFICATIONS_KEY) === 'on'; } catch { /* Private browsing. */ }
  const listeners = new Set<() => void>();
  const state = (): NotificationState => typeof Notification === 'undefined' ? 'unsupported'
    : Notification.permission === 'denied' ? 'blocked' : enabled && Notification.permission === 'granted' ? 'on' : 'off';
  return {
    state,
    subscribe(listener: () => void): Disposer {
      listeners.add(listener);
      const onStorage = (event: StorageEvent) => {
        if (event.key !== MENTION_NOTIFICATIONS_KEY && event.key !== null) return;
        try { enabled = globalThis.localStorage?.getItem(MENTION_NOTIFICATIONS_KEY) === 'on'; } catch { /* Keep the memory choice. */ }
        listener();
      };
      globalThis.addEventListener?.('focus', listener);
      globalThis.addEventListener?.('storage', onStorage);
      return () => {
        listeners.delete(listener);
        globalThis.removeEventListener?.('focus', listener);
        globalThis.removeEventListener?.('storage', onStorage);
      };
    },
    async toggle() {
      if (state() === 'blocked' || state() === 'unsupported') return;
      if (enabled && Notification.permission === 'granted') enabled = false;
      else {
        try { enabled = (Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()) === 'granted'; }
        catch { enabled = false; }
      }
      try { globalThis.localStorage?.setItem(MENTION_NOTIFICATIONS_KEY, enabled ? 'on' : 'off'); } catch { /* Keep the in-memory choice. */ }
      for (const listener of listeners) listener();
    },
  };
}

export type MentionNotificationPreference = ReturnType<typeof createMentionNotificationPreference>;

/** Follow the renderer: inline and fenced code do not contain active mentions. */
export function mentionsViewer(body: string, roster: readonly MentionCandidate[], viewerId: string): boolean {
  const prose = body.replace(/```[^\n`]*\n[\s\S]*?```/gu, '').replace(/`[^`\n]+`/gu, '');
  return segmentMentions(prose, roster).some(segment => 'participantId' in segment && segment.participantId === viewerId);
}
const label = (p: Pick<ParticipantView, 'kind' | 'displayName'>) => p.kind === 'agent'
  ? p.displayName.split(' · ')[0]!.trim() : p.displayName.trim().split(/\s+/u)[0]!;

/** One identity/device lifetime, independent of which channel is selected. */
export function observeMentionNotifications(context: HumanRouteContext, preference: MentionNotificationPreference,
  openMessage: (roomId: RoomId, eventId: string) => void): Disposer {
  const subscriptions = new Map<string, Disposer>();
  const notifications = new Set<Notification>();
  const startedAt = Date.now();
  let disposed = false;
  const viewer = context.participant?.();
  const observeEntries = context.observeNotificationEntries ?? context.room.observeEntries?.bind(context.room);
  if (!viewer || !context.conversations || !observeEntries) return () => undefined;
  const update = () => {
    const channels = context.conversations!.snapshot(context.principal.ownerId, context.generation) ?? [];
    const joined = new Set(channels.map(channel => channel.id));
    for (const [id, remove] of subscriptions) if (!joined.has(id)) { remove(); subscriptions.delete(id); }
    for (const channel of channels) {
      if (subscriptions.has(channel.id)) continue;
      const roomId = channel.id as RoomId;
      const seen = new Set<string>();
      let queue = Promise.resolve();
      let active = true;
      const pending = new Map<string, TimelineItem>();
      let latestItems: readonly TimelineItem[] = [];
      let latestTitle = channel.title;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;
      let retries = 0;
      const processPending = () => {
        queue = queue.then(async () => {
          if (!pending.size || disposed || !active) return;
          if (preference.state() !== 'on' || !document.hidden && document.hasFocus()) { pending.clear(); return; }
          let members: readonly ParticipantView[] | null;
          try { members = context.roomParticipants ? await context.roomParticipants(roomId) : []; }
          catch { members = null; }
          if (disposed || !active) return;
          if (members === null) {
            // Keep the event pending: a temporary directory failure must not erase a channel-name mention.
            if (retryTimer === null && retries < 3) {
              retries += 1;
              retryTimer = setTimeout(() => { retryTimer = null; processPending(); }, 1000);
            }
            return;
          }
          if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
          retries = 0;
          if (preference.state() !== 'on' || !document.hidden && document.hasFocus()) { pending.clear(); return; }
          const names = projectTimelineNames(latestItems, viewer, members.map(member => ({ ...member, initialName: member.displayName })));
          const roster = new Map<string, ParticipantView>();
          for (const member of [viewer, ...members, ...latestItems.map(item => item.participant)]) if (!roster.has(member.participantId)) roster.set(member.participantId, member);
          const candidates = [...roster.values()].map(member => ({ participantId: member.participantId, kind: member.kind, hue: 0,
            label: label({ ...member, displayName: names.currentNames.get(member.participantId) ?? member.displayName }) }));
          for (const item of pending.values()) {
            if (item.participant.participantId === viewer.participantId || item.content.kind !== 'text'
              || !mentionsViewer(item.content.body, candidates, viewer.participantId)) continue;
            const attribution = names.events.find(event => event.eventId === item.ref.eventId);
            const sender = label({ ...item.participant, displayName: attribution?.kind === 'message' ? attribution.authorName : item.participant.displayName });
            const preview = `${sender}: ${item.content.body.replace(/\s+/gu, ' ').trim()}`;
            try {
              const notification = new Notification(latestTitle, {
                body: preview.length > 120 ? `${preview.slice(0, 119)}…` : preview,
                icon: document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ?? '/favicon.svg',
                tag: `khala-mention:${roomId}`,
              });
              notifications.add(notification);
              notification.onclose = () => { notifications.delete(notification); };
              notification.onclick = () => { if (!disposed && active) { window.focus(); openMessage(roomId, item.ref.eventId); } notification.close(); };
            } catch { /* Unsupported constructors and OS failures must not interrupt sync. */ }
          }
          pending.clear();
        }).catch(() => undefined);
      };
      const remove = observeEntries(roomId, view => {
        if (!active || disposed || view.generation !== context.generation || view.room?.membership !== 'joined') return;
        latestItems = view.entries.flatMap(entry => entry.kind === 'message' ? [entry.item] : []);
        latestTitle = view.room.title ?? channel.title;
        const historical = new Set(view.historicalEventIds);
        for (const entry of view.entries) {
          const id = entry.kind === 'message' ? entry.item.ref.eventId : 'eventId' in entry ? entry.eventId : null;
          if (!id) continue;
          // Keep new encrypted placeholders eligible when their decryption lands.
          if (entry.kind === 'unavailable' && !historical.has(id) && Date.parse(entry.receivedAt) >= startedAt) continue;
          if (seen.has(id)) continue;
          seen.add(id);
          if (!historical.has(id) && entry.kind === 'message' && entry.item.content.kind === 'text'
            && entry.item.participant.participantId !== viewer.participantId
            && Date.parse(entry.item.receivedAt) >= startedAt && preference.state() === 'on'
            && (document.hidden || !document.hasFocus())) pending.set(id, entry.item);
        }
        if (pending.size) processPending();
      });
      subscriptions.set(channel.id, () => { active = false; if (retryTimer !== null) clearTimeout(retryTimer); pending.clear(); remove(); });
    }
  };
  const removeIndex = context.conversations.subscribe(context.principal.ownerId, context.generation, update);
  update();
  return () => {
    disposed = true;
    removeIndex();
    for (const remove of subscriptions.values()) remove();
    for (const notification of notifications) notification.close();
  };
}

// The splash page's live demo: the product's own Khala frame, channel list,
// channel screen, roster and timeline over an in-memory demo world
// (`demo/store.ts`), composed as the design-parity fixture
// (`ui/conversation/fixture.tsx`) composes them, so the demo cannot drift from
// the app. The visitor types as a guest; nothing is sent anywhere.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import type { RoomId } from '@khala/contracts/messaging/ids';
import { ChannelScreen } from '../features/channel/ChannelScreen';
import { createChannelController } from '../features/channel/controller';
import { renderMessageContent } from '../features/timeline/message-renderer';
import { TimelineScreen, type TimelineComposerHandle } from '../features/timeline/TimelineScreen';
import type { ThemeChoice } from '../shell/types';
import { ConversationList } from '../ui/conversation';
import { KhalaApp } from '../ui/khala/KhalaApp';
import { SettingsMenu } from '../ui/khala/SettingsMenu';
import { createDemo, HUMANS, VIEWER, WELCOME_CHANNEL, type Demo } from './demo/store';
import '../brand/fonts.css';
import '../brand/tokens.css';
// Carries `.sr-only`, which the channel title uses.
import '../shell/shell.css';
import '../ui/khala/khala-app.css';
import '../features/timeline/timeline.css';
import '../features/channel/channel.css';
import './showcase.css';

/** The splash's theme, which the demo follows: `<html data-theme>`, set by the page's toggle. */
function usePageTheme(): ThemeChoice {
  const read = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const [theme, setTheme] = useState<ThemeChoice>(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** The demo's theme switch is the page's own toggle, so the two never disagree. */
function changePageTheme(next: ThemeChoice): void {
  if (document.documentElement.dataset.theme === next) return;
  const toggle = document.querySelector<HTMLButtonElement>('#themeToggle');
  if (toggle) toggle.click();
  else document.documentElement.dataset.theme = next;
}

export function ProductDemo({ demo: provided }: Readonly<{ demo?: Demo }>) {
  const demo = useMemo(() => provided ?? createDemo(), [provided]);
  useEffect(() => () => { if (!provided) demo.dispose(); }, [demo, provided]);
  useSyncExternalStore(demo.subscribe, demo.version, demo.version);
  const theme = usePageTheme();
  const [selected, setSelected] = useState(WELCOME_CHANNEL);
  const [inThread, setInThread] = useState(true);
  const [query, setQuery] = useState('');
  const composer = useRef<TimelineComposerHandle>(null);
  const roomId = selected as RoomId;
  const controller = useMemo(() => createChannelController(demo.presence(selected), { roomId, generation: 1 }), [demo, selected, roomId]);
  const timeline = useMemo(() => demo.timeline(selected), [demo, selected]);
  const port = useMemo(() => demo.port(selected), [demo, selected]);
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => { demo.open(selected); }, [demo, selected]);
  // A channel opens at its latest messages, once the fonts have set the rows' heights.
  useEffect(() => {
    let cancelled = false;
    void document.fonts.ready.then(() => requestAnimationFrame(() => {
      const thread = document.querySelector<HTMLElement>('#kh-card .kh-thread');
      if (thread && !cancelled) thread.scrollTop = thread.scrollHeight;
    }));
    return () => { cancelled = true; };
  }, [selected]);

  return <KhalaApp theme={theme} onThemeChange={changePageTheme} homeHref="#exampleShowcase" inThread={inThread}
    embedded={{ label: 'Khala demo' }}
    brandMenu={<SettingsMenu theme={theme} onThemeChange={changePageTheme} username={null} />}
    list={<ConversationList conversations={demo.summaries()} selectedId={selected} query={query} onQueryChange={setQuery} status="ready"
      viewerOwnerId={HUMANS.guest.ownerId}
      onSelect={id => { setSelected(id); setInThread(true); }} />}
    main={<ChannelScreen key={selected} title={demo.title(selected)} controller={controller} headingLevel={2}
      viewerOwnerId={HUMANS.guest.ownerId} viewerName={VIEWER.displayName} viewerParticipantId={VIEWER.participantId} viewerColor={HUMANS.guest.color}
      humanParticipants={demo.humanParticipants(selected)} describeParticipant={demo.describeParticipant}
      modeFor={demo.modeFor} onSetMode={demo.setMode} renameAgent={demo.rename}
      recentActivity={(participantId, render) => timeline.getSnapshot().items
        .flatMap(item => item.content.kind === 'text' && item.ref.authorParticipantId === participantId
          ? [{ id: item.ref.eventId, at: item.receivedAt, body: renderMessageContent(item.content, render) }] : [])
        .slice(-3).reverse()}
      onMention={label => composer.current?.insertMention(label)}
      onRosterOpen={() => composer.current?.closeChips()}
      onBack={() => setInThread(false)}
      renderTimeline={(openParticipant, openInvite, onMentionRoster) => <TimelineScreen key={selected}
        controller={timeline} roomPort={port} roomId={roomId} viewer={VIEWER} members={demo.members(selected)} composerRef={composer}
        describeParticipant={demo.describeParticipant} onOpenParticipant={openParticipant} onMentionRoster={onMentionRoster}
        {...(openInvite ? { onInvite: openInvite } : {})} />} />} />;
}

export function mountExampleShowcase(element: HTMLElement): void {
  createRoot(element).render(<ProductDemo />);
}

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChannelScreen } from './ChannelScreen';
import type { ChannelController } from './controller';

const controller: ChannelController = {
  getSnapshot: () => ({ phase: 'ready', agents: [] }),
  subscribe: () => () => {},
  dispose: () => {},
};

describe('ChannelScreen', () => {
  it('shows verified counts and a checking state in the compact header', () => {
    const people = [{ participantId: 'human_2' as never, displayName: 'A long participant name' },
      { participantId: 'human_3' as never, displayName: 'Theo' }];
    const agents = Array.from({ length: 4 }, (_, index) => ({ participantId: `agent_${index}` as never,
      displayName: 'Scout', ownerDisplayName: 'Mira', connection: 'unknown' as const,
      routeLabel: 'Channel agent', acknowledgement: 'unknown' as const, lastReceipt: null,
      installCommand: null, installCommandError: false }));
    const ready = renderToStaticMarkup(<ChannelScreen title="A long conversation title" viewerName="Mira"
      humanParticipants={people} controller={{ ...controller, getSnapshot: () => ({ phase: 'ready', agents }) }} renderTimeline={() => null} />);
    expect(ready).toContain('3 humans · 4 agents');
    const loading = renderToStaticMarkup(<ChannelScreen title="A long conversation title" viewerName="Mira"
      humanParticipants={people} controller={{ ...controller, getSnapshot: () => ({ phase: 'loading', agents }) }} renderTimeline={() => null} />);
    expect(loading).toContain('class="channel-participants__compact" role="status">Checking participants…');
    expect(loading).not.toContain('3 humans · 4 agents');
  });
  it('keeps Matrix routing IDs out of participant names', () => {
    const agentController: ChannelController = {
      ...controller,
      getSnapshot: () => ({ phase: 'ready', agents: [{ participantId: 'agent_1' as never,
        displayName: '@khala_a_test:matrix.example.test', ownerDisplayName: 'Mira', connection: 'unknown',
        routeLabel: 'Channel agent', acknowledgement: 'unknown', lastReceipt: null,
        installCommand: null, installCommandError: false }] }),
    };
    const html = renderToStaticMarkup(<ChannelScreen title="Release channel" viewerName="@mira:matrix.example.test"
      controller={agentController} renderTimeline={() => null} />);
    expect(html).not.toContain('@khala_a_test:matrix.example.test');
    expect(html).not.toContain('@mira:matrix.example.test');
    expect(html).toContain('Agent');
  });

  it('uses a readable agent fallback instead of proof-key labels or connection noise', () => {
    const agentController: ChannelController = {
      ...controller,
      getSnapshot: () => ({ phase: 'ready', agents: [{ participantId: 'agent_1' as never,
        displayName: 'proof-key:abc123', ownerDisplayName: 'Mira', connection: 'unknown',
        routeLabel: 'Channel agent', acknowledgement: 'unknown', lastReceipt: null,
        installCommand: null, installCommandError: false }] }),
    };
    const html = renderToStaticMarkup(<ChannelScreen title="Release channel" viewerName="Mira"
      controller={agentController} renderTimeline={() => null} />);
    expect(html).toContain('Agent');
    expect(html).not.toContain('proof-key');
    expect(html).not.toContain('Unavailable');
  });

  it('composes every feature through an injected render slot inside hosted shell content', () => {
    const html = renderToStaticMarkup(
      <ChannelScreen
        title="Release channel"
        description="Humans and agents working together."
        viewerName="Mira"
        controller={controller}
        renderTimeline={() => <div data-slot="timeline">Timeline slot</div>}
      />,
    );

    expect(html).toContain('khala-content-root');
    expect(html).toContain('Release channel');
    expect(html).toContain('Timeline slot');
    expect(html).toContain('Mira');
    expect(html).not.toContain('aria-label="Channel details"');
    expect(html).not.toContain('conversation-detail');
    expect(html).not.toContain('Agent presence');
  });
});

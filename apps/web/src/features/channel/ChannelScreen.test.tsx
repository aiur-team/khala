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

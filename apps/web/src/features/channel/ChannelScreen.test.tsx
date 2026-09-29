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
        controller={controller}
        renderTimeline={() => <div data-slot="timeline">Timeline slot</div>}
        renderReview={() => <div data-slot="review">Review slot</div>}
        renderControls={() => <div data-slot="controls">Controls slot</div>}
      />,
    );

    expect(html).toContain('khala-content-root');
    expect(html).toContain('Release channel');
    expect(html).toContain('Timeline slot');
    expect(html).not.toContain('aria-label="Channel details"');
    expect(html).not.toContain('conversation-detail');
    expect(html).not.toContain('Review slot');
    expect(html).not.toContain('Controls slot');
    expect(html).not.toContain('Agent presence');
  });
});

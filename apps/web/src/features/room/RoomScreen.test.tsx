import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RoomScreen } from './RoomScreen';
import type { RoomController } from './controller';

const controller: RoomController = {
  getSnapshot: () => ({ phase: 'ready', agents: [] }),
  subscribe: () => () => {},
  dispose: () => {},
};

describe('RoomScreen', () => {
  it('composes every feature through an injected render slot inside hosted shell content', () => {
    const html = renderToStaticMarkup(
      <RoomScreen
        title="Release room"
        description="Humans and agents working together."
        controller={controller}
        renderTimeline={() => <div data-slot="timeline">Timeline slot</div>}
        renderReview={() => <div data-slot="review">Review slot</div>}
        renderControls={() => <div data-slot="controls">Controls slot</div>}
      />,
    );

    expect(html).toContain('khala-content-root');
    expect(html).toContain('Release room');
    expect(html).toContain('Timeline slot');
    expect(html).toContain('Review slot');
    expect(html).toContain('Controls slot');
    expect(html).toContain('Agent presence');
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ParticipantId } from '@khala/contracts/messaging/ids';
import { AgentPresencePanel } from './AgentPresencePanel';
import type { RoomController, RoomView } from './controller';

function controller(view: RoomView): RoomController {
  return {
    getSnapshot: () => view,
    subscribe: () => () => {},
    dispose: () => {},
  };
}

describe('AgentPresencePanel', () => {
  it('announces loading rather than describing an empty ready room', () => {
    const html = renderToStaticMarkup(
      <AgentPresencePanel controller={controller({ phase: 'loading', agents: [] })} />,
    );
    expect(html).toContain('Loading…');
    expect(html).not.toContain('No agents have joined');
  });

  it('puts onboarding first when no agent is connected and shows owner, route, and receipt truthfully', () => {
    const html = renderToStaticMarkup(
      <AgentPresencePanel controller={controller({
        phase: 'ready',
        agents: [{
          participantId: 'agent_1' as ParticipantId,
          displayName: 'Scout',
          ownerDisplayName: 'Mira',
          connection: 'offline',
          routeLabel: 'Khala skill',
          lastReceipt: { kind: 'harness_queued', observedAt: '2026-09-18T14:31:02.402Z' },
          installCommand: 'khala connect https://khala.example/r/one',
          installCommandError: false,
        }],
      })} />,
    );

    expect(html.indexOf('Connect Scout')).toBeLessThan(html.indexOf('Owned by Mira'));
    expect(html).toContain('Khala skill');
    expect(html).toContain('Queued at the agent session');
    expect(html).not.toContain('Read by the agent');
    expect(html).toContain('Copy install command');
  });

  it('keeps unsupported visible and never offers onboarding for a connected agent', () => {
    const html = renderToStaticMarkup(
      <AgentPresencePanel controller={controller({
        phase: 'ready',
        agents: [{
          participantId: 'agent_2' as ParticipantId,
          displayName: 'Builder',
          ownerDisplayName: 'Noah',
          connection: 'connected',
          routeLabel: 'Unsupported',
          lastReceipt: null,
          installCommand: null,
          installCommandError: false,
        }],
      })} />,
    );

    expect(html).toContain('Connected');
    expect(html).toContain('Unsupported');
    expect(html).not.toContain('Copy install command');
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ParticipantId } from '@khala/contracts/messaging/ids';
import { AgentPresencePanel } from './AgentPresencePanel';
import type { ChannelController, ChannelView } from './controller';

function controller(view: ChannelView): ChannelController {
  return {
    getSnapshot: () => view,
    subscribe: () => () => {},
    dispose: () => {},
  };
}

describe('AgentPresencePanel', () => {
  it('announces loading rather than describing an empty ready channel', () => {
    const html = renderToStaticMarkup(
      <AgentPresencePanel controller={controller({ phase: 'loading', agents: [] })} />,
    );
    expect(html).toContain('Loading…');
    expect(html).not.toContain('No agents have joined');
  });

  it('distinguishes a failed presence read from an empty ready channel', () => {
    const html = renderToStaticMarkup(
      <AgentPresencePanel controller={controller({ phase: 'unavailable', agents: [] })} />,
    );
    expect(html).toContain('Agent presence is unavailable right now.');
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

  it('offers fallback onboarding while the native route is unsupported', () => {
    const html = renderToStaticMarkup(
      <AgentPresencePanel controller={controller({
        phase: 'ready',
        agents: [{
          participantId: 'agent_3' as ParticipantId,
          displayName: 'Scout',
          ownerDisplayName: 'Mira',
          connection: 'offline',
          routeLabel: 'Khala skill (native route unsupported)',
          lastReceipt: null,
          installCommand: 'khala connect https://khala.example/r/one',
          installCommandError: false,
        }],
      })} />,
    );
    expect(html).toContain('native route unsupported');
    expect(html).toContain('Copy install command');
  });

  it('renders expired liveness as stale instead of connected', () => {
    const html = renderToStaticMarkup(
      <AgentPresencePanel controller={controller({
        phase: 'ready',
        agents: [{
          participantId: 'agent_4' as ParticipantId,
          displayName: 'Scout',
          ownerDisplayName: 'Mira',
          connection: 'stale',
          routeLabel: 'Codex CLI',
          lastReceipt: null,
          installCommand: 'khala connect https://khala.example/r/one',
          installCommandError: false,
        }],
      })} />,
    );
    expect(html).toContain('Connection stale');
    expect(html).not.toMatch(/>Connected</);
  });

  it('renders an unknown connection as unknown instead of connected', () => {
    const html = renderToStaticMarkup(
      <AgentPresencePanel controller={controller({
        phase: 'ready',
        agents: [{
          participantId: 'agent_5' as ParticipantId,
          displayName: 'Scout',
          ownerDisplayName: 'Mira',
          connection: 'unknown',
          routeLabel: 'Khala skill',
          lastReceipt: null,
          installCommand: null,
          installCommandError: true,
        }],
      })} />,
    );
    expect(html).toContain('Connection unknown');
    expect(html).not.toMatch(/>Connected</);
  });

  it('renders an unknown connection with a neutral tone', () => {
    const html = renderToStaticMarkup(
      <AgentPresencePanel controller={controller({
        phase: 'ready',
        agents: [{
          participantId: 'agent_6' as ParticipantId,
          displayName: 'Scout',
          ownerDisplayName: 'Mira',
          connection: 'unknown',
          routeLabel: 'Khala skill',
          lastReceipt: null,
          installCommand: null,
          installCommandError: true,
        }],
      })} />,
    );
    expect(html).toContain('status-badge--neutral');
    expect(html).not.toContain('status-badge--positive');
  });

  it('renders a queued receipt as queued rather than read', () => {
    const html = renderToStaticMarkup(
      <AgentPresencePanel controller={controller({
        phase: 'ready',
        agents: [{
          participantId: 'agent_7' as ParticipantId,
          displayName: 'Scout',
          ownerDisplayName: 'Mira',
          connection: 'offline',
          routeLabel: 'Khala skill',
          lastReceipt: { kind: 'queued', observedAt: '2026-09-18T14:31:02.402Z' },
          installCommand: 'khala connect https://khala.example/r/one',
          installCommandError: false,
        }],
      })} />,
    );
    expect(html).toContain('Queued for delivery');
    expect(html).not.toContain('Read by the agent');
  });
});

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
          acknowledgement: 'unknown',
          installCommand: 'khala connect https://khala.example/r/one',
          installCommandError: false,
        }],
      })} />,
    );

    expect(html.indexOf('Connect Scout')).toBeLessThan(html.indexOf('Owned by Mira'));
    expect(html).toContain('Khala skill');
    expect(html).toContain('Queued at agent session');
    expect(html).toContain('Batch-token return support not verified');
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
          acknowledgement: 'unknown',
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
          acknowledgement: 'unknown',
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
          acknowledgement: 'unknown',
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
          acknowledgement: 'unknown',
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
          acknowledgement: 'unknown',
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
          acknowledgement: 'unknown',
          installCommand: 'khala connect https://khala.example/r/one',
          installCommandError: false,
        }],
      })} />,
    );
    expect(html).toContain('Queued for delivery');
    expect(html).not.toContain('Read by the agent');
  });

  it.each([
    ['unknown', 'Batch-token return support not verified'],
    ['unsupported', 'Batch-token return not supported'],
    ['batch_token_next_call', 'Batch-token return supported'],
  ] as const)('renders the %s acknowledgement capability as its own closed copy', (acknowledgement, label) => {
    const html = renderToStaticMarkup(
      <AgentPresencePanel controller={controller({
        phase: 'ready',
        agents: [{
          participantId: 'agent_1' as ParticipantId,
          displayName: 'Scout',
          ownerDisplayName: 'Mira',
          connection: 'connected',
          routeLabel: 'Codex CLI',
          lastReceipt: null,
          acknowledgement,
          installCommand: null,
          installCommandError: false,
        }],
      })} />,
    );
    expect(html).toContain(`<dd>${label}</dd>`);
    // A supported route with no receipt is neutral: no error, unread or absence claim.
    expect(html).toContain('No delivery receipt yet');
    expect(html).not.toMatch(/unread|No token-return fact|role="alert"/i);
  });

  it('labels context insertion truthfully and never as read', () => {
    const html = renderToStaticMarkup(
      <AgentPresencePanel controller={controller({
        phase: 'ready',
        agents: [{
          participantId: 'agent_1' as ParticipantId,
          displayName: 'Scout',
          ownerDisplayName: 'Mira',
          connection: 'connected',
          routeLabel: 'Codex CLI',
          lastReceipt: { kind: 'context_consumed', observedAt: '2026-09-18T14:31:02.402Z' },
          acknowledgement: 'batch_token_next_call',
          installCommand: null,
          installCommandError: false,
        }],
      })} />,
    );
    expect(html).toContain('Added to agent context');
    expect(html).not.toMatch(/read by the agent|Batch token returned/i);
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
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
  it('uses a generic roster label when the only supplied agent name is a Matrix ID', () => {
    const html = renderToStaticMarkup(<AgentPresencePanel controller={controller({ phase: 'ready', agents: [{
      participantId: 'agent_1' as ParticipantId, displayName: '@khala_a_test:matrix.example.test', ownerDisplayName: 'Mira',
      connection: 'unknown', routeLabel: 'Channel agent', acknowledgement: 'unknown', lastReceipt: null,
      installCommand: null, installCommandError: false,
    }] })} />);
    expect(html).toContain('aria-label="Details for Agent, Connection unknown"');
    expect(html).not.toContain('@khala_a_test:matrix.example.test');
  });

  it('uses a readable owner fallback in details when the supplied owner name is a Matrix ID', () => {
    const html = renderToStaticMarkup(<AgentPresencePanel controller={controller({ phase: 'ready', agents: [{
      participantId: 'agent_1' as ParticipantId, displayName: 'Scout', ownerDisplayName: '@mira:matrix.example.test',
      connection: 'unknown', routeLabel: 'Channel agent', acknowledgement: 'unknown', lastReceipt: null,
      installCommand: null, installCommandError: false,
    }] })} />);
    expect(html).toContain('Owned by Channel member');
    expect(html).not.toContain('@mira:matrix.example.test');
  });

  it('shows the encrypted current name and edit control only to the bound owner', () => {
    const ownerId = 'owner_maya' as OwnerId;
    const agentId = 'agent_420' as ParticipantId;
    const agent = { participantId: agentId, ownerId, displayName: 'Codex #420', ownerDisplayName: 'Maya',
      connection: 'connected' as const, routeLabel: 'Codex CLI', lastReceipt: null,
      acknowledgement: 'unknown' as const, installCommand: null, installCommandError: false };
    const props = { controller: controller({ phase: 'ready', agents: [agent] }), renameScope: 'room_1',
      currentNames: new Map([[agentId, 'Dolan']]), renameAgent: async () => 'accepted' as const };
    const owner = renderToStaticMarkup(<AgentPresencePanel {...props} viewerOwnerId={ownerId} />);
    const other = renderToStaticMarkup(<AgentPresencePanel {...props} viewerOwnerId={'owner_theo' as OwnerId} />);
    expect(owner).toContain('Dolan');
    expect(owner).toContain('Edit name for Dolan');
    expect(other).toContain('Dolan');
    expect(other).not.toContain('Edit name');
  });

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

  it('keeps setup and diagnostics in agent details while showing connection in the roster', () => {
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

    expect(html).toContain('aria-label="Details for Scout, Not connected"');
    expect(html.indexOf('Connection stale')).toBe(-1);
    expect(html.indexOf('Owned by Mira')).toBeGreaterThan(html.indexOf('</summary>'));
    expect(html).not.toMatch(/>agent_1</);
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

  it('renders an unknown connection without a connected tone', () => {
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
    expect(html).toContain('agent-presence__status--unknown');
    expect(html).not.toContain('agent-presence__status--connected');
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

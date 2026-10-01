import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import { AgentPresencePanel } from './AgentPresencePanel';
import type { ChannelAgentView, ChannelController, ChannelView } from './controller';

const ownerId = 'owner_maya' as OwnerId;
const otherId = 'owner_theo' as OwnerId;
const agentId = 'agent_scout' as ParticipantId;
const agent: ChannelAgentView = {
  participantId: agentId, ownerId, displayName: 'Scout', ownerDisplayName: 'Maya',
  connection: 'offline', routeLabel: 'Khala skill', acknowledgement: 'unknown',
  lastReceipt: { kind: 'queued', observedAt: '2026-09-18T14:31:02.402Z' },
  installCommand: 'khala connect https://khala.example/r/one', installCommandError: false,
};

function controller(view: ChannelView): ChannelController {
  return { getSnapshot: () => view, subscribe: () => () => {}, dispose: () => {} };
}
function render(viewerOwnerId?: OwnerId, item: ChannelAgentView = agent, renderOwnerControls?: (agent: ChannelAgentView) => string) {
  return renderToStaticMarkup(<AgentPresencePanel controller={controller({ phase: 'ready', agents: [item] })}
    {...(viewerOwnerId ? { viewerOwnerId } : {})} renameScope="room_1"
    renameAgent={async () => 'accepted'} {...(renderOwnerControls ? { renderOwnerControls } : {})} />);
}

describe('AgentPresencePanel', () => {
  it('gives same-named agents distinct keyboard-selectable identities', () => {
    const agents = [agent, { ...agent, participantId: 'agent_other' as ParticipantId }];
    const html = renderToStaticMarkup(<AgentPresencePanel controller={controller({ phase: 'ready', agents })} />);
    expect(html).toContain('Details for Scout (agent 1)');
    expect(html).toContain('Details for Scout (agent 2)');
    expect(html.match(/<summary /g)).toHaveLength(2);
  });

  it('shows a readable identity without technical connection diagnostics', () => {
    const html = render(otherId);
    expect(html).toContain('Details for Scout');
    expect(html).not.toContain('Not connected');
    expect(html).toContain('Maya’s agent');
    for (const diagnostic of ['Route', 'Batch-token return', 'Last receipt', 'Queued for delivery', 'Khala skill']) {
      expect(html).not.toContain(diagnostic);
    }
    expect(html).not.toContain('Copy install command');
  });

  it('puts the owner controls, rename, and onboarding inside only the owning human’s detail', () => {
    const controls = vi.fn(() => 'Listening controls');
    const own = render(ownerId, agent, controls);
    expect(own).toContain('Your agent');
    expect(own).toContain('Listening controls');
    expect(own).toContain('Edit name for Scout');
    expect(own).toContain('Copy install command');
    expect(own.indexOf('Listening controls')).toBeGreaterThan(own.indexOf('</summary>'));
    expect(controls).toHaveBeenCalledWith(agent);
    controls.mockClear();
    const other = render(otherId, agent, controls);
    expect(other).not.toContain('Listening controls');
    expect(other).not.toContain('Edit name');
    expect(other).not.toContain('Copy install command');
    expect(controls).not.toHaveBeenCalled();
  });

  it('never turns an unverified connection into Connected', () => {
    const html = render(ownerId, { ...agent, connection: 'unknown' });
    expect(html).toContain('Details for Scout');
    expect(html).not.toContain('Connection unavailable');
    expect(html).not.toContain('Connection unknown');
    expect(html).not.toMatch(/>Connected</);
  });

  it('hides Matrix routing IDs and uses a human-readable fallback', () => {
    const html = render(otherId, { ...agent, displayName: '@khala:matrix.example.test', ownerDisplayName: '@maya:matrix.example.test' });
    expect(html).toContain('Details for Agent');
    expect(html).toContain('Another member’s agent');
    expect(html).not.toContain('@khala:matrix.example.test');
    expect(html).not.toContain('@maya:matrix.example.test');
  });

  it('hides proof-key labels in agent details', () => {
    const html = render(otherId, { ...agent, displayName: 'proof-key:abc123', connection: 'unknown' });
    expect(html).toContain('Details for Agent');
    expect(html).not.toContain('proof-key');
    expect(html).not.toContain('Connection unavailable');
  });

  it('announces loading and failed presence reads distinctly', () => {
    const loading = renderToStaticMarkup(<AgentPresencePanel controller={controller({ phase: 'loading', agents: [] })} />);
    const unavailable = renderToStaticMarkup(<AgentPresencePanel controller={controller({ phase: 'unavailable', agents: [] })} />);
    expect(loading).toContain('Loading…');
    expect(unavailable).toContain('Agent presence is unavailable right now.');
    expect(unavailable).not.toContain('No agents have joined');
  });
});

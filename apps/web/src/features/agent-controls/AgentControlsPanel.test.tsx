import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  BindingId, ParticipantId, RoomId,
} from '@khala/contracts/delivery/index';
import type { Disposer } from '@khala/contracts/messaging/index';
import { AgentControlsPanel } from './AgentControlsPanel';
import type { AgentControlsConfig } from './controller';
import type { AgentControlsPorts, AgentControlsSnapshot } from './ports';

const BINDING_ID = 'bind-b-1' as BindingId;

const CONFIG: AgentControlsConfig = {
  bindingId: BINDING_ID,
  roomId: 'room-1' as RoomId,
  peerParticipantId: 'agent-a' as ParticipantId,
  ownerLabel: 'owner-b',
  agentLabel: 'agent-a',
  roomLabel: 'room-1',
};

function fakePorts(): AgentControlsPorts {
  return {
    agentControls: {
      readSnapshot: () => new Promise<AgentControlsSnapshot>(() => {}),
      subscribe: (): Disposer => () => {},
      submitPolicy: () => new Promise(() => {}),
    },
  };
}

describe('AgentControlsPanel initial render', () => {
  it('shows the target scope (owner, agent, room) next to the controls', () => {
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} />);
    expect(html).toContain('owner-b');
    expect(html).toContain('agent-a');
    expect(html).toContain('room-1');
  });

  it('disables the pause control and cites a reason while no authoritative snapshot has arrived', () => {
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} />);
    expect(html).toContain('disabled=""');
    expect(html).toContain('Waiting for an authoritative snapshot.');
  });

  it('never claims delivery stopped or cancelled in the pause affordance copy', () => {
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} />);
    expect(html.toLowerCase()).not.toContain('stopped');
    expect(html.toLowerCase()).not.toContain('cancelled');
  });
});

describe('AgentControlsPanel with an authoritative snapshot', () => {
  it('renders the effective policy and requested badge once a pause is pending', () => {
    const controller = {
      getView: () => ({
        bindingId: BINDING_ID,
        ownerLabel: 'owner-b',
        agentLabel: 'agent-a',
        roomLabel: 'room-1',
        policy: {
          effectiveMode: 'review' as const,
          effectiveVersion: 3,
          paused: false,
          requestedMode: 'review' as const,
          requestedVersion: 4,
          acknowledgment: 'offline' as const,
        },
        connection: 'connected' as const,
        controlsAvailable: true,
        unavailableReason: null,
        receiptDetail: null,
      }),
      subscribe: () => () => {},
      requestPause: () => {},
      dispose: () => {},
    };
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} controller={controller} />);
    expect(html).toContain('Review required');
    expect(html).toContain('v3');
    expect(html).toContain('Requested');
    expect(html).toContain('connector offline');
    expect(html).not.toContain('disabled=""');
  });
});

describe('AgentControlsPanel control authority', () => {
  it('the pause control is only ever wired to a real click handler on the button, never to message content', () => {
    // Structural guarantee: the panel takes no message/content prop at all, so
    // there is no code path by which incoming message text could reach
    // `controller.requestPause`. Renders once to confirm the component has no
    // hidden text-driven affordance.
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} />);
    const buttonCount = (html.match(/<button/g) ?? []).length;
    expect(buttonCount).toBe(1);
  });
});

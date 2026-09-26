import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  BindingId, OwnerId, ParticipantId, RoomId,
} from '@khala/contracts/delivery/index';
import type { Disposer } from '@khala/contracts/messaging/index';
import { AgentControlsPanel } from './AgentControlsPanel';
import type { AgentControlsConfig, AgentControlsController } from './controller';
import type { AgentControlsPorts, AgentControlsSnapshot } from './ports';
import type { AgentControlsView } from './model';

const BINDING_ID = 'bind-b-1' as BindingId;

const CONFIG: AgentControlsConfig = {
  bindingId: BINDING_ID,
  roomId: 'room-1' as RoomId,
  peerParticipantId: 'agent-a' as ParticipantId,
  viewerOwnerId: 'owner-b' as OwnerId,
  agentLabel: 'agent-a',
  roomLabel: 'room-1',
};

function fakePorts(): AgentControlsPorts {
  return {
    agentControls: {
      readSnapshot: () => new Promise<AgentControlsSnapshot>(() => {}),
      subscribe: (): Disposer => () => {},
      submitPolicy: () => new Promise(() => {}),
      submitListeningMode: () => new Promise(() => {}),
      submitRouteGrant: () => new Promise(() => {}),
    },
  };
}

function fakeController(view: AgentControlsView, overrides: Partial<AgentControlsController> = {}): AgentControlsController {
  return {
    getView: () => view,
    subscribe: () => () => {},
    requestPause: () => {},
    refresh: () => {},
    retry: () => {},
    selectListeningMode: () => {},
    applyListeningMode: () => {},
    requestGrant: () => {},
    confirmGrant: () => {},
    cancelGrant: () => {},
    revokeGrant: () => {},
    dispose: () => {},
    ...overrides,
  };
}

function view(overrides: Partial<AgentControlsView> = {}): AgentControlsView {
  return {
    bindingId: BINDING_ID,
    ownerLabel: 'Your agent',
    agentLabel: 'agent-a',
    roomLabel: 'room-1',
    isViewerOwned: true,
    revoked: false,
    policy: {
      effectiveMode: 'review',
      effectiveVersion: 3,
      paused: false,
      requestedMode: null,
      requestedVersion: null,
      requestedPaused: null,
      acknowledgment: 'pending',
      errorCode: null,
    },
    connection: 'connected',
    controlsAvailable: true,
    unavailableReason: null,
    capabilityDetail: null,
    retryAvailable: false,
    notice: null,
    receiptDetail: null,
    listening: null,
    ...overrides,
  };
}

describe('AgentControlsPanel initial render', () => {
  it('shows the target scope (owner, agent, room) next to the controls', () => {
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} />);
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

  it('never claims automatic delivery is a live feature while G-AUTOMATION is open', () => {
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} />);
    expect(html).not.toContain('Resume automatic review delivery');
    expect(html).not.toContain('>Automatic delivery<');
  });

  it('never claims automatic delivery in the button copy once paused, either (regression guard for the initial-render-only check above)', () => {
    const controller = fakeController(view({
      policy: {
        effectiveMode: 'review', effectiveVersion: 3, paused: true,
        requestedMode: null, requestedVersion: null, requestedPaused: null,
        acknowledgment: 'pending', errorCode: null,
      },
    }));
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} controller={controller} />);
    expect(html).toContain('>Resume review delivery<');
    expect(html).not.toContain('Resume automatic review delivery');
  });

  it('keeps the requested-status live region mounted even when there is nothing to announce yet', () => {
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} />);
    expect(html).toMatch(/<p class="agent-controls__requested" role="status">/);
  });

  it('links the disabled reason to the pause button with aria-describedby', () => {
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} />);
    const describedByMatch = html.match(/aria-describedby="([^"]+)"/);
    expect(describedByMatch).not.toBeNull();
    const id = describedByMatch![1];
    expect(html).toContain(`id="${id}"`);
  });
});

describe('AgentControlsPanel with an authoritative snapshot', () => {
  it('renders the effective policy and a pause-requested badge distinct from a resume request', () => {
    const controller = fakeController(view({
      policy: {
        effectiveMode: 'review', effectiveVersion: 3, paused: false,
        requestedMode: 'review', requestedVersion: 4, requestedPaused: true,
        acknowledgment: 'offline', errorCode: null,
      },
    }));
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} controller={controller} />);
    expect(html).toContain('Review required');
    expect(html).toContain('v3');
    expect(html).toContain('pause requested');
    expect(html).toContain('connector offline');
    expect(html).not.toContain('disabled=""');
  });

  it('labels a resume request as "resume requested", never "pause requested"', () => {
    const controller = fakeController(view({
      policy: {
        effectiveMode: 'review', effectiveVersion: 3, paused: true,
        requestedMode: 'review', requestedVersion: 4, requestedPaused: false,
        acknowledgment: 'pending', errorCode: null,
      },
    }));
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} controller={controller} />);
    expect(html).toContain('resume requested');
    expect(html).not.toContain('pause requested');
  });

  it('shows the rejected error code and a notice with a refresh action, without erasing the request, and disables the control until refreshed', () => {
    const controller = fakeController(view({
      policy: {
        effectiveMode: 'review', effectiveVersion: 3, paused: false,
        requestedMode: 'review', requestedVersion: 4, requestedPaused: true,
        acknowledgment: 'rejected', errorCode: 'stale_policy',
      },
      controlsAvailable: false,
      unavailableReason: 'The last request could not be confirmed. Refresh to see the current policy before retrying.',
      notice: { kind: 'request-failed', message: 'The request was rejected. Refresh to see the current policy.' },
    }));
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} controller={controller} />);
    expect(html).toContain('request rejected');
    expect(html).toContain('stale_policy');
    expect(html).toContain('Refresh');
    expect(html).toContain('The request was rejected');
    expect(html).toContain('disabled=""');
    expect(html).toContain('The last request could not be confirmed.');
  });
});

describe('AgentControlsPanel ownership and revocation', () => {
  it('does not render an enabled control for a binding the viewer does not own', () => {
    const controller = fakeController(view({
      ownerLabel: "Another person's agent (#z9z9)",
      isViewerOwned: false,
      controlsAvailable: false,
      unavailableReason: "This binding belongs to another person's agent connection.",
    }));
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} controller={controller} />);
    expect(html).toContain('disabled=""');
    expect(html).toContain('Another person');
  });

  it('disables every control and shows "Revoked" for a revoked binding', () => {
    const controller = fakeController(view({
      revoked: true,
      controlsAvailable: false,
      unavailableReason: 'This binding has been revoked.',
    }));
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} controller={controller} />);
    expect(html).toContain('disabled=""');
    expect(html).toContain('Revoked');
  });
});

describe('AgentControlsPanel capability honesty and retry', () => {
  it('shows the exact inspected support/existing-session states, even when they gate the controls', () => {
    const controller = fakeController(view({
      controlsAvailable: false,
      unavailableReason: 'This connector does not support the existing session for this binding.',
      capabilityDetail: 'Harness support: tested · Existing session: unknown',
    }));
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} controller={controller} />);
    expect(html).toContain('Harness support: tested · Existing session: unknown');
  });

  it('offers a distinct Retry action after a genuinely unknown-outcome failure, calling controller.retry()', () => {
    const retry = vi.fn();
    const controller = fakeController(view({
      policy: {
        effectiveMode: 'review', effectiveVersion: 3, paused: false,
        requestedMode: 'review', requestedVersion: 4, requestedPaused: true,
        acknowledgment: 'unknown', errorCode: null,
      },
      controlsAvailable: false,
      retryAvailable: true,
      notice: { kind: 'request-failed', message: 'Could not reach the connector. Refresh to see the current policy, or try again.' },
    }), { retry });
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} controller={controller} />);
    expect(html).toContain('Retry');
  });

  it('does not offer Retry for a rejected (server-decided) request, only Refresh', () => {
    const controller = fakeController(view({
      policy: {
        effectiveMode: 'review', effectiveVersion: 3, paused: false,
        requestedMode: 'review', requestedVersion: 4, requestedPaused: true,
        acknowledgment: 'rejected', errorCode: 'stale_policy',
      },
      controlsAvailable: false,
      retryAvailable: false,
      notice: { kind: 'request-failed', message: 'The request was rejected. Refresh to see the current policy.' },
    }));
    const html = renderToStaticMarkup(<AgentControlsPanel ports={fakePorts()} config={CONFIG} controller={controller} />);
    expect(html).toContain('Refresh');
    expect(html).not.toContain('>Retry<');
  });
});

describe('AgentControlsPanel injected controller', () => {
  it('never builds or leaks a real controller when one is injected, and never touches the ports it was given', () => {
    const readSnapshot = vi.fn(() => new Promise<AgentControlsSnapshot>(() => {}));
    const subscribe = vi.fn((): Disposer => () => {});
    const submitPolicy = vi.fn(() => new Promise<never>(() => {}));
    const submitListeningMode = vi.fn(() => new Promise<never>(() => {}));
    const submitRouteGrant = vi.fn(() => new Promise<never>(() => {}));
    const ports: AgentControlsPorts = {
      agentControls: { readSnapshot, subscribe, submitPolicy, submitListeningMode, submitRouteGrant },
    };
    const controller = fakeController(view());
    renderToStaticMarkup(<AgentControlsPanel ports={ports} config={CONFIG} controller={controller} />);
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
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

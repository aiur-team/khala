import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  BindingId, DeliveryReceipt, HarnessCapabilities, ModeSupport, ModeSupportMap, OwnerId, ParticipantId, RoomId,
  RouteGrant,
} from '@khala/contracts/delivery/index';
import { decodeDeliveryLimits, unknownModeSupportMap } from '@khala/contracts/delivery/index';
import { AgentControlsPanel } from './AgentControlsPanel';
import { createAgentControlsController, type AgentControlsConfig, type AgentControlsController } from './controller';
import type { AgentControlsPorts, AgentControlsSnapshot, ListeningModeSnapshot } from './ports';

const BINDING_ID = 'bind-tui-1' as BindingId;
const OWNER = 'owner-b' as OwnerId;
const VERSION = '0.154.0';

const CONFIG: AgentControlsConfig = {
  bindingId: BINDING_ID,
  roomId: 'room-1' as RoomId,
  peerParticipantId: 'agent-a' as ParticipantId,
  viewerOwnerId: OWNER,
  agentLabel: 'agent-a',
  roomLabel: 'room-1',
  evidenceRegistry: { 'interactive-codex-steer': '/evidence/interactive-codex#steer' },
};

const LIMITS = (() => {
  const decoded = decodeDeliveryLimits({ maxSelectionEvents: 2, maxPayloadBytes: 4096 });
  if (!decoded.ok) throw new Error('invalid fixture limits');
  return decoded.value;
})();

const UNKNOWN = unknownModeSupportMap('interactive-codex', 'The interactive TUI route is not inventoried.', VERSION);

function support(status: 'proven' | 'experimental', mode: string, ref = `interactive-codex-${mode}`): ModeSupport {
  return {
    status, route: `interactive-codex-${mode}`, testedVersion: VERSION, evidenceRef: ref, evidenceRevision: 'rev-1',
    reason: status === 'experimental' ? 'Ordering under a busy turn is not proved.' : null,
  };
}

const PROVEN: ModeSupportMap = {
  steer: support('proven', 'steer'), sync: support('proven', 'sync'), async: support('proven', 'async'),
};

function capabilities(modes: ModeSupportMap): HarnessCapabilities {
  return {
    v: 3, harness: 'codex', version: VERSION, adapterVersion: 'khala-hosted-queue-1', support: 'tested',
    existingSession: 'khala_hosted_resume', immediateNotification: 'khala_hosted_idle', busy: 'queue',
    receiptEvidence: [], reconcileByReleaseId: 'while_queued', limits: LIMITS,
    evidenceRef: 'kha-104-hosted-app-server', modes, acknowledgement: 'batch_token_next_call',
  };
}

type Options = Readonly<{
  modes?: ModeSupportMap;
  requested?: 'steer' | 'sync' | 'async';
  effective?: 'steer' | 'sync' | 'async' | null;
  effectiveReason?: string | null;
  connection?: AgentControlsSnapshot['connection'];
  experimentalGrants?: RouteGrant[];
  hardCancelGrants?: RouteGrant[];
  hardCancel?: ModeSupport | null;
  latestReceipt?: DeliveryReceipt | null;
}>;

function snapshot(options: Options = {}): AgentControlsSnapshot {
  const modes = options.modes ?? PROVEN;
  const requested = options.requested ?? 'sync';
  const listening: ListeningModeSnapshot = {
    view: {
      bindingId: BINDING_ID, generation: 2, requested, version: 3,
      experimentalGrants: options.experimentalGrants ?? [], hardCancelGrants: options.hardCancelGrants ?? [],
      effective: options.effective === undefined ? requested : options.effective,
      effectiveReason: options.effectiveReason ?? null,
      support: modes,
    },
    lastChange: { actor: 'agent', version: 3, changedAt: '2026-09-25T00:00:00.000Z' },
    siblingBindingIds: [],
    hardCancel: options.hardCancel ?? null,
    idleDelivery: 'unproven',
  };
  return {
    binding: {
      v: 1, bindingId: BINDING_ID, ownerId: OWNER, agentParticipantId: 'agent-b' as never, deviceId: 'dev-b' as never,
      harness: 'codex', sessionId: 'tui-session', generation: 2,
    },
    bindingStatus: 'active',
    capabilities: capabilities(modes),
    policy: { bindingId: BINDING_ID, generation: 2, effectiveVersion: 3, effectiveMode: 'review', paused: false },
    connection: options.connection ?? 'connected',
    latestReceipt: options.latestReceipt ?? null,
    listening,
  };
}

function controllerFor(value: AgentControlsSnapshot): AgentControlsController {
  const ports: AgentControlsPorts = {
    agentControls: {
      readSnapshot: () => new Promise(() => {}),
      subscribe: (_bindingId, listener) => {
        listener(value);
        return () => {};
      },
      submitPolicy: () => new Promise(() => {}),
      submitListeningMode: () => new Promise(() => {}),
      submitRouteGrant: () => new Promise(() => {}),
    },
  };
  return createAgentControlsController(ports, CONFIG);
}

function render(options: Options = {}, prepare?: (controller: AgentControlsController) => void): string {
  const controller = controllerFor(snapshot(options));
  prepare?.(controller);
  const html = renderToStaticMarkup(<AgentControlsPanel ports={{} as AgentControlsPorts} config={CONFIG} controller={controller} />);
  controller.dispose();
  return html;
}

function listeningSection(html: string): string {
  const start = html.indexOf('agent-controls__listening"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</section>', start));
}

const LABEL = /Codex CLI 0\.154\.0 · [0-9a-f]{4}/;

describe('AgentControlsPanel listening section', () => {
  it('waits for listening state without offering any mode control', () => {
    const controller = controllerFor({ ...snapshot(), listening: null });
    const html = renderToStaticMarkup(<AgentControlsPanel ports={{} as AgentControlsPorts} config={CONFIG} controller={controller} />);
    expect(html).toContain('Waiting for listening-mode state for this binding.');
    expect(html).not.toContain('type="radio"');
    controller.dispose();
  });

  it('shows a green badge for a proven route on an active session, with the session label on every surface', () => {
    const section = listeningSection(render());
    expect(section).toContain('status-badge--positive');
    expect(section).toMatch(new RegExp(`<legend>Listening mode for ${LABEL.source}</legend>`));
    expect(section).toMatch(new RegExp(`Evidence for steer on ${LABEL.source}`));
    expect(section).toMatch(new RegExp(`Hard-cancel evidence for ${LABEL.source}`));
    expect(section).toContain('Requested: sync · Effective: sync');
    expect(section).toMatch(/Last changed by the agent \(Codex CLI/);
    expect(section).toContain('Idle agents receive messages only at their next turn.');
  });

  it('WRONG-IMPLEMENTATION: a hosted Codex proof never renders a green TUI badge or an enabled mode', () => {
    const section = listeningSection(render({ modes: UNKNOWN, effective: null, effectiveReason: 'support_unknown' }));
    expect(section).not.toContain('status-badge--positive');
    expect(section.match(/type="radio"[^>]*disabled=""/g)?.length).toBe(3);
    expect(section).toContain('Support unknown for this version/session');
    expect(section).toContain('Requested: sync · Effective: waiting');
    // The hosted evidence is present only inside the evidence disclosure.
    expect(section).toMatch(/<details[^>]*><summary>Secondary evidence for [^<]+<\/summary><p>Secondary hosted evidence kha-104-hosted-app-server/);
  });

  it('WRONG-IMPLEMENTATION: a disconnected session never retains a green badge and shows effective none', () => {
    const section = listeningSection(render({ connection: 'offline', requested: 'steer' }));
    expect(section).not.toContain('status-badge--positive');
    expect(section).toContain('Requested: steer · Effective: none');
    expect(section).toMatch(LABEL);
    expect(section).toContain('Resume or rejoin the CLI');
    expect(section.match(/type="radio"[^>]*disabled=""/g)?.length).toBe(3);
    expect(section).not.toContain('Enable experimental route');
  });

  it('renders blocked-without-wrapper as non-actionable copy with no wrapper action', () => {
    const modes: ModeSupportMap = {
      ...PROVEN,
      steer: {
        status: 'blocked_without_wrapper', route: 'interactive-codex-steer', testedVersion: VERSION,
        evidenceRef: 'interactive-codex-steer', evidenceRevision: 'rev-1', reason: 'Only a PTY wrapper remains.',
      },
    };
    const section = listeningSection(render({ modes }));
    expect(section).toContain('Native delivery unavailable; wrapper-based support is awaiting product-operator approval.');
    expect(section).not.toMatch(/<button[^>]*>[^<]*wrapper/i);
    // The retained proof is linked through the allowlist.
    expect(section).toContain('<a href="/evidence/interactive-codex#steer">interactive-codex-steer</a>');
  });

  it('links only allowlisted evidence and keeps URL-shaped references as plain text', () => {
    const modes: ModeSupportMap = { ...PROVEN, sync: support('proven', 'sync', 'https-evil.example') };
    const section = listeningSection(render({ modes }));
    expect(section).toContain('<a href="/evidence/interactive-codex#steer">');
    expect(section).toContain('Evidence: https-evil.example');
    expect(section).not.toContain('href="https');
  });

  it('describes each radio by its support reason for screen readers', () => {
    const section = listeningSection(render());
    const radio = section.match(/<input type="radio" id="([^"]+)"[^>]*aria-describedby="([^"]+)"/);
    expect(radio).not.toBeNull();
    expect(section).toContain(`id="${radio![2]}"`);
  });

  it('offers an experimental opt-in beside the disabled mode and a route-specific confirmation', () => {
    const modes: ModeSupportMap = { ...PROVEN, steer: support('experimental', 'steer') };
    const closed = listeningSection(render({ modes }));
    expect(closed).toContain('Enable experimental route');
    const open = listeningSection(render({ modes }, controller => controller.requestGrant('experimental_route', 'steer')));
    expect(open).toMatch(new RegExp(`Enable experimental steer route on ${LABEL.source}\\?`));
    expect(open).toContain('Missing proof: Ordering under a busy turn is not proved.');
    expect(open).toContain('It does not enable hard cancel.');
    expect(open).toContain('Confirm for this binding');
  });

  it('offers independent revoke actions for an experimental grant and a hard-cancel grant', () => {
    const grant = (kind: RouteGrant['kind']): RouteGrant => ({
      v: 1, kind, bindingId: BINDING_ID, generation: 2, mode: 'steer', route: 'interactive-codex-steer',
      harnessVersion: VERSION, evidenceRevision: 'rev-1', grantRevision: 2,
    });
    const modes: ModeSupportMap = { ...PROVEN, steer: support('experimental', 'steer') };
    const section = listeningSection(render({
      modes, hardCancel: support('experimental', 'steer'),
      experimentalGrants: [grant('experimental_route')], hardCancelGrants: [grant('hard_cancel')],
    }));
    expect(section).toContain('Revoke experimental route');
    expect(section).toContain('Revoke hard cancel');
    expect(section).toContain('Granted for this binding.');
  });

  it('names expired consent and offers a review of the updated evidence', () => {
    const stale: RouteGrant = {
      v: 1, kind: 'experimental_route', bindingId: BINDING_ID, generation: 2, mode: 'steer',
      route: 'interactive-codex-steer', harnessVersion: '0.150.0', evidenceRevision: 'rev-1', grantRevision: 2,
    };
    const modes: ModeSupportMap = { ...PROVEN, steer: support('experimental', 'steer') };
    const section = listeningSection(render({ modes, experimentalGrants: [stale] }));
    expect(section).toContain('Experimental consent expired');
    expect(section).toContain('harness version changed from 0.150.0 to 0.154.0');
    expect(section).toContain('Review updated evidence');
  });

  it('disables the hard-cancel grant with its reason when unknown', () => {
    const section = listeningSection(render());
    expect(section).toContain('Hard cancel unknown: Hard-cancel support has not been inventoried for this route. Off by default.');
    expect(section).not.toContain('Enable hard cancel');
  });

  it('repeats the session label on a delivery failure and its receipt', () => {
    const receipt = {
      v: 1, releaseId: 'rel-1', bindingId: BINDING_ID, generation: 2, kind: 'failed', errorCode: 'harness_rejected',
      observedAt: '2026-09-25T00:00:00.000Z',
    } as unknown as DeliveryReceipt;
    const html = render({ latestReceipt: receipt });
    expect(html).toMatch(new RegExp(`Delivery problem on ${LABEL.source}; the listening mode was not changed`));
    expect(html).toMatch(new RegExp(`${LABEL.source}: Delivery failed: the agent harness rejected the delivery`));
  });

  it('keeps the listening status region mounted with the divergence text', () => {
    const section = listeningSection(render({ requested: 'steer', effective: null, effectiveReason: 'support_unknown', modes: { ...PROVEN, steer: UNKNOWN.steer } }));
    expect(section).toMatch(/<p class="agent-controls__listening-status" role="status">Requested: steer · Effective: waiting/);
  });
});

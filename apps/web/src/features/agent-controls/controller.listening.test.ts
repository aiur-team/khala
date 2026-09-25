import { describe, expect, it, vi } from 'vitest';
import type {
  BindingId, CommandId, HarnessCapabilities, ListeningMode, ListeningModeCommand, ListeningModeResult,
  ModeSupport, ModeSupportMap, OwnerId, OwnerRouteGrantCommand, ParticipantId, RoomId, RouteGrant, SessionBinding,
} from '@khala/contracts/delivery/index';
import { decodeDeliveryLimits, unknownModeSupportMap } from '@khala/contracts/delivery/index';
import { createAgentControlsController, type AgentControlsConfig } from './controller';
import { bindingShortId, evidenceHrefFor, listeningStatusText, type ListeningDisplay } from './model';
import type {
  AgentControlsPorts, AgentControlsSnapshot, ListeningModeLastChange, ListeningModeSnapshot, RouteGrantAck,
} from './ports';

const BINDING_ID = 'bind-tui-1' as BindingId;
const OWNER = 'owner-b' as OwnerId;

const CONFIG: AgentControlsConfig = {
  bindingId: BINDING_ID,
  roomId: 'room-1' as RoomId,
  peerParticipantId: 'agent-a' as ParticipantId,
  viewerOwnerId: OWNER,
  agentLabel: 'agent-a',
  roomLabel: 'room-1',
  evidenceRegistry: { 'interactive-codex-steer': '/evidence/interactive-codex#steer' },
};

const BINDING: SessionBinding = {
  v: 1,
  bindingId: BINDING_ID,
  ownerId: OWNER,
  agentParticipantId: 'agent-b' as never,
  deviceId: 'dev-b' as never,
  harness: 'codex',
  sessionId: 'tui-session',
  generation: 2,
};

const LIMITS = (() => {
  const decoded = decodeDeliveryLimits({ maxSelectionEvents: 2, maxPayloadBytes: 4096 });
  if (!decoded.ok) throw new Error('invalid fixture limits');
  return decoded.value;
})();

const VERSION = '0.154.0';

function proven(mode: ListeningMode, revision = 'rev-1'): ModeSupport {
  return {
    status: 'proven',
    route: `interactive-codex-${mode}`,
    testedVersion: VERSION,
    evidenceRef: `interactive-codex-${mode}`,
    evidenceRevision: revision,
    reason: null,
  };
}

function experimental(mode: ListeningMode, revision = 'rev-1'): ModeSupport {
  return {
    status: 'experimental',
    route: `interactive-codex-${mode}`,
    testedVersion: VERSION,
    evidenceRef: `interactive-codex-${mode}`,
    evidenceRevision: revision,
    reason: 'Ordering under a busy turn is not proved.',
  };
}

const UNKNOWN_MODES = unknownModeSupportMap('interactive-codex', 'The interactive TUI route is not inventoried.', VERSION);

function capabilities(overrides: Partial<HarnessCapabilities> = {}): HarnessCapabilities {
  return {
    v: 3,
    harness: 'codex',
    version: VERSION,
    adapterVersion: 'khala-hosted-queue-1',
    support: 'tested',
    existingSession: 'khala_hosted_resume',
    immediateNotification: 'khala_hosted_idle',
    busy: 'queue',
    receiptEvidence: [],
    reconcileByReleaseId: 'while_queued',
    limits: LIMITS,
    evidenceRef: 'kha-104-hosted-app-server',
    modes: UNKNOWN_MODES,
    acknowledgement: 'batch_token_next_call',
    ...overrides,
  };
}

type StoreState = {
  generation: number;
  requested: ListeningMode;
  version: number;
  experimentalGrants: RouteGrant[];
  hardCancelGrants: RouteGrant[];
  lastChange: ListeningModeLastChange | null;
};

type Fixture = {
  store: StoreState;
  modes: ModeSupportMap;
  hardCancel: ModeSupport | null;
  bindingStatus: AgentControlsSnapshot['bindingStatus'];
  connection: AgentControlsSnapshot['connection'];
  capabilities: HarnessCapabilities | null;
  siblings: BindingId[];
  idleDelivery: 'proven' | 'unproven';
};

function effectiveOf(fixture: Fixture): Pick<ListeningModeSnapshot['view'], 'effective' | 'effectiveReason'> {
  const support = fixture.modes[fixture.store.requested];
  if (support.status !== 'proven' && support.status !== 'experimental') {
    return { effective: null, effectiveReason: `support_${support.status}` };
  }
  if (support.status === 'experimental' && !fixture.store.experimentalGrants.some(grant => grant.mode === fixture.store.requested
    && grant.evidenceRevision === support.evidenceRevision)) {
    return { effective: null, effectiveReason: 'experimental_grant_required' };
  }
  return { effective: fixture.store.requested, effectiveReason: null };
}

function snapshotOf(fixture: Fixture): AgentControlsSnapshot {
  const binding = { ...BINDING, generation: fixture.store.generation };
  const caps = fixture.capabilities === null ? null : { ...fixture.capabilities, modes: fixture.modes };
  return {
    binding,
    bindingStatus: fixture.bindingStatus,
    capabilities: caps,
    policy: { bindingId: BINDING_ID, generation: fixture.store.generation, effectiveVersion: 3, effectiveMode: 'review', paused: false },
    connection: fixture.connection,
    latestReceipt: null,
    listening: {
      view: {
        bindingId: BINDING_ID,
        generation: fixture.store.generation,
        requested: fixture.store.requested,
        version: fixture.store.version,
        experimentalGrants: fixture.store.experimentalGrants,
        hardCancelGrants: fixture.store.hardCancelGrants,
        support: fixture.modes,
        ...effectiveOf(fixture),
      },
      lastChange: fixture.store.lastChange,
      siblingBindingIds: fixture.siblings,
      hardCancel: fixture.hardCancel,
      idleDelivery: fixture.idleDelivery,
    },
  };
}

function fixture(overrides: Partial<Fixture> = {}, store: Partial<StoreState> = {}): Fixture {
  return {
    store: {
      generation: 2,
      requested: 'sync',
      version: 1,
      experimentalGrants: [],
      hardCancelGrants: [],
      lastChange: null,
      ...store,
    },
    modes: { steer: proven('steer'), sync: proven('sync'), async: proven('async') },
    hardCancel: null,
    bindingStatus: 'active',
    connection: 'connected',
    capabilities: capabilities(),
    siblings: [],
    idleDelivery: 'unproven',
    ...overrides,
  };
}

/**
 * In-memory port with the store's semantics: CAS on `expectedVersion`, grant
 * identity by kind/mode/route/version/revision, and each grant kind stored
 * independently. `submitListeningMode` can be forced to conflict once.
 */
function fakePorts(state: Fixture, options: Readonly<{ conflictWith?: (s: StoreState) => void; failModeSubmit?: boolean }> = {}) {
  let listener: ((snapshot: AgentControlsSnapshot) => void) | null = null;
  let conflictWith = options.conflictWith;
  const submitListeningMode = vi.fn(async (command: ListeningModeCommand): Promise<ListeningModeResult> => {
    if (options.failModeSubmit) throw new Error('network');
    if (conflictWith) {
      conflictWith(state.store);
      conflictWith = undefined;
    }
    const base = { v: 1 as const, commandId: command.commandId, bindingId: command.bindingId, generation: state.store.generation };
    if (command.expectedVersion !== state.store.version) {
      return { ...base, outcome: 'conflict', version: state.store.version, requested: state.store.requested, effective: effectiveOf(state).effective, reason: 'stale_version' };
    }
    state.store.requested = command.requested;
    state.store.version += 1;
    state.store.lastChange = { actor: 'owner', version: state.store.version, changedAt: '2026-09-25T00:00:00.000Z' };
    return { ...base, outcome: 'applied', version: state.store.version, requested: state.store.requested, effective: effectiveOf(state).effective, reason: null };
  });
  const submitRouteGrant = vi.fn(async (command: OwnerRouteGrantCommand): Promise<RouteGrantAck> => {
    if (command.expectedVersion !== state.store.version) return { commandId: command.commandId, outcome: 'conflict', reason: 'stale_version' };
    const kind = command.kind.endsWith('experimental_route') ? 'experimental_route' : 'hard_cancel';
    const field = kind === 'experimental_route' ? 'experimentalGrants' : 'hardCancelGrants';
    const same = (grant: RouteGrant) => grant.mode === command.mode && grant.route === command.route
      && grant.harnessVersion === command.harnessVersion && grant.evidenceRevision === command.evidenceRevision;
    const kept = state.store[field].filter(grant => !same(grant));
    state.store[field] = command.kind.startsWith('grant_')
      ? [...kept, {
        v: 1, kind, bindingId: command.bindingId, generation: command.expectedBindingGeneration, mode: command.mode,
        route: command.route, harnessVersion: command.harnessVersion, evidenceRevision: command.evidenceRevision,
        grantRevision: command.expectedVersion + 1,
      }]
      : kept;
    state.store.version += 1;
    return { commandId: command.commandId, outcome: 'applied', reason: null };
  });
  const ports: AgentControlsPorts = {
    agentControls: {
      readSnapshot: async () => snapshotOf(state),
      subscribe: (_bindingId, cb) => {
        listener = cb;
        return () => { listener = null; };
      },
      submitPolicy: () => new Promise(() => {}),
      submitListeningMode,
      submitRouteGrant,
    },
  };
  return { ports, emit: () => listener?.(snapshotOf(state)), submitListeningMode, submitRouteGrant };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

async function start(state: Fixture, options: Parameters<typeof fakePorts>[1] = {}) {
  const harness = fakePorts(state, options);
  let next = 0;
  const controller = createAgentControlsController(harness.ports, CONFIG, { createId: () => `cmd-${++next}` });
  await flush();
  const listening = (): ListeningDisplay => {
    const value = controller.getView().listening;
    if (value === null) throw new Error('listening display missing');
    return value;
  };
  const option = (mode: ListeningMode) => listening().options.find(candidate => candidate.mode === mode)!;
  return { ...harness, controller, listening, option };
}

describe('listening mode — defaults and labels', () => {
  it('renders sync by default with requested and effective both sync', async () => {
    const { listening, controller } = await start(fixture());
    expect(listening().requested).toBe('sync');
    expect(listening().effective).toBe('sync');
    expect(listeningStatusText(listening())).toBe('Requested: sync · Effective: sync');
    controller.dispose();
  });

  it('labels the binding as <CLI> <version> · <short id>', async () => {
    const { listening, controller } = await start(fixture());
    expect(listening().sessionLabel).toBe(`Codex CLI 0.154.0 · ${bindingShortId(BINDING_ID, [])}`);
    expect(listening().sessionLabel).toMatch(/^Codex CLI 0\.154\.0 · [0-9a-f]{4}$/);
    controller.dispose();
  });

  it('widens the short id until two concurrent same-CLI bindings are distinguishable', () => {
    const base = 'bind-a' as BindingId;
    const seen = new Map<string, BindingId>();
    let collider: BindingId | null = null;
    for (let index = 0; collider === null && index < 100_000; index += 1) {
      const id = `bind-${index}` as BindingId;
      const prefix = bindingShortId(id, []);
      if (prefix === bindingShortId(base, [])) collider = id;
      seen.set(prefix, id);
    }
    expect(collider).not.toBeNull();
    const a = bindingShortId(base, [collider!]);
    const b = bindingShortId(collider!, [base]);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(4);
  });

  it('explains an async initial mode chosen because sync is proved unsupported on the exact route', async () => {
    const modes: ModeSupportMap = {
      steer: UNKNOWN_MODES.steer,
      sync: {
        status: 'unsupported', route: 'interactive-codex-sync', testedVersion: VERSION,
        evidenceRef: 'interactive-codex-sync', evidenceRevision: 'rev-1', reason: 'No turn-boundary hook',
      },
      async: proven('async'),
    };
    const { listening, controller } = await start(fixture({ modes }, { requested: 'async' }));
    expect(listening().initialReason).toContain('No turn-boundary hook');
    expect(listening().effective).toBe('async');
    controller.dispose();
  });

  it('states that idle agents receive messages only at their next turn until idle delivery is proven', async () => {
    const unproven = await start(fixture());
    expect(unproven.listening().idleClaim).toBe('Idle agents receive messages only at their next turn.');
    unproven.controller.dispose();
    const provenIdle = await start(fixture({ idleDelivery: 'proven' }));
    expect(provenIdle.listening().idleClaim).toBeNull();
    provenIdle.controller.dispose();
  });
});

describe('listening mode — honest support', () => {
  it('disables unsupported, unknown and blocked-without-wrapper modes with exact-route reasons', async () => {
    const modes: ModeSupportMap = {
      steer: {
        status: 'blocked_without_wrapper', route: 'interactive-codex-steer', testedVersion: VERSION,
        evidenceRef: 'interactive-codex-steer', evidenceRevision: 'rev-1', reason: 'Only a PTY wrapper remains.',
      },
      sync: proven('sync'),
      async: {
        status: 'unsupported', route: 'interactive-codex-async', evidenceRef: null, evidenceRevision: null,
        reason: 'Payload would enter argv',
      },
    };
    const { option, controller } = await start(fixture({ modes }));
    expect(option('steer').selectable).toBe(false);
    expect(option('steer').description).toBe(
      'Native delivery unavailable; wrapper-based support is awaiting product-operator approval.',
    );
    expect(option('async').selectable).toBe(false);
    expect(option('async').description).toBe('Unsupported: Payload would enter argv');
    expect(option('sync').selectable).toBe(true);
    expect(option('sync').description).toBe('Supported on Codex CLI 0.154.0 via interactive-codex-sync');
    controller.dispose();
  });

  it('WRONG-IMPLEMENTATION: a hosted Codex app-server proof never makes the TUI modes selectable', async () => {
    // Capabilities carry a tested, evidenced hosted route (KHA-104), but the
    // primary interactive projection is unknown for every mode.
    const { option, listening, controller } = await start(fixture({ modes: UNKNOWN_MODES }));
    for (const mode of ['steer', 'sync', 'async'] as const) {
      expect(option(mode).selectable).toBe(false);
      expect(option(mode).status).toBe('unknown');
      expect(option(mode).description).toMatch(/^Support unknown for this version\/session/);
    }
    expect(listening().effective).toBe('waiting');
    expect(listening().secondaryEvidence).toContain('kha-104-hosted-app-server');
    expect(listening().secondaryEvidence).toContain('cannot enable a listening mode');
    controller.dispose();
  });

  it('disables async when the route cannot acknowledge a pulled batch on the next call', async () => {
    const { option, controller } = await start(fixture({ capabilities: capabilities({ acknowledgement: 'unsupported' }) }));
    expect(option('async').selectable).toBe(false);
    expect(option('async').description).toContain('Acknowledgement unavailable');
    controller.dispose();
  });

  it('announces requested/effective divergence as waiting with the reason', async () => {
    const modes: ModeSupportMap = { ...UNKNOWN_MODES, sync: proven('sync') };
    const { listening, controller } = await start(fixture({ modes }, { requested: 'steer' }));
    expect(listening().effective).toBe('waiting');
    expect(listeningStatusText(listening())).toMatch(/^Requested: steer · Effective: waiting Support for the requested route is unknown/);
    controller.dispose();
  });

  it('links evidence only through the allowlisted registry', async () => {
    const { option, controller } = await start(fixture());
    expect(option('steer').evidence.evidenceHref).toBe('/evidence/interactive-codex#steer');
    expect(option('sync').evidence.evidenceHref).toBeNull();
    controller.dispose();
    expect(evidenceHrefFor('https://example.com/proof', { 'https://example.com/proof': '/x' })).toBeNull();
    expect(evidenceHrefFor('proof-1', { 'proof-1': 'https://example.com' })).toBeNull();
    expect(evidenceHrefFor('proof-1', { 'proof-1': '//example.com' })).toBeNull();
    expect(evidenceHrefFor('proof-1', {})).toBeNull();
    expect(evidenceHrefFor('toString', {})).toBeNull();
  });
});

describe('listening mode — stopped session', () => {
  it('WRONG-IMPLEMENTATION: a disconnected session keeps label and requested mode but shows effective none and no action', async () => {
    const state = fixture({}, { requested: 'steer' });
    const { listening, emit, controller } = await start(state);
    expect(listening().effective).toBe('steer');
    const label = listening().sessionLabel;
    state.connection = 'offline';
    emit();
    expect(listening().sessionLabel).toBe(label);
    expect(listening().requested).toBe('steer');
    expect(listening().effective).toBe('none');
    expect(listening().sessionActive).toBe(false);
    expect(listening().options.every(option => !option.selectable && !option.canGrantExperimental)).toBe(true);
    expect(listening().inactiveReason).toMatch(/Resume or rejoin/);
    controller.dispose();
  });

  it('a revoked (stopped) binding is read-only with effective none', async () => {
    const { listening, controller } = await start(fixture({ bindingStatus: 'revoked' }));
    expect(listening().effective).toBe('none');
    expect(listening().inactiveReason).toMatch(/stopped/);
    expect(listening().hardCancel.canGrant).toBe(false);
    controller.dispose();
  });
});

describe('listening mode — owner mutation and conflicts', () => {
  it('sends the versioned mode command for the exact binding generation only on apply', async () => {
    const { controller, submitListeningMode, listening } = await start(fixture());
    controller.selectListeningMode('steer');
    expect(submitListeningMode).not.toHaveBeenCalled();
    expect(listening().draft).toBe('steer');
    controller.applyListeningMode();
    expect(submitListeningMode).toHaveBeenCalledTimes(1);
    expect(submitListeningMode.mock.calls[0]![0]).toMatchObject({
      v: 1, commandId: 'cmd-1', bindingId: BINDING_ID, expectedBindingGeneration: 2, expectedVersion: 1, requested: 'steer',
    });
    await flush();
    expect(listening().requested).toBe('steer');
    expect(listening().draft).toBeNull();
    expect(listening().lastChangeLabel).toBe('Last changed by you (owner) (v2)');
    expect(listeningStatusText(listening())).toContain('Listening mode set to steer.');
    controller.dispose();
  });

  it('refuses to select a mode that is not selectable', async () => {
    const { controller, listening } = await start(fixture({ modes: { ...UNKNOWN_MODES, sync: proven('sync') } }));
    controller.selectListeningMode('steer');
    expect(listening().draft).toBeNull();
    controller.dispose();
  });

  it('a version conflict refreshes, keeps the attempted choice unsubmitted, never retries, and requests focus', async () => {
    const state = fixture();
    const { controller, submitListeningMode, listening } = await start(state, {
      conflictWith: store => {
        store.requested = 'async';
        store.version = 2;
        store.lastChange = { actor: 'agent', version: 2, changedAt: '2026-09-25T00:00:00.000Z' };
      },
    });
    const before = listening().focusToken;
    controller.selectListeningMode('steer');
    controller.applyListeningMode();
    await flush();
    await flush();
    expect(submitListeningMode).toHaveBeenCalledTimes(1);
    expect(listening().submission).toEqual({ kind: 'conflict', attempted: 'steer' });
    expect(listening().draft).toBe('steer');
    expect(listening().requested).toBe('async');
    expect(listening().version).toBe(2);
    expect(listening().focusToken).toBe(before + 1);
    expect(listening().lastChangeLabel).toMatch(/^Last changed by the agent \(Codex CLI 0\.154\.0 · [0-9a-f]{4}\) \(v2\)$/);
    expect(listeningStatusText(listening())).toContain('Another actor changed the listening mode first');
    // An explicit retry uses the refreshed version.
    controller.applyListeningMode();
    expect(submitListeningMode.mock.calls[1]![0]).toMatchObject({ expectedVersion: 2, requested: 'steer' });
    controller.dispose();
  });

  it('a network failure leaves the outcome unknown and keeps the choice', async () => {
    const { controller, listening } = await start(fixture(), { failModeSubmit: true });
    controller.selectListeningMode('async');
    controller.applyListeningMode();
    await flush();
    expect(listening().submission).toEqual({ kind: 'unknown', attempted: 'async' });
    expect(listening().draft).toBe('async');
    controller.dispose();
  });

  it('a replaced binding generation drops the draft and never inherits the old support', async () => {
    const state = fixture();
    const { controller, emit, listening } = await start(state);
    controller.selectListeningMode('steer');
    state.store = { ...state.store, generation: 3, version: 1, requested: 'sync' };
    state.modes = UNKNOWN_MODES;
    emit();
    expect(listening().generation).toBe(3);
    expect(listening().draft).toBeNull();
    expect(listening().options.every(option => !option.selectable)).toBe(true);
    controller.dispose();
  });

  it('ignores an older listening version for the same generation', async () => {
    const state = fixture({}, { version: 5 });
    const { emit, listening, controller } = await start(state);
    state.store.version = 4;
    state.store.requested = 'async';
    emit();
    expect(listening().version).toBe(5);
    expect(listening().requested).toBe('sync');
    controller.dispose();
  });
});

describe('listening mode — grants', () => {
  it('an experimental route stays disabled until the owner confirms a route-specific grant', async () => {
    const state = fixture({ modes: { steer: experimental('steer'), sync: proven('sync'), async: proven('async') } });
    const { controller, option, listening, submitRouteGrant } = await start(state);
    expect(option('steer').selectable).toBe(false);
    expect(option('steer').description).toContain('Missing proof: Ordering under a busy turn is not proved.');
    controller.requestGrant('experimental_route', 'steer');
    const confirmation = listening().confirmation!;
    expect(confirmation.sessionLabel).toBe(listening().sessionLabel);
    expect(confirmation.evidence).toMatchObject({ route: 'interactive-codex-steer', testedVersion: VERSION, evidenceRevision: 'rev-1' });
    expect(confirmation.warning).toContain('does not enable hard cancel');
    expect(submitRouteGrant).not.toHaveBeenCalled();
    controller.confirmGrant();
    expect(submitRouteGrant.mock.calls[0]![0]).toMatchObject({
      kind: 'grant_experimental_route', mode: 'steer', route: 'interactive-codex-steer',
      harnessVersion: VERSION, evidenceRevision: 'rev-1', expectedVersion: 1, expectedBindingGeneration: 2,
    });
    await flush();
    await flush();
    expect(option('steer').selectable).toBe(true);
    expect(option('steer').experimentalGrant.kind).toBe('granted');
    expect(listening().hardCancel.grant.kind).toBe('none');
    controller.dispose();
  });

  it('cancelling a confirmation sends nothing', async () => {
    const { controller, listening, submitRouteGrant } = await start(fixture({ modes: { ...UNKNOWN_MODES, steer: experimental('steer') } }));
    controller.requestGrant('experimental_route', 'steer');
    controller.cancelGrant();
    expect(listening().confirmation).toBeNull();
    expect(submitRouteGrant).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('names an expired consent and requires a fresh confirmation against the updated evidence', async () => {
    const staleGrant: RouteGrant = {
      v: 1, kind: 'experimental_route', bindingId: BINDING_ID, generation: 2, mode: 'steer',
      route: 'interactive-codex-steer', harnessVersion: VERSION, evidenceRevision: 'rev-1', grantRevision: 2,
    };
    const state = fixture(
      { modes: { steer: experimental('steer', 'rev-2'), sync: proven('sync'), async: proven('async') } },
      { requested: 'steer', version: 2, experimentalGrants: [staleGrant] },
    );
    const { controller, option, listening, submitRouteGrant } = await start(state);
    const steer = option('steer');
    expect(steer.selectable).toBe(false);
    expect(steer.experimentalGrant).toMatchObject({ kind: 'expired', changes: ['evidence revision changed from rev-1 to rev-2'] });
    expect(steer.description).toContain('Experimental consent expired: evidence revision changed from rev-1 to rev-2');
    expect(listening().effective).toBe('waiting');
    controller.requestGrant('experimental_route', 'steer');
    expect(listening().confirmation).toMatchObject({
      expiredChanges: ['evidence revision changed from rev-1 to rev-2'],
      evidence: { evidenceRevision: 'rev-2' },
    });
    controller.confirmGrant();
    expect(submitRouteGrant.mock.calls[0]![0]).toMatchObject({ kind: 'grant_experimental_route', evidenceRevision: 'rev-2' });
    controller.dispose();
  });

  it('closes an open confirmation when the evidence changes under it', async () => {
    const state = fixture({ modes: { ...UNKNOWN_MODES, steer: experimental('steer') } });
    const { controller, emit, listening } = await start(state);
    controller.requestGrant('experimental_route', 'steer');
    state.modes = { ...state.modes, steer: experimental('steer', 'rev-9') };
    state.store.version += 1;
    emit();
    expect(listening().confirmation).toBeNull();
    expect(listening().grantNotice).toMatch(/evidence .* changed while you were reviewing it/);
    controller.dispose();
  });

  it('keeps hard cancel disabled with its reason when the route is not inventoried', async () => {
    const { controller, listening, submitRouteGrant } = await start(fixture());
    expect(listening().hardCancel.canGrant).toBe(false);
    expect(listening().hardCancel.description).toBe('Hard cancel unknown: Hard-cancel support has not been inventoried for this route.');
    controller.requestGrant('hard_cancel', 'steer');
    expect(listening().confirmation).toBeNull();
    expect(submitRouteGrant).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('hard cancel has its own warning and grant command', async () => {
    const { controller, listening, submitRouteGrant } = await start(fixture({ hardCancel: experimental('steer') }));
    controller.requestGrant('hard_cancel', 'steer');
    expect(listening().confirmation?.warning).toMatch(/partly\s+taken effect/);
    controller.confirmGrant();
    expect(submitRouteGrant.mock.calls[0]![0]).toMatchObject({ kind: 'grant_hard_cancel', mode: 'steer' });
    controller.dispose();
  });

  it('WRONG-IMPLEMENTATION: revoking experimental delivery never revokes hard cancel', async () => {
    const grant = (kind: RouteGrant['kind']): RouteGrant => ({
      v: 1, kind, bindingId: BINDING_ID, generation: 2, mode: 'steer',
      route: 'interactive-codex-steer', harnessVersion: VERSION, evidenceRevision: 'rev-1', grantRevision: 2,
    });
    const state = fixture(
      { modes: { steer: experimental('steer'), sync: proven('sync'), async: proven('async') }, hardCancel: experimental('steer') },
      { version: 3, experimentalGrants: [grant('experimental_route')], hardCancelGrants: [grant('hard_cancel')] },
    );
    const { controller, option, listening, submitRouteGrant } = await start(state);
    expect(option('steer').experimentalGrant.kind).toBe('granted');
    expect(listening().hardCancel.grant.kind).toBe('granted');
    controller.revokeGrant('experimental_route', 'steer');
    expect(submitRouteGrant).toHaveBeenCalledTimes(1);
    expect(submitRouteGrant.mock.calls[0]![0].kind).toBe('revoke_experimental_route');
    await flush();
    await flush();
    expect(option('steer').experimentalGrant.kind).toBe('none');
    expect(option('steer').selectable).toBe(false);
    expect(listening().hardCancel.grant.kind).toBe('granted');
    expect(listening().grantNotice).toMatch(/^Experimental route for steer on Codex CLI .* revoked\.$/);
    controller.dispose();
  });

  it('a grant conflict is reported and not retried', async () => {
    const state = fixture({ modes: { ...UNKNOWN_MODES, steer: experimental('steer') } });
    const { controller, listening, submitRouteGrant } = await start(state);
    controller.requestGrant('experimental_route', 'steer');
    state.store.version += 1;
    controller.confirmGrant();
    await flush();
    expect(submitRouteGrant).toHaveBeenCalledTimes(1);
    expect(listening().grantNotice).toMatch(/Another actor changed .* first; the grant was not applied/);
    controller.dispose();
  });
});

describe('listening mode — isolation', () => {
  it('shows no listening state until the store answers', async () => {
    const state = fixture();
    const harness = fakePorts(state);
    harness.ports.agentControls.readSnapshot = async () => ({ ...snapshotOf(state), listening: null });
    const controller = createAgentControlsController(harness.ports, CONFIG);
    await flush();
    expect(controller.getView().listening).toBeNull();
    controller.dispose();
  });

  it('support from one binding never leaks into another binding', async () => {
    const a = await start(fixture());
    const otherState = fixture({ modes: UNKNOWN_MODES });
    const b = await start(otherState);
    expect(a.option('sync').selectable).toBe(true);
    expect(b.option('sync').selectable).toBe(false);
    a.controller.dispose();
    b.controller.dispose();
  });

  it('commandIds are fresh per mode submission', async () => {
    const { controller, submitListeningMode } = await start(fixture());
    controller.selectListeningMode('steer');
    controller.applyListeningMode();
    await flush();
    controller.selectListeningMode('async');
    controller.applyListeningMode();
    const ids = submitListeningMode.mock.calls.map(call => (call[0] as { commandId: CommandId }).commandId);
    expect(new Set(ids).size).toBe(2);
    controller.dispose();
  });
});

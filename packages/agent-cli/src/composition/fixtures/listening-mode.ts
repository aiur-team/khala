import { vi } from 'vitest';
import type {
  AgentListeningModeApplication, AgentListeningModeSetInput,
} from '@khala/connector/agent/listening-mode';
import type {
  BindingId, ListeningMode, ListeningModeResult, ListeningModeView, ParticipantId,
} from '@khala/contracts/delivery/index';

export const MODE_VIEW = {
  bindingId: 'binding-1' as BindingId,
  generation: 3,
  requested: 'steer',
  version: 4,
  experimentalGrants: [],
  hardCancelGrants: [],
  lastChangedBy: { kind: 'owner', participantId: 'owner-1' as ParticipantId },
  effective: 'sync',
  effectiveReason: 'steer_unsupported',
  support: {
    steer: {
      status: 'unsupported', route: 'codex-steer', evidenceRef: null, evidenceRevision: null,
      reason: 'steer_unsupported',
    },
    sync: {
      status: 'proven', route: 'codex-sync', testedVersion: '0.154.0', evidenceRef: 'evidence/sync',
      evidenceRevision: 'rev-1', reason: null,
    },
    async: {
      status: 'unknown', route: 'codex-async', evidenceRef: null, evidenceRevision: null,
      reason: 'idle_delivery_unproven',
    },
  },
} satisfies ListeningModeView;

export const EXPECTED_VIEW = {
  kind: 'view',
  requested: 'steer',
  effective: 'sync',
  effectiveReason: 'steer_unsupported',
  version: 4,
  support: {
    steer: {
      status: 'unsupported', route: 'codex-steer', testedVersion: null, evidenceRef: null, evidenceRevision: null,
      reason: 'steer_unsupported',
    },
    sync: {
      status: 'proven', route: 'codex-sync', testedVersion: '0.154.0', evidenceRef: 'evidence/sync',
      evidenceRevision: 'rev-1', reason: null,
    },
    async: {
      status: 'unknown', route: 'codex-async', testedVersion: null, evidenceRef: null, evidenceRevision: null,
      reason: 'idle_delivery_unproven',
    },
  },
};

/**
 * A faithful in-memory stand-in for the bound application: one version counter,
 * compare-and-set on expectedVersion, and conflict returning the current state.
 */
export function fakeModeApplication(initial: Readonly<{ requested: ListeningMode; version: number }> = {
  requested: 'sync', version: 4,
}) {
  const state = { requested: initial.requested, version: initial.version };
  const sets: AgentListeningModeSetInput[] = [];
  const result = (input: AgentListeningModeSetInput, outcome: ListeningModeResult['outcome']): ListeningModeResult => ({
    v: 1, commandId: input.commandId, bindingId: 'binding-1' as BindingId, generation: 3, outcome,
    version: state.version, requested: state.requested, effective: state.requested, reason: null,
  });
  const application = {
    read: vi.fn(async () => ({
      ok: true as const,
      view: { ...MODE_VIEW, requested: state.requested, effective: state.requested, effectiveReason: null, version: state.version },
    })),
    set: vi.fn(async (input: AgentListeningModeSetInput) => {
      sets.push(input);
      if (input.expectedVersion !== state.version) return result(input, 'conflict');
      state.requested = input.requested;
      state.version += 1;
      return result(input, 'applied');
    }),
  } satisfies AgentListeningModeApplication;
  return {
    application,
    sets,
    state,
    ownerWrite(requested: ListeningMode) { state.requested = requested; state.version += 1; },
  };
}

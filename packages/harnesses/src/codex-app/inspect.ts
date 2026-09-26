// Capability inspection for the Codex desktop surface and Codex Cloud tasks. A mode is
// claimed only for an exact proven tuple whose route is active in this session; every
// other case reports `unknown` with its reason. Khala never starts, hosts or aborts Codex.

import {
  type AppHarnessIdentity, type AppHarnessRecord, type DeliveryLimits, type HarnessCapabilities, type ListeningMode,
  type ModeSupport, LISTENING_MODES, sameAppHarnessIdentity, unknownModeSupport,
} from '@khala/contracts/delivery/index';
import { type CodexAppCensus, codexAppCensusViolation } from './census';
import {
  CODEX_APP, CODEX_APP_ADAPTER_VERSION, CODEX_APP_BLOCKED_REASONS, CODEX_APP_BOUNDARIES, CODEX_APP_PROOF_RECORD,
  CODEX_APP_PROVEN_CELLS, type CodexAppProvenCell, type CodexAppShape,
} from './evidence';

const UNKNOWN = 'unknown';
const IDLE = 'Idle agents receive messages only at their next turn.';

export type CodexAppHookBoundary = (typeof CODEX_APP_BOUNDARIES)['steer' | 'sync'];

/** What composition observed about the session the agent is running in. */
export type CodexAppEnvironment = Readonly<{
  shape: CodexAppShape | null;
  appVersion: string | null;
  accountTier: string | null;
  administratorPolicyScope: string | null;
  /**
   * The process table observed in this session. Trust settings and Khala ancestry are
   * derived from it, never from a caller's claim about who started the session.
   */
  census: CodexAppCensus | null;
  /** Cloud tasks only: who created the task, as the task's own record states. */
  taskCreatedBy: 'user' | 'other' | 'unknown';
  /** Where the session's tools run. A hosted tool runs outside the hook host and skips its hooks. */
  toolExecution: 'hook_host' | 'hosted' | 'unknown';
  /** Where the Khala hook handler is configured. A web plugin install is not a hook deployment. */
  hookDeployment: 'local_config' | 'task_environment' | 'web_plugin' | 'none' | 'unknown';
  /** Boundaries at which the Khala handler itself recorded running in this session. */
  hookRuns: readonly CodexAppHookBoundary[];
  /** Whether the Khala MCP entry answers in this session. */
  mcpActive: boolean;
}>;

export type CodexAppInspection = Readonly<{
  /** `null` when the shape is not one the proof record covers. */
  record: AppHarnessRecord | null;
  capabilities: HarnessCapabilities;
}>;

const REQUIRED_DEPLOYMENT: Readonly<Record<CodexAppShape, CodexAppEnvironment['hookDeployment']>> = {
  local_chat: 'local_config',
  cloud_task: 'task_environment',
};

export function codexAppIdentity(environment: CodexAppEnvironment, shape: CodexAppShape): AppHarnessIdentity {
  return {
    v: 1,
    app: CODEX_APP,
    shape,
    appVersion: environment.appVersion ?? UNKNOWN,
    accountTier: environment.accountTier ?? UNKNOWN,
    administratorPolicyScope: environment.administratorPolicyScope ?? UNKNOWN,
  };
}

/** Why a mode's route is not active in this session, or `null` when it is. */
function inactiveRoute(mode: ListeningMode, shape: CodexAppShape, environment: CodexAppEnvironment): string | null {
  const violation = codexAppCensusViolation(environment.census);
  if (violation !== null) return violation;
  if (shape === 'cloud_task' && environment.taskCreatedBy !== 'user') {
    return 'Only a task the user created can receive delivery.';
  }
  if (mode === 'async') return environment.mcpActive ? null : 'The Khala MCP entry is not active in this session.';
  if (environment.hookDeployment !== REQUIRED_DEPLOYMENT[shape]) {
    return `The Khala hook is not configured in the ${shape === 'local_chat' ? 'local Codex config' : 'task environment'}; `
      + 'an installed web plugin does not run local hook scripts.';
  }
  if (mode === 'steer' && environment.toolExecution !== 'hook_host') {
    return 'Tools in this session may run hosted, where the PostToolUse hook does not fire.';
  }
  const boundary = CODEX_APP_BOUNDARIES[mode];
  if (!environment.hookRuns.includes(boundary)) return `The Khala ${boundary} hook has not run in this session.`;
  return null;
}

function provenCell(
  cells: readonly CodexAppProvenCell[],
  identity: AppHarnessIdentity,
  mode: ListeningMode,
): CodexAppProvenCell | null {
  // A cell carrying an unobserved tuple field would match every unknown environment.
  return cells.find(cell => cell.mode === mode && sameAppHarnessIdentity(cell.identity, identity)
    && ![cell.identity.appVersion, cell.identity.accountTier, cell.identity.administratorPolicyScope].includes(UNKNOWN))
    ?? null;
}

function modeSupport(
  mode: ListeningMode,
  shape: CodexAppShape,
  identity: AppHarnessIdentity,
  environment: CodexAppEnvironment,
  cells: readonly CodexAppProvenCell[],
): ModeSupport {
  const route = `codex-app-${shape}-${CODEX_APP_BOUNDARIES[mode]}`;
  const idle = mode === 'async' ? '' : ` ${IDLE}`;
  const cell = provenCell(cells, identity, mode);
  if (cell === null) {
    const tuple = `${shape} ${identity.appVersion}/${identity.accountTier}/${identity.administratorPolicyScope}`;
    return unknownModeSupport(route, `${CODEX_APP_BLOCKED_REASONS[shape]} No proof covers ${tuple}.${idle}`,
      identity.appVersion);
  }
  const inactive = inactiveRoute(mode, shape, environment);
  if (inactive !== null) return unknownModeSupport(route, `${inactive}${idle}`, identity.appVersion);
  return {
    status: 'proven',
    route,
    testedVersion: identity.appVersion,
    evidenceRef: cell.evidenceRef,
    evidenceRevision: cell.evidenceRevision,
    reason: mode === 'steer' ? 'Delivered after the tool completes; the running tool is never aborted. Hard abort is disabled.'
      : mode === 'sync' ? 'Delivered at Stop with at most one continuation per turn.'
        : 'Delivered only when the agent calls khala_read.',
  };
}

/**
 * Inspects one Codex app session. The claim is exactly as broad as the proof tuple: a
 * cloud-task proof never matches a desktop session, and a proof for one version, tier
 * or policy never matches another.
 */
export function inspectCodexApp(
  environment: CodexAppEnvironment,
  limits: DeliveryLimits,
  cells: readonly CodexAppProvenCell[] = CODEX_APP_PROVEN_CELLS,
): CodexAppInspection {
  const version = environment.appVersion ?? UNKNOWN;
  if (environment.shape === null) {
    const modes = Object.fromEntries(LISTENING_MODES.map(mode => [mode, unknownModeSupport(
      `codex-app-uninspected-${mode}`,
      `This Codex app surface is not a desktop session or cloud task the proof record covers.${mode === 'async' ? '' : ` ${IDLE}`}`,
      version,
    )])) as HarnessCapabilities['modes'];
    return { record: null, capabilities: capabilities(version, limits, modes) };
  }
  const shape = environment.shape;
  const identity = codexAppIdentity(environment, shape);
  const modes = {
    steer: modeSupport('steer', shape, identity, environment, cells),
    sync: modeSupport('sync', shape, identity, environment, cells),
    async: modeSupport('async', shape, identity, environment, cells),
  };
  const caps = capabilities(identity.appVersion, limits, modes);
  return {
    record: {
      ...identity,
      boundaries: { steer: CODEX_APP_BOUNDARIES.steer, sync: CODEX_APP_BOUNDARIES.sync, async: CODEX_APP_BOUNDARIES.async },
      capabilities: caps,
    },
    capabilities: caps,
  };
}

function capabilities(version: string, limits: DeliveryLimits, modes: HarnessCapabilities['modes']): HarnessCapabilities {
  const proven = LISTENING_MODES.filter(mode => modes[mode].status === 'proven');
  const hooks = proven.some(mode => mode !== 'async');
  return {
    v: 3,
    harness: CODEX_APP,
    version,
    adapterVersion: CODEX_APP_ADAPTER_VERSION,
    support: proven.length > 0 ? 'tested' : 'unsupported',
    existingSession: hooks ? 'native_hooks' : 'unknown',
    // No app value exists for an idle wake; the per-mode reasons state idle behaviour.
    immediateNotification: 'unknown',
    busy: 'unknown',
    receiptEvidence: [],
    reconcileByReleaseId: proven.length > 0 ? 'unsupported' : 'unknown',
    limits,
    evidenceRef: CODEX_APP_PROOF_RECORD,
    modes,
    // Every proven cell's trial acknowledged through the batch token on a later call.
    acknowledgement: proven.length > 0 ? 'batch_token_next_call' : 'unknown',
  };
}

// Hosted public-discovery rollout state. One ControlStore record holds the
// operator's enable decision, an independent kill switch, and the last passing
// operations drill. Absence means disabled, and every read failure fails closed
// for public listing only. Listing reads this record on every request, so an
// engaged kill switch takes effect on the next request rather than after a
// cache interval.

import { createHash } from 'node:crypto';
import {
  type AuthPrincipal,
  type CallOptions,
  type ControlStore,
  type JsonValue,
  type OperationResult,
  type TrustedClock,
  ok,
  rejected,
  unavailable,
} from '@khala/contracts/messaging/index';
import { guardStore, settleWrite } from '../auth/store';
import type { PublicDiscovery } from './catalog';

export const ROLLOUT_KEY = 'channel-discovery:rollout:hosted';
/** The contract's ceiling for removing public results after the kill switch is engaged. */
export const KILL_SWITCH_DEADLINE_MS = 5 * 60_000;
/** A drill older than this no longer authorizes enabling public discovery. */
export const DRILL_VALIDITY_MS = 30 * 24 * 60 * 60_000;

export type RolloutAction = 'enable' | 'disable' | 'engage_kill_switch' | 'release_kill_switch' | 'record_drill';
export type RolloutRejection = 'forbidden' | 'stale_revision' | 'operation_mismatch' | 'drill_required' | 'drill_failed';

/** What the operations drill proved. Every check must pass before `record_drill` accepts it. */
export type DrillReport = Readonly<{
  v: 1;
  completedAt: string;
  checks: Readonly<{ pageCap: boolean; limiter: boolean; alert: boolean; killSwitch: boolean; privateRetained: boolean }>;
  killSwitchPropagationMs: number;
}>;

export type RolloutState = Readonly<{
  v: 1;
  /** Operator decision to serve hosted public discovery. Owners may publish only while this holds. */
  enabled: boolean;
  /** Removes public results from listing and resolution without touching owner settings. */
  killSwitch: boolean;
  drill: Readonly<{ passedAt: number; propagationMs: number }> | null;
  lastOperation: string;
  lastFingerprint: string;
}>;

export type RolloutView = Readonly<{
  state: RolloutState;
  revision: string | null;
}>;

/** The gates the rest of the module consumes, derived from one rollout read. */
export type PublicDiscoveryGates = Readonly<{
  /** Whether an owner may set `public`. The kill switch leaves owner settings alone. */
  settings: PublicDiscovery;
  /** Whether public entries are eligible for listing and listing-reference resolution. */
  listing: PublicDiscovery;
  /** Telemetry label; never includes operator identity. */
  label: 'enabled' | 'disabled' | 'killed';
}>;

export type RolloutControl = Readonly<{
  read(options?: CallOptions): Promise<RolloutView | 'unavailable'>;
}>;

/**
 * Static values serve tests and internal compositions; hosted composition
 * passes the store-backed control so operators can change it at runtime.
 */
export type PublicDiscoverySource = PublicDiscovery | RolloutControl;

export type OperatorAuthority = Readonly<{
  /** Whether this authenticated human may change the hosted rollout. */
  isOperator(principal: AuthPrincipal, options?: CallOptions): Promise<'operator' | 'forbidden' | 'unavailable'>;
}>;

export type RolloutMutation = Readonly<{
  v: 1;
  action: RolloutAction;
  operationId: string;
  /** Null only before the first rollout write. */
  expectedRevision: string | null;
  /** Required exactly for `record_drill`. */
  drill: DrillReport | null;
}>;

const DISABLED: RolloutState = { v: 1, enabled: false, killSwitch: false, drill: null, lastOperation: '', lastFingerprint: '' };
const MAX_CAS_ATTEMPTS = 4;

function digest(purpose: string, value: string): string {
  return createHash('sha256').update(`khala.channel-discovery.${purpose}.v1\u0000${value}`).digest('base64url');
}

export function gatesOf(state: RolloutState | 'unavailable'): PublicDiscoveryGates {
  if (state === 'unavailable') return { settings: 'disabled', listing: 'disabled', label: 'disabled' };
  return {
    settings: state.enabled ? 'enabled' : 'disabled',
    listing: state.enabled && !state.killSwitch ? 'enabled' : 'disabled',
    label: !state.enabled ? 'disabled' : state.killSwitch ? 'killed' : 'enabled',
  };
}

export async function resolveGates(source: PublicDiscoverySource, options?: CallOptions): Promise<PublicDiscoveryGates> {
  if (source === 'enabled' || source === 'disabled') return { settings: source, listing: source, label: source };
  try {
    const view = await source.read(options);
    return gatesOf(view === 'unavailable' ? view : view.state);
  } catch {
    return gatesOf('unavailable');
  }
}

export function createRolloutControl(deps: Readonly<{ store: ControlStore }>): RolloutControl {
  return { read: options => readRollout(deps.store, options) };
}

export async function readRollout(store: ControlStore, options?: CallOptions): Promise<RolloutView | 'unavailable'> {
  const read = await guardStore(store).read<JsonValue>(ROLLOUT_KEY, options);
  if (read.kind === 'unavailable') return 'unavailable';
  if (read.kind === 'absent') return { state: DISABLED, revision: null };
  const state = decodeState(read.record.value);
  return state ? { state, revision: read.record.revision } : 'unavailable';
}

/** Whether a drill report proves every rollout control within the contract's deadlines. */
export function drillPassed(report: DrillReport): boolean {
  const { checks } = report;
  return checks.pageCap && checks.limiter && checks.alert && checks.killSwitch && checks.privateRetained
    && Number.isFinite(report.killSwitchPropagationMs) && report.killSwitchPropagationMs >= 0
    && report.killSwitchPropagationMs < KILL_SWITCH_DEADLINE_MS;
}

/**
 * Operator-only rollout change with revision check and operation identity.
 * `enable` refuses until a passing drill younger than `DRILL_VALIDITY_MS` is
 * recorded; the kill switch works regardless of the enable state.
 */
export async function applyRollout(
  deps: Readonly<{ store: ControlStore; clock: TrustedClock; operators: OperatorAuthority }>,
  input: RolloutMutation,
  operator: AuthPrincipal,
  options?: CallOptions,
): Promise<OperationResult<Readonly<{ revision: string }>, RolloutRejection>> {
  let authority: 'operator' | 'forbidden' | 'unavailable';
  try {
    authority = await deps.operators.isOperator(operator, options);
  } catch {
    return unavailable();
  }
  if (authority === 'unavailable') return unavailable();
  if (authority !== 'operator') return rejected('forbidden');
  if ((input.action === 'record_drill') !== (input.drill !== null)) return rejected('drill_failed');
  if (input.drill && !drillPassed(input.drill)) return rejected('drill_failed');

  const operation = digest('rollout-operation', `${operator.ownerId}\u0000${input.operationId}`);
  const fingerprint = digest('rollout-fingerprint', JSON.stringify([input.action, input.drill]));
  const store = guardStore(deps.store);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const view = await readRollout(store, options);
    if (view === 'unavailable') return unavailable();
    const current = view.state;
    if (current.lastOperation === operation) {
      return current.lastFingerprint === fingerprint && view.revision !== null ? ok({ revision: view.revision }) : rejected('operation_mismatch');
    }
    if (view.revision !== input.expectedRevision) return rejected('stale_revision');
    const now = deps.clock();
    let next: RolloutState;
    switch (input.action) {
      case 'enable':
        if (!current.drill || now - current.drill.passedAt >= DRILL_VALIDITY_MS) return rejected('drill_required');
        next = { ...current, enabled: true };
        break;
      case 'disable':
        next = { ...current, enabled: false };
        break;
      case 'engage_kill_switch':
        next = { ...current, killSwitch: true };
        break;
      case 'release_kill_switch':
        next = { ...current, killSwitch: false };
        break;
      case 'record_drill':
        next = { ...current, drill: { passedAt: now, propagationMs: input.drill!.killSwitchPropagationMs } };
        break;
    }
    next = { ...next, lastOperation: operation, lastFingerprint: fingerprint };
    const written = await settleWrite<JsonValue>(store, {
      key: ROLLOUT_KEY, expectedRevision: view.revision,
      operationId: `channel-discovery.rollout.${operation}`,
      next: { value: next as unknown as JsonValue, expiresAt: null },
    });
    if (written.kind === 'applied') return ok({ revision: written.record.revision });
    if (written.kind === 'unavailable') return unavailable();
  }
  return unavailable();
}

/** Strict decoder for an operator-submitted drill report. */
export function decodeDrillReport(value: unknown): DrillReport | null {
  if (!isRecord(value) || !exactKeys(value, ['v', 'completedAt', 'checks', 'killSwitchPropagationMs']) || value.v !== 1
    || typeof value.completedAt !== 'string' || Number.isNaN(Date.parse(value.completedAt))
    || typeof value.killSwitchPropagationMs !== 'number' || !isRecord(value.checks)) return null;
  const names = ['pageCap', 'limiter', 'alert', 'killSwitch', 'privateRetained'] as const;
  const checks = value.checks;
  if (!exactKeys(checks, names) || names.some(name => typeof checks[name] !== 'boolean')) return null;
  return {
    v: 1, completedAt: value.completedAt, killSwitchPropagationMs: value.killSwitchPropagationMs,
    checks: {
      pageCap: checks.pageCap as boolean, limiter: checks.limiter as boolean, alert: checks.alert as boolean,
      killSwitch: checks.killSwitch as boolean, privateRetained: checks.privateRetained as boolean,
    },
  };
}

function decodeState(value: JsonValue): RolloutState | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.enabled !== 'boolean' || typeof value.killSwitch !== 'boolean'
    || typeof value.lastOperation !== 'string' || typeof value.lastFingerprint !== 'string') return null;
  const drill = value.drill;
  if (drill !== null && (!isRecord(drill) || !Number.isSafeInteger(drill.passedAt) || typeof drill.propagationMs !== 'number')) return null;
  return {
    v: 1, enabled: value.enabled, killSwitch: value.killSwitch,
    drill: drill === null ? null : { passedAt: drill.passedAt as number, propagationMs: drill.propagationMs as number },
    lastOperation: value.lastOperation, lastFingerprint: value.lastFingerprint,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

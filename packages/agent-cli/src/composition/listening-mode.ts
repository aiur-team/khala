import { randomUUID } from 'node:crypto';
import type { AgentListeningModeApplication } from '@khala/connector/agent/listening-mode';
import type { CommandId, ListeningMode, ListeningModeResult, ModeSupport } from '@khala/contracts/delivery/index';
import { CliError } from '../cli/errors.js';
import { plainObject, validIdentifier } from '../cli/validation.js';

export type { AgentListeningModeApplication };

// Mirrors the contract LISTENING_MODES without a runtime import from the
// source-only contracts workspace package in the packaged CLI.
const LISTENING_MODE_MEMBERS = { steer: true, sync: true, async: true } as const satisfies Record<ListeningMode, true>;
export const LISTENING_MODES = Object.freeze(Object.keys(LISTENING_MODE_MEMBERS)) as readonly ListeningMode[];
const SUPPORT_STATUSES: readonly string[] = [
  'proven', 'experimental', 'blocked_without_wrapper', 'unsupported', 'unknown',
] satisfies readonly ModeSupport['status'][];

/** Stable reasons an agent can act on; anything else from the port collapses to `unavailable`. */
export const LISTENING_MODE_REFUSAL_REASONS = [
  'forbidden', 'binding_mismatch', 'stale_binding', 'binding_revoked', 'idempotency_conflict', 'unavailable',
  'outcome_unknown',
] as const;
export type ListeningModeRefusalReason = (typeof LISTENING_MODE_REFUSAL_REASONS)[number];

export type ListeningModeSupportProjection = Readonly<{
  status: ModeSupport['status'];
  route: string;
  testedVersion: string | null;
  evidenceRef: string | null;
  evidenceRevision: string | null;
  reason: string | null;
}>;

export type ListeningModeState = Readonly<{
  requested: ListeningMode;
  effective: ListeningMode | null;
  effectiveReason: string | null;
  version: number;
}>;

export type ListeningModeOutcome =
  | Readonly<{ kind: 'view' } & ListeningModeState & {
    support: Readonly<Record<ListeningMode, ListeningModeSupportProjection>>;
  }>
  | Readonly<{ kind: 'applied' } & ListeningModeState>
  | Readonly<{ kind: 'conflict'; reason: 'stale_version'; current: ListeningModeState }>
  | Readonly<{ kind: 'refused'; reason: ListeningModeRefusalReason }>;

export type ListeningModeSetRequest = Readonly<{ requested: ListeningMode; expectedVersion: number }>;

export type ListeningModeOperationOptions = Readonly<{
  /** Pre-bound by trusted composition; null when no authenticated binding is composed. */
  application: AgentListeningModeApplication | null;
  newCommandId?: () => string;
  now?: () => Date;
}>;

/**
 * The single get/set operation shared by `khala mode` and `khala_listening_mode`.
 * Binding authority is ambient in the injected application, so no caller input
 * can select a binding, generation, owner, or grant.
 */
export class ListeningModeOperation {
  readonly #application: AgentListeningModeApplication | null;
  readonly #newCommandId: () => string;
  readonly #now: () => Date;

  constructor(options: ListeningModeOperationOptions) {
    this.#application = options.application;
    this.#newCommandId = options.newCommandId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  async get(): Promise<ListeningModeOutcome> {
    if (this.#application === null) return refused('unavailable');
    let result: unknown;
    try {
      result = await this.#application.read();
    } catch {
      return refused('unavailable');
    }
    if (!plainObject(result)) return refused('unavailable');
    if (result.ok === false) return refused(refusalReason(result.code));
    if (result.ok !== true || !plainObject(result.view)) return refused('unavailable');
    const view = result.view;
    const state = modeState(view.requested, view.effective, view.effectiveReason, view.version);
    const support = supportMap(view.support);
    return state === null || support === null ? refused('unavailable') : { kind: 'view', ...state, support };
  }

  async set(input: unknown): Promise<ListeningModeOutcome> {
    const request = parseSetRequest(input);
    if (this.#application === null) return refused('unavailable');
    const commandId = this.#newCommandId() as CommandId;
    let result: ListeningModeResult;
    try {
      result = await this.#application.set({
        commandId,
        expectedVersion: request.expectedVersion,
        requested: request.requested,
        issuedAt: this.#now().toISOString(),
      });
    } catch {
      // The write may have committed before the failure surfaced.
      return refused('outcome_unknown');
    }
    return setOutcome(result, commandId);
  }
}

/** Closed runtime grammar: exactly `{requested, expectedVersion}`, nothing target-shaped. */
export function parseSetRequest(input: unknown): ListeningModeSetRequest {
  if (!plainObject(input)) throw new CliError('invalid_arguments');
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes('requested') || !keys.includes('expectedVersion')
    || !validMode(input.requested) || !validVersion(input.expectedVersion)) {
    throw new CliError('invalid_arguments');
  }
  return { requested: input.requested, expectedVersion: input.expectedVersion };
}

function setOutcome(value: unknown, commandId: string): ListeningModeOutcome {
  if (!plainObject(value) || value.commandId !== commandId) return refused('outcome_unknown');
  if (value.outcome === 'refused') return refused(refusalReason(value.reason));
  const state = modeState(value.requested, value.effective, value.reason, value.version);
  if (state === null) return refused('outcome_unknown');
  if (value.outcome === 'applied') return { kind: 'applied', ...state };
  if (value.outcome === 'conflict') return { kind: 'conflict', reason: 'stale_version', current: state };
  return refused('outcome_unknown');
}

function modeState(requested: unknown, effective: unknown, reason: unknown, version: unknown): ListeningModeState | null {
  if (!validMode(requested) || !(effective === null || validMode(effective))
    || !(reason === null || validIdentifier(reason)) || !validVersion(version)) return null;
  return { requested, effective, effectiveReason: reason, version };
}

function supportMap(value: unknown): Record<ListeningMode, ListeningModeSupportProjection> | null {
  if (!plainObject(value)) return null;
  const steer = supportProjection(value.steer);
  const sync = supportProjection(value.sync);
  const asyncSupport = supportProjection(value.async);
  return steer && sync && asyncSupport ? { steer, sync, async: asyncSupport } : null;
}

function supportProjection(value: unknown): ListeningModeSupportProjection | null {
  if (!plainObject(value) || typeof value.status !== 'string' || !SUPPORT_STATUSES.includes(value.status)
    || !validIdentifier(value.route)) return null;
  const optional = (field: unknown) => field === undefined || field === null ? null : validIdentifier(field) ? field : undefined;
  const testedVersion = optional(value.testedVersion);
  const evidenceRef = optional(value.evidenceRef);
  const evidenceRevision = optional(value.evidenceRevision);
  const reason = optional(value.reason);
  if (testedVersion === undefined || evidenceRef === undefined || evidenceRevision === undefined || reason === undefined) {
    return null;
  }
  return {
    status: value.status as ModeSupport['status'],
    route: value.route,
    testedVersion,
    evidenceRef,
    evidenceRevision,
    reason,
  };
}

function refusalReason(value: unknown): ListeningModeRefusalReason {
  return typeof value === 'string' && (LISTENING_MODE_REFUSAL_REASONS as readonly string[]).includes(value)
    ? value as ListeningModeRefusalReason
    : 'unavailable';
}

function refused(reason: ListeningModeRefusalReason): ListeningModeOutcome {
  return { kind: 'refused', reason };
}

function validMode(value: unknown): value is ListeningMode {
  return typeof value === 'string' && (LISTENING_MODES as readonly string[]).includes(value);
}

function validVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

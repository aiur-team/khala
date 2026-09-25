// Finite automation limits and listening-mode gates, evaluated inside the claim transaction.
// Counters are keyed by the release's trusted causal root, which the releaser sets from connector
// metadata; nothing the model authors reaches this module, and nothing here resets or refunds a
// reservation.

import { decodeWith, utcTimestamp } from '@khala/contracts/delivery/decode';
import { type HarnessCapabilities, LISTENING_MODES, type SessionBinding } from '@khala/contracts/delivery/index';
import { admitsExistingSessionRoute } from '../route-admission';
import type {
  AttemptSnapshot, BlockCode, DispatchListening, DispatchMode, DispatchPolicy, DispatchRecord, DispatchTx,
} from './types';

const POLICY_KEYS = [
  'armedAt', 'busy', 'expiresAt', 'listening', 'maxConcurrentJobs', 'maxJobsPerCausalRoot', 'paused', 'version',
];
const LISTENING_KEYS = ['effective', 'evidenceRevision', 'requested', 'version'];
const BUSY_POLICIES: readonly unknown[] = ['queue', 'wait', 'reject'];
const MODES: readonly unknown[] = LISTENING_MODES;

const positive = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function usableListening(input: unknown): input is DispatchListening {
  if (typeof input !== 'object' || input === null || !exactKeys(input, LISTENING_KEYS)) return false;
  const listening = input as Record<string, unknown>;
  if (!Number.isSafeInteger(listening.version) || (listening.version as number) < 0) return false;
  if (!MODES.includes(listening.requested)) return false;
  if (listening.effective === null) return listening.evidenceRevision === null;
  return MODES.includes(listening.effective)
    && typeof listening.evidenceRevision === 'string'
    && listening.evidenceRevision !== '';
}

/**
 * A policy is usable only with exactly the known fields, an explicit pause flag, an arming version
 * no later than its version, finite limits, a strict UTC expiry and a well-formed listening
 * projection. Anything else, including a missing field or a `maxCausalDepth`, blocks dispatch.
 */
export function usablePolicy(policy: DispatchPolicy | null): policy is DispatchPolicy {
  if (typeof policy !== 'object' || policy === null || !exactKeys(policy, POLICY_KEYS)) return false;
  if (typeof policy.paused !== 'boolean') return false;
  if (!Number.isSafeInteger(policy.version) || policy.version < 0) return false;
  if (!Number.isSafeInteger(policy.armedAt) || policy.armedAt < 0 || policy.armedAt > policy.version) return false;
  if (!positive(policy.maxJobsPerCausalRoot) || !positive(policy.maxConcurrentJobs)) return false;
  if (policy.expiresAt !== null && !decodeWith(() => utcTimestamp(policy.expiresAt, 'expiresAt')).ok) return false;
  if (!usableListening(policy.listening)) return false;
  return BUSY_POLICIES.includes(policy.busy);
}

/** Whether a release's policy version lies within the binding's current arming. */
export function currentRelease(policy: DispatchPolicy, policyVersion: number): boolean {
  return policy.armedAt <= policyVersion && policyVersion <= policy.version;
}

export function expired(policy: DispatchPolicy, now: Date): boolean {
  return policy.expiresAt !== null && now.getTime() >= Date.parse(policy.expiresAt);
}

/**
 * The mode a new claim may use: the effective mode, when it equals the requested one and is
 * `steer` or `sync`. `async` is held silently for the agent's pull; anything else waits.
 */
export function dispatchMode(listening: DispatchListening): DispatchMode | 'mode_async' | 'mode_unavailable' {
  const { requested, effective } = listening;
  if (effective === null || effective !== requested) return 'mode_unavailable';
  return effective === 'async' ? 'mode_async' : effective;
}

/**
 * Whether the harness route may receive this binding's job at all. Tested native delivery must
 * resume the existing session (KD1) for the bound harness, with busy behavior known not to steer a
 * running turn. The agent-installed listener is separately guarded by an explicit experimental opt-in.
 */
export function supportedRoute(
  capabilities: HarnessCapabilities,
  binding: SessionBinding,
  allowExperimentalAgentListener = false,
): boolean {
  if (!admitsExistingSessionRoute(capabilities, binding.harness, allowExperimentalAgentListener)) return false;
  return capabilities.existingSession === 'agent_installed_listener'
    || capabilities.busy === 'queue'
    || capabilities.busy === 'reject';
}

/**
 * The exact route identity for delivering `binding`'s job in `mode`, or null when the capabilities do
 * not evidence that mode for this harness and version. The evidence must be the revision the
 * effective mode was derived from, so a grant or proof that has since changed never carries over.
 */
export function routeSnapshot(
  capabilities: HarnessCapabilities,
  binding: SessionBinding,
  mode: DispatchMode,
  evidenceRevision: string | null,
): AttemptSnapshot | null {
  const support = capabilities.modes[mode];
  if (support.status !== 'proven' && support.status !== 'experimental') return null;
  if (capabilities.harness !== binding.harness || support.testedVersion !== capabilities.version) return null;
  if (evidenceRevision === null || support.evidenceRevision !== evidenceRevision) return null;
  return {
    modeAtClaim: mode,
    bindingGeneration: binding.generation,
    sessionId: binding.sessionId,
    harness: capabilities.harness,
    harnessVersion: capabilities.version,
    adapterVersion: capabilities.adapterVersion,
    route: support.route,
    evidenceRevision: support.evidenceRevision,
  };
}

/** Whether two snapshots name the same route identity, field by field. */
export function sameSnapshot(a: AttemptSnapshot, b: AttemptSnapshot): boolean {
  return a.modeAtClaim === b.modeAtClaim
    && a.bindingGeneration === b.bindingGeneration
    && a.sessionId === b.sessionId
    && a.harness === b.harness
    && a.harnessVersion === b.harnessVersion
    && a.adapterVersion === b.adapterVersion
    && a.route === b.route
    && a.evidenceRevision === b.evidenceRevision;
}

/**
 * The limit check for one queued record. `null` means the record may claim; `terminal` marks a
 * refusal that no later pass can change. Without `harnessBusy` (a precheck before the harness was
 * inspected) a `queue` policy behind active work is left to the claim to decide. A record that
 * already holds its reservation is not counted against the causal budget again.
 */
export function checkLimits(
  tx: DispatchTx,
  policy: DispatchPolicy,
  record: DispatchRecord,
  harnessBusy: HarnessCapabilities['busy'] | null,
): Readonly<{ code: BlockCode; terminal: boolean }> | null {
  const active = tx.active();
  if (!record.reserved && tx.causalCount(record.job.causalRootId) >= policy.maxJobsPerCausalRoot) {
    return { code: 'budget_exhausted', terminal: false };
  }
  if (active.length >= policy.maxConcurrentJobs) return { code: 'at_capacity', terminal: false };
  const bindingId = record.job.binding.bindingId;
  const onBinding = active.filter(other => other.job.binding.bindingId === bindingId);
  // A claim still waiting at its boundary, or an earlier release returned to pending from one, keeps
  // the binding's later releases behind it whatever the busy policy, so they are never delivered out
  // of order.
  if (onBinding.some(other => other.state === 'claimed')) return { code: 'busy', terminal: false };
  const heldEarlier = tx.queued().some(id => {
    const other = tx.record(id);
    return other !== null && other.seq < record.seq && other.reserved && other.job.binding.bindingId === bindingId;
  });
  if (heldEarlier) return { code: 'busy', terminal: false };
  if (onBinding.length > 0) {
    if (policy.busy === 'reject') return { code: 'busy', terminal: true };
    // Queueing behind active work needs a harness route proven to queue. Without it the job waits;
    // it never starts a replacement turn.
    if (policy.busy === 'wait' || (harnessBusy !== null && harnessBusy !== 'queue')) return { code: 'busy', terminal: false };
  }
  return null;
}

/**
 * Reserves the record's one attempt under its causal root, unless it already holds it. Call only
 * in the claiming transaction.
 */
export function reserve(tx: DispatchTx, record: DispatchRecord): void {
  if (record.reserved) return;
  const root = record.job.causalRootId;
  tx.setCausalCount(root, tx.causalCount(root) + 1);
}

// Describe either proven Codex route without starting, resuming or attaching to a thread.

import { isAbsolute, normalize } from 'node:path';
import {
  type DeliveryLimits, type HarnessCapabilities, type ReceiptErrorCode, type SessionBinding, sameSessionBinding,
  unknownModeSupportMap,
} from '@khala/contracts/delivery/index';
import {
  type CodexClientPort, type CodexConnection, type CodexDeadlines, type CodexHost, type CodexHostPort,
  type NativeThread, guardConnection, readThread, withDeadline,
} from './native';

export const CODEX_HARNESS = 'codex';
export const CODEX_ADAPTER_VERSION = 'khala-hosted-queue-1';
export const CODEX_EVIDENCE_REF = 'docs/evidence/codex.md';
export const CODEX_NATIVE_CLI_ADAPTER_VERSION = 'native-cli-notification-1';
export const CODEX_NATIVE_CLI_EVIDENCE_REF = 'docs/evidence/codex-native-cli.md#queue-idle';

/**
 * Exact versions with same-session evidence. A newer or older version is not promoted
 * by semver; it needs its own proof run.
 */
export const TESTED_CODEX_VERSIONS: readonly string[] = ['0.154.0'];

/**
 * Receipt kinds this adapter can report. The KHA-106 fixture lists what the KHA-104
 * proof observed natively. `transport_written` is added because it is the connector's
 * own observation: the client port reports a flushed write.
 */
export const CODEX_RECEIPT_EVIDENCE = [
  'transport_written', 'harness_queued', 'context_consumed', 'completed', 'outcome_unknown', 'failed',
] as const;

export const CODEX_NATIVE_CLI_RECEIPT_EVIDENCE = [
  'harness_queued', 'outcome_unknown', 'failed',
] as const;

export type ProbeFailure =
  | 'wrong_harness'
  | 'no_host'
  | 'stale_binding'
  | 'unsupported_version'
  | 'unsafe_endpoint'
  | 'writer_not_held'
  | 'unreachable'
  | 'malformed_response'
  | 'thread_mismatch'
  | 'workdir_mismatch'
  | 'thread_unknown'
  | 'not_loaded'
  | 'system_error';

export type Probe =
  | Readonly<{ ok: true; host: CodexHost; thread: NativeThread; connection: CodexConnection }>
  | Readonly<{ ok: false; reason: ProbeFailure }>;

const FAILURE_CODES: Readonly<Record<ProbeFailure, ReceiptErrorCode>> = {
  wrong_harness: 'stale_binding',
  stale_binding: 'stale_binding',
  thread_mismatch: 'stale_binding',
  no_host: 'session_unavailable',
  thread_unknown: 'session_unavailable',
  workdir_mismatch: 'session_unavailable',
  writer_not_held: 'session_unavailable',
  not_loaded: 'session_unavailable',
  system_error: 'session_unavailable',
  unsupported_version: 'harness_unavailable',
  unsafe_endpoint: 'harness_unavailable',
  unreachable: 'harness_unavailable',
  malformed_response: 'harness_unavailable',
};

export function probeErrorCode(reason: ProbeFailure): ReceiptErrorCode {
  return FAILURE_CODES[reason];
}

export type ProbeDeps = Readonly<{ hosts: CodexHostPort; client: CodexClientPort; deadlines: CodexDeadlines }>;

const ABSOLUTE_SOCKET = /^\/[^\0]*$/;
const isNormalAbsolute = (path: string) => !path.includes('\0') && isAbsolute(path) && normalize(path) === path;

/**
 * Checks the binding against the host Khala started for it, then reads the native
 * thread's metadata over that host's listener. On success the caller owns `connection`.
 */
export async function probeBinding(binding: SessionBinding, deps: ProbeDeps): Promise<Probe> {
  const fail = (reason: ProbeFailure): Probe => ({ ok: false, reason });
  if (binding.harness !== CODEX_HARNESS) return fail('wrong_harness');
  let host: CodexHost | null;
  try {
    host = await withDeadline(deps.hosts.lookup(binding), deps.deadlines.callMs, null);
  } catch {
    host = null;
  }
  if (!host) return fail('no_host');
  // The host was started for one immutable binding generation; anything else is stale.
  if (!sameSessionBinding(host.binding, binding)) return fail('stale_binding');
  if (!TESTED_CODEX_VERSIONS.includes(host.cliVersion)) return fail('unsupported_version');
  if (host.endpoint.kind !== 'unix' || !ABSOLUTE_SOCKET.test(host.endpoint.path) || !host.endpointPrivate) {
    return fail('unsafe_endpoint');
  }
  if (typeof host.workdir !== 'string' || !isNormalAbsolute(host.workdir)) return fail('workdir_mismatch');
  // The host's report; any other holder means another executor owns the thread.
  if (!host.holdsWriter) return fail('writer_not_held');

  let connecting: ReturnType<CodexClientPort['connect']>;
  try {
    connecting = deps.client.connect(host.endpoint);
  } catch {
    // A port must never throw synchronously, but a defensive port call still reports
    // `unreachable` instead of rejecting the caller.
    return fail('unreachable');
  }
  let opened: CodexConnection | null;
  try {
    opened = await withDeadline(connecting, deps.deadlines.callMs, null);
  } catch {
    opened = null;
  }
  if (!opened) {
    // A connection that opens after the deadline is closed, not leaked.
    connecting.then(late => late?.close()).catch(() => {});
    return fail('unreachable');
  }
  const connection = guardConnection(opened, deps.deadlines);
  const done = async (reason: ProbeFailure): Promise<Probe> => {
    await connection.close();
    return fail(reason);
  };
  const outcome = await connection.request('thread/read', { threadId: binding.sessionId, includeTurns: false });
  // The listener answered but refused the thread: it does not host this session.
  if (outcome.status === 'remote_error') return done('thread_unknown');
  if (outcome.status !== 'response') return done('unreachable');
  const thread = readThread(outcome.result);
  if (!thread) return done('malformed_response');
  if (thread.id !== binding.sessionId) return done('thread_mismatch');
  // KHA-104 proved the route only with no cwd override, and its driver refuses a thread
  // whose native cwd differs from the workdir (`experiments/codex/guards.ts`).
  if (thread.cwd !== host.workdir) return done('workdir_mismatch');
  // `notLoaded` means this host does not hold the thread; resuming it here is host setup,
  // never a delivery side effect.
  if (thread.status === 'notLoaded') return done('not_loaded');
  if (thread.status === 'systemError') return done('system_error');
  return { ok: true, host, thread, connection };
}

/** The KHA-104 route: a dormant thread resumed in a Khala-started app-server, queue delivery. */
export function testedCapabilities(version: string, limits: DeliveryLimits): HarnessCapabilities {
  return {
    v: 3,
    harness: CODEX_HARNESS,
    version,
    adapterVersion: CODEX_ADAPTER_VERSION,
    support: 'tested',
    existingSession: 'khala_hosted_resume',
    immediateNotification: 'khala_hosted_idle',
    // Busy delivery waits for the running turn and then runs as a new turn.
    busy: 'queue',
    receiptEvidence: [...CODEX_RECEIPT_EVIDENCE],
    reconcileByReleaseId: 'while_queued',
    limits,
    evidenceRef: CODEX_EVIDENCE_REF,
    modes: unknownModeSupportMap(
      'codex-interactive-hooks',
      'Khala-hosted app-server evidence is secondary and cannot prove delivery into the user-owned Codex TUI.',
      version,
    ),
    acknowledgement: 'unknown',
  };
}

/** KHA-146 route A: native queue notification plus KHA-148's local payload inbox. */
export function nativeCliCapabilities(version: string, limits: DeliveryLimits): HarnessCapabilities {
  return {
    v: 3,
    harness: CODEX_HARNESS,
    version,
    adapterVersion: CODEX_NATIVE_CLI_ADAPTER_VERSION,
    support: 'tested',
    existingSession: 'native_cli_queue',
    immediateNotification: 'native_cli_queue',
    busy: 'queue',
    receiptEvidence: [...CODEX_NATIVE_CLI_RECEIPT_EVIDENCE],
    reconcileByReleaseId: 'unsupported',
    limits,
    evidenceRef: CODEX_NATIVE_CLI_EVIDENCE_REF,
    modes: unknownModeSupportMap(
      'codex-interactive-native',
      'The native queue proves notification only; idle agents receive messages only at their next turn until payload delivery is proved.',
      version,
    ),
    acknowledgement: 'unknown',
  };
}

export function unsupportedNativeCliCapabilities(version: string, limits: DeliveryLimits): HarnessCapabilities {
  return {
    ...unsupportedCapabilities(version, limits),
    adapterVersion: CODEX_NATIVE_CLI_ADAPTER_VERSION,
    evidenceRef: CODEX_NATIVE_CLI_EVIDENCE_REF,
  };
}

/** Anything off the proven route: no capability is claimed. */
export function unsupportedCapabilities(version: string, limits: DeliveryLimits): HarnessCapabilities {
  return {
    v: 3,
    harness: CODEX_HARNESS,
    version,
    adapterVersion: CODEX_ADAPTER_VERSION,
    support: 'unsupported',
    existingSession: 'unknown',
    immediateNotification: 'unknown',
    busy: 'unknown',
    receiptEvidence: [],
    reconcileByReleaseId: 'unknown',
    limits,
    evidenceRef: CODEX_EVIDENCE_REF,
    modes: unknownModeSupportMap(
      'codex-interactive-uninspected',
      'This exact Codex version and interactive session route have not been inspected.',
      version,
    ),
    acknowledgement: 'unknown',
  };
}

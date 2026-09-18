// U1: decide whether a binding is on the one route KHA-104 proved, and describe it.
// Nothing here resumes, starts or attaches to a thread.

import {
  type DeliveryLimits, type HarnessCapabilities, type ReceiptErrorCode, type SessionBinding, sameSessionBinding,
} from '@khala/contracts/delivery/index';
import {
  type CodexClientPort, type CodexConnection, type CodexHost, type CodexHostPort, type NativeThread, guardConnection, readThread,
} from './native';

export const CODEX_HARNESS = 'codex';
export const CODEX_ADAPTER_VERSION = 'khala-hosted-queue-1';
export const CODEX_EVIDENCE_REF = 'docs/evidence/codex.md';

/**
 * Exact versions with same-session evidence. A newer or older version is not promoted
 * by semver; it needs its own proof run.
 */
export const TESTED_CODEX_VERSIONS: readonly string[] = ['0.154.0'];

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

const ABSOLUTE_SOCKET = /^\/[^\0]*$/;

/**
 * Checks the binding against the host Khala started for it, then reads the native
 * thread over that host's listener. On success the caller owns `connection`.
 */
export async function probeBinding(
  binding: SessionBinding,
  hosts: CodexHostPort,
  client: CodexClientPort,
): Promise<Probe> {
  const fail = (reason: ProbeFailure): Probe => ({ ok: false, reason });
  if (binding.harness !== CODEX_HARNESS) return fail('wrong_harness');
  let host: CodexHost | null;
  try {
    host = await hosts.lookup(binding);
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
  // A lock held by anyone else means another executor owns the thread.
  if (!host.holdsWriter) return fail('writer_not_held');

  let opened: CodexConnection | null;
  try {
    opened = await client.connect(host.endpoint);
  } catch {
    opened = null;
  }
  if (!opened) return fail('unreachable');
  const connection = guardConnection(opened);
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
  // `notLoaded` means this host does not hold the thread; resuming it here is host setup,
  // never a delivery side effect.
  if (thread.status === 'notLoaded') return done('not_loaded');
  if (thread.status === 'systemError') return done('system_error');
  return { ok: true, host, thread, connection };
}

/** The KHA-104 route: a dormant thread resumed in a Khala-started app-server, queue delivery. */
export function testedCapabilities(version: string, limits: DeliveryLimits): HarnessCapabilities {
  return {
    v: 1,
    harness: CODEX_HARNESS,
    version,
    adapterVersion: CODEX_ADAPTER_VERSION,
    support: 'tested',
    existingSession: 'khala_hosted_resume',
    immediateNotification: 'khala_hosted_idle',
    // Busy delivery waits for the running turn and then runs as a new turn.
    busy: 'queue',
    receiptEvidence: ['transport_written', 'harness_queued', 'context_consumed', 'completed', 'outcome_unknown', 'failed'],
    reconcileByReleaseId: 'while_queued',
    limits,
    evidenceRef: CODEX_EVIDENCE_REF,
  };
}

/** Anything off the proven route: no capability is claimed. */
export function unsupportedCapabilities(version: string, limits: DeliveryLimits): HarnessCapabilities {
  return {
    v: 1,
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
  };
}

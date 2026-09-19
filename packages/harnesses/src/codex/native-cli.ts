// Place approved bytes in the local Khala inbox, then use `codex queue` only
// for an opaque notification: its stdin-like message values are literals, so
// released bytes must never enter argv.

import type { DeliveryReceipt, ReleasedJob, SessionBinding } from '@khala/contracts/delivery/index';
import { sameSessionBinding } from '@khala/contracts/delivery/index';
import { withDeadline } from './native';
import { EVIDENCE, makeReceipt, recordQuietly } from './receipts';
import {
  type AttemptedReleases, type SubmitDeps, verifyReleasePayload,
} from './transport';

export type CodexNativeSessionState = 'present' | 'absent' | 'not_owned';

export type CodexNativeCliInspection = Readonly<{
  version: string | null;
  session: CodexNativeSessionState;
  bindingId: string | null;
  generation: number | null;
  platform: string;
  arch: string;
}>;

export type CodexNativeCliOutcome =
  | Readonly<{ status: 'queued'; queueId: string }>
  | Readonly<{ status: 'exited'; code: number }>
  | Readonly<{ status: 'not_started' }>
  | Readonly<{ status: 'lost'; cause: 'disconnected' | 'timeout' }>;

/**
 * Composition owns process discovery and execution. The adapter owns the exact argv,
 * so tests can prove that released bytes are absent from it.
 */
export interface CodexNativeCliPort {
  inspect(sessionId: string): Promise<CodexNativeCliInspection>;
  run(argv: readonly string[]): Promise<CodexNativeCliOutcome>;
}

/** Shape accepted by the durable inbox implemented by @khala/agent-cli. */
export type CodexNativeInboxDelivery = Readonly<{
  v: 1;
  releaseId: ReleasedJob['releaseId'];
  bindingId: ReleasedJob['binding']['bindingId'];
  generation: number;
  events: ReleasedJob['events'];
  payloadDigest: ReleasedJob['payloadDigest'];
  payload: Uint8Array;
  receivedAt: string;
}>;

export interface CodexNativeInboxPort {
  enqueue(delivery: CodexNativeInboxDelivery): Promise<'appended' | 'duplicate'>;
}

export type NativeCliDeps = Pick<SubmitDeps, 'clock' | 'codec' | 'deadlines' | 'evidence' | 'limits'> & Readonly<{
  nativeCli: CodexNativeCliPort;
  nativeInbox: CodexNativeInboxPort;
}>;

export type NativeCliProbe =
  | Readonly<{ ok: true; binding: SessionBinding; version: string; platform: string; arch: string }>
  | Readonly<{
    ok: false;
    reason: 'wrong_harness' | 'unreachable' | 'session_unavailable' | 'not_owned' | 'binding_mismatch';
  }>;

export async function probeNativeCli(binding: SessionBinding, deps: NativeCliDeps): Promise<NativeCliProbe> {
  if (binding.harness !== 'codex') return { ok: false, reason: 'wrong_harness' };
  let inspection: CodexNativeCliInspection | null;
  try {
    inspection = await withDeadline(deps.nativeCli.inspect(binding.sessionId), deps.deadlines.callMs, null);
  } catch {
    inspection = null;
  }
  if (
    !inspection
    || typeof inspection.version !== 'string'
    || inspection.version.length === 0
    || (inspection.bindingId !== null && typeof inspection.bindingId !== 'string')
    || (inspection.generation !== null && !Number.isSafeInteger(inspection.generation))
    || typeof inspection.platform !== 'string'
    || typeof inspection.arch !== 'string'
    || !['present', 'absent', 'not_owned'].includes(inspection.session)
  ) return { ok: false, reason: 'unreachable' };
  if (inspection.session === 'not_owned') return { ok: false, reason: 'not_owned' };
  if (inspection.session !== 'present') return { ok: false, reason: 'session_unavailable' };
  if (inspection.bindingId !== binding.bindingId || inspection.generation !== binding.generation) {
    return { ok: false, reason: 'binding_mismatch' };
  }
  return { ok: true, binding, version: inspection.version, platform: inspection.platform, arch: inspection.arch };
}

export async function submitNativeRelease(
  deps: NativeCliDeps,
  attempted: AttemptedReleases,
  selectedBinding: SessionBinding,
  job: ReleasedJob,
  payload: Uint8Array,
): Promise<DeliveryReceipt> {
  const target = { releaseId: job.releaseId, binding: job.binding };
  const failed = (errorCode: 'stale_binding' | 'payload_digest_mismatch' | 'limit_exceeded' | 'harness_rejected') =>
    makeReceipt(target, 'failed', deps.clock, { source: 'connector', errorCode });
  const unknown = (errorCode?: 'harness_unavailable' | 'harness_rejected' | 'disconnected' | 'timeout') =>
    makeReceipt(target, 'outcome_unknown', deps.clock, errorCode ? { source: 'connector', errorCode } : { source: 'connector' });

  if (!sameSessionBinding(selectedBinding, job.binding)) return failed('stale_binding');
  const verified = await verifyReleasePayload(deps, job, payload);
  if (!verified.ok) return verified.receipt;
  if (attempted.has(job.releaseId)) return unknown();
  attempted.add(job.releaseId);

  const delivery: CodexNativeInboxDelivery = {
    v: 1,
    releaseId: job.releaseId,
    bindingId: job.binding.bindingId,
    generation: job.binding.generation,
    events: job.events,
    payloadDigest: job.payloadDigest,
    payload: new Uint8Array(verified.bytes),
    receivedAt: deps.clock.now().toISOString(),
  };
  let inboxResult: 'appended' | 'duplicate' | 'unknown';
  try {
    inboxResult = await withDeadline(deps.nativeInbox.enqueue(delivery), deps.deadlines.callMs, 'unknown' as const);
  } catch {
    inboxResult = 'unknown';
  }
  // A duplicate or uncertain append may follow an earlier completed write. Neither
  // licenses another native notification.
  if (inboxResult !== 'appended') return unknown('harness_unavailable');

  const notification = `Khala release ${job.releaseId} is ready in the local inbox. Run khala listen.`;
  const argv = ['queue', '--thread', job.binding.sessionId, '--message', notification] as const;
  let outcome: CodexNativeCliOutcome;
  try {
    outcome = await withDeadline(
      deps.nativeCli.run(argv),
      deps.deadlines.callMs,
      { status: 'lost', cause: 'timeout' } as const,
    );
  } catch {
    outcome = { status: 'lost', cause: 'disconnected' };
  }

  if (outcome.status === 'queued' && typeof outcome.queueId === 'string' && outcome.queueId.length > 0) {
    const receipt = makeReceipt(target, 'harness_queued', deps.clock, {
      source: 'harness', evidenceRef: EVIDENCE.nativeQueued,
    });
    await recordQuietly(deps.evidence, receipt, deps.deadlines.callMs);
    return receipt;
  }
  if (outcome.status === 'exited') return unknown('harness_rejected');
  if (outcome.status === 'not_started') return unknown('harness_unavailable');
  if (outcome.status === 'lost' && (outcome.cause === 'disconnected' || outcome.cause === 'timeout')) {
    return unknown(outcome.cause);
  }
  return unknown();
}

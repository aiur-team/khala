// Submission checks for the Claude adapter. KHA-145 rejected both candidate
// native routes, so a validated release stops at the final fail-closed gate.

import { createHash } from 'node:crypto';
import {
  type Clock, type DeliveryLimits, type DeliveryReceipt, type ReceiptErrorCode, type ReleasedJob, type SessionBinding,
  sameSessionBinding, validatePayloadBytes,
} from '@khala/contracts/delivery/index';
import type { ClaudeNativeRoutePort, ClaudeSessionState } from './native-cli';
import { failedReceipt } from './receipts';

export type InspectedClaudeBinding = Readonly<{ binding: SessionBinding; session: ClaudeSessionState }>;

export type ClaudeSubmitDeps = Readonly<{
  route: ClaudeNativeRoutePort;
  clock: Clock;
  limits: DeliveryLimits;
}>;

export async function submitRelease(
  deps: ClaudeSubmitDeps,
  inspected: InspectedClaudeBinding | undefined,
  job: ReleasedJob,
  payload: Uint8Array,
): Promise<DeliveryReceipt> {
  const failed = (errorCode: ReceiptErrorCode) => failedReceipt(job, errorCode, deps.clock);
  if (!inspected) return failed('session_unavailable');
  if (!sameSessionBinding(inspected.binding, job.binding)) return failed('stale_binding');
  if (inspected.session !== 'present') return failed('session_unavailable');
  const bytes = validatePayloadBytes(payload, deps.limits);
  if (!bytes.ok) return failed(bytes.code === 'limit_exceeded' ? 'limit_exceeded' : 'payload_digest_mismatch');
  if (sha256(bytes.value) !== job.payloadDigest) return failed('payload_digest_mismatch');

  // `route` is intentionally injected but unreachable. KHA-145 proved neither
  // candidate safe enough to invoke; retaining the seam avoids restructuring when
  // a future proof can replace this final gate.
  void deps.route;
  return failed('harness_unavailable');
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

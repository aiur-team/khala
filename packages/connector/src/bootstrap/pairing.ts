// `pairing-code-v1`, the code-only cross-machine ownership method. The human
// reads a short-lived code off the hosted channel and gives it to an agent that is
// already running on another machine. The connector claims that code with its
// own proof key, reserved device and inspected native session, then waits for the
// owner to approve exactly that claim. Approval yields a 60-second grant bound to
// the same key, which the ordinary bootstrap redeem turns into a binding.
//
// Code possession grants nothing: it permits one claim attempt. The code, the
// claim receipt and the grant exist only inside one `claim` call. No response
// text, and no channel or owner identity, ever leaves this module.

import { createHash } from 'node:crypto';
import {
  decodePairingApprovalResult, decodePairingClaimResult, decodePairingFailure,
} from '@khala/contracts/messaging/index';
import type { HarnessCapabilities } from '@khala/contracts/delivery/index';
import { PAIRING_METHOD } from './descriptor';
import { readBounded } from './discovery';
import type { PairingOutcome, PairingOwnershipPort, VerifiedSession } from './ports';
import type { ProofSigner } from './proof';

/** A pairing request lives five minutes; waiting longer can never succeed. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4_096;
const MEDIA_TYPE = 'application/json';

export type PairingOwnershipOptions = Readonly<{
  signer: ProofSigner;
  fetch?: typeof fetch;
  /** Upper bound on the whole claim and approval wait. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Trusted local time in epoch milliseconds. */
  clock?: () => number;
  /** Resolves after `ms`, or early when `signal` aborts. Injected by tests. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}>;

/**
 * Versioned digest of the inspected session evidence: the verified session plus
 * the adapter identity that verified it. The caller's own session claim is not an
 * input; it is only the locator the inspection started from.
 */
export function sessionEvidenceDigest(session: VerifiedSession, capabilities: HarnessCapabilities): string {
  return createHash('sha256').update(JSON.stringify([
    'khala.pairing.evidence.v1',
    session.harness, session.sessionId, session.generation,
    capabilities.harness, capabilities.version, capabilities.adapterVersion, capabilities.existingSession, capabilities.evidenceRef,
  ])).digest('base64url');
}

export function createPairingOwnership(options: PairingOwnershipOptions): PairingOwnershipPort {
  const transport = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const clock = options.clock ?? Date.now;
  const wait = options.wait ?? sleep;
  const { signer } = options;

  return {
    jkt: signer.jkt,
    async claim({ code, descriptor, session, evidenceDigest, deviceId, operationId, signal }): Promise<PairingOutcome> {
      const deadline = clock() + timeoutMs;
      if (signal?.aborted) return { kind: 'pending', reason: 'cancelled' };

      // Same operation, key, session and device: the service reconciles a repeated
      // claim to the original request, so a lost response is safe to retry.
      const claimed = await post(transport, descriptor.claim, {
        v: 1, code, operationId, jkt: signer.jkt,
        harness: session.harness, sessionId: session.sessionId, generation: session.generation,
        deviceId, evidenceDigest,
      }, signer.proof('POST', descriptor.claim), signal);
      if (claimed.kind === 'failed') return signal?.aborted ? { kind: 'pending', reason: 'cancelled' } : { kind: 'unavailable' };
      if (claimed.status !== 200) return claimRefusal(claimed);
      const receipt = decodePairingClaimResult(claimed.body);
      if (!receipt.ok) return { kind: 'unavailable' };
      const { requestHandle } = receipt.value;

      for (;;) {
        if (signal?.aborted) return { kind: 'pending', reason: 'cancelled' };
        if (clock() >= deadline) return { kind: 'pending', reason: 'approval_timeout' };
        const polled = await post(transport, descriptor.result, {
          v: 1, requestHandle, receipt: receipt.value.receipt, operationId, jkt: signer.jkt,
        }, signer.proof('POST', descriptor.result), signal);
        if (polled.kind === 'response' && polled.status === 200) {
          const decision = decodePairingApprovalResult(polled.body);
          if (!decision.ok) return { kind: 'unavailable' };
          const result = decision.value;
          if (result.state === 'denied') return { kind: 'refused', code: 'pairing_denied' };
          if (result.state === 'expired') return { kind: 'refused', code: 'pairing_expired' };
          if (result.state === 'approved') {
            const expiresAt = Date.parse(result.expiresAt);
            if (!(expiresAt > clock())) return { kind: 'refused', code: 'pairing_expired' };
            return {
              kind: 'granted',
              grant: { method: PAIRING_METHOD, redeem: descriptor.redeem, session, deviceId, expiresAt, secret: result.grant },
            };
          }
        } else if (polled.kind === 'response') {
          const refusal = resultRefusal(polled);
          if (refusal !== null) return refusal;
        }
        // Pending, or a transient failure: wait and ask again until the deadline.
        await wait(Math.max(0, Math.min(pollIntervalMs, deadline - clock())), signal);
      }
    },
  };
}

type PostResult =
  | Readonly<{ kind: 'response'; status: number; body: unknown }>
  | Readonly<{ kind: 'failed' }>;

function claimRefusal(response: Readonly<{ status: number; body: unknown }>): PairingOutcome {
  if (response.status === 429) return { kind: 'refused', code: 'rate_limited' };
  if (response.status >= 500) return { kind: 'unavailable' };
  const failure = decodePairingFailure('claim', response.body);
  if (!failure.ok) return { kind: 'unavailable' };
  switch (failure.value.code) {
    case 'rate_limited': return { kind: 'refused', code: 'rate_limited' };
    case 'invalid_proof': return { kind: 'refused', code: 'ownership_required' };
    case 'feature_unavailable': return { kind: 'refused', code: 'ownership_required' };
    case 'unavailable': return { kind: 'unavailable' };
    // Invalid, expired, used and foreign codes are one indistinguishable refusal.
    default: return { kind: 'refused', code: 'pairing_refused' };
  }
}

/** A terminal refusal from the result route, or `null` to keep waiting. */
function resultRefusal(response: Readonly<{ status: number; body: unknown }>): PairingOutcome | null {
  if (response.status === 429 || response.status >= 500) return null;
  const failure = decodePairingFailure('result', response.body);
  if (!failure.ok) return { kind: 'unavailable' };
  switch (failure.value.code) {
    case 'unavailable': return null;
    case 'invalid_proof': return { kind: 'refused', code: 'ownership_required' };
    case 'feature_unavailable': return { kind: 'refused', code: 'ownership_required' };
    default: return { kind: 'refused', code: 'pairing_refused' };
  }
}

/**
 * DPoP-bound JSON POST. `origin` is the service's own origin, as the control
 * gateway requires on state-changing requests; authority comes from the proof.
 */
async function post(transport: typeof fetch, url: string, body: unknown, dpop: string, signal?: AbortSignal): Promise<PostResult> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await transport(url, {
      method: 'POST',
      headers: { 'content-type': MEDIA_TYPE, accept: MEDIA_TYPE, origin: new URL(url).origin, dpop },
      body: JSON.stringify(body),
      redirect: 'error',
      credentials: 'omit',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    return { kind: 'failed' };
  }
  try {
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (mediaType !== MEDIA_TYPE) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'response', status: response.status, body: null };
    }
    const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
    if (bytes === null || bytes.length === 0) return { kind: 'response', status: response.status, body: null };
    return { kind: 'response', status: response.status, body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    return { kind: 'response', status: response.status, body: null };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

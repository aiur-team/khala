// Harness-neutral capabilities and effects. Evidence is scoped to one exact
// harness/version/adapter route; this module selects no automation or busy default.

import {
  type Decoded, type DeliveryLimits, array, decodeWith, elementField, fail, identifier, literal, nullable,
  object, readDeliveryLimits, version,
} from './decode';
import type { SessionBinding } from './binding';
import type { ReleaseId } from './ids';
import type { ReleasedJob } from './jobs';
import { RECEIPT_KINDS, type DeliveryReceipt, type ReceiptKind } from './receipts';

export const HARNESS_SUPPORT = ['tested', 'experimental', 'unsupported'] as const;
export const BUSY_BEHAVIORS = ['queue', 'steer', 'reject', 'unknown'] as const;

// Each capability is `unknown` (not investigated), `unsupported` (investigated and
// absent) or a value naming the exact evidence-backed scope. There is no boolean
// `true`: a claim is only as broad as the route that was observed.

/**
 * `khala_hosted_resume`: a dormant session resumed inside a host Khala started keeps
 * its identity (KHA-104 Codex evidence). Attaching to a session another process is
 * already running is not covered by this value.
 */
export const EXISTING_SESSION_SUPPORT = ['unknown', 'unsupported', 'khala_hosted_resume'] as const;

/**
 * `khala_hosted_idle`: an idle session in a Khala-started host begins a turn for a
 * queued release without a human prompt. Busy handling is described by `busy`.
 */
export const IMMEDIATE_NOTIFICATION_SUPPORT = ['unknown', 'unsupported', 'khala_hosted_idle'] as const;

/**
 * `while_queued`: the harness can find a submission by release ID only while it is
 * still queued. Deduplication after consumption belongs to the connector.
 */
export const RECONCILE_SUPPORT = ['unknown', 'unsupported', 'while_queued'] as const;

export type HarnessCapabilities = Readonly<{
  v: 1;
  harness: string;
  version: string;
  adapterVersion: string;
  support: (typeof HARNESS_SUPPORT)[number];
  existingSession: (typeof EXISTING_SESSION_SUPPORT)[number];
  immediateNotification: (typeof IMMEDIATE_NOTIFICATION_SUPPORT)[number];
  busy: (typeof BUSY_BEHAVIORS)[number];
  receiptEvidence: readonly ReceiptKind[];
  reconcileByReleaseId: (typeof RECONCILE_SUPPORT)[number];
  limits: DeliveryLimits;
  evidenceRef: string | null;
}>;

/**
 * `submit` and `reconcile` accept only a verified `ReleasedJob`, produced by
 * `releaseFromApproval` or `verifyReleasedJob`. A decoded `UnverifiedReleasedJob`
 * does not type-check here.
 */
export interface HarnessPort {
  inspect(binding: SessionBinding): Promise<HarnessCapabilities>;
  notify(binding: SessionBinding, hint: Readonly<{ v: 1; releaseId: ReleaseId }>): Promise<void>;
  submit(input: Readonly<{ job: ReleasedJob; payload: Uint8Array }>): Promise<DeliveryReceipt>;
  reconcile(job: ReleasedJob): Promise<DeliveryReceipt | null>;
  close(): Promise<void>;
}

export function decodeHarnessCapabilities(input: unknown): Decoded<HarnessCapabilities> {
  return decodeWith(() => {
    const r = object(input, '', [
      'v',
      'harness',
      'version',
      'adapterVersion',
      'support',
      'existingSession',
      'immediateNotification',
      'busy',
      'receiptEvidence',
      'reconcileByReleaseId',
      'limits',
      'evidenceRef',
    ]);
    const v = version(r.field('v'), r.at('v'));
    const evidenceValues = array(r.field('receiptEvidence'), r.at('receiptEvidence'));
    const seen = new Set<ReceiptKind>();
    const receiptEvidence = evidenceValues.map((value, index) => {
      const field = elementField(r.at('receiptEvidence'), index);
      const kind = literal(value, field, RECEIPT_KINDS);
      if (seen.has(kind)) fail(field, 'invalid_field');
      seen.add(kind);
      return kind;
    });
    const support = literal(r.field('support'), r.at('support'), HARNESS_SUPPORT);
    const evidenceRef = nullable(r.field('evidenceRef'), value => identifier(value, r.at('evidenceRef')));
    if (support === 'tested' && evidenceRef === null) fail(r.at('evidenceRef'), 'invalid_field');
    return {
      v,
      harness: identifier(r.field('harness'), r.at('harness')),
      version: identifier(r.field('version'), r.at('version')),
      adapterVersion: identifier(r.field('adapterVersion'), r.at('adapterVersion')),
      support,
      existingSession: literal(r.field('existingSession'), r.at('existingSession'), EXISTING_SESSION_SUPPORT),
      immediateNotification: literal(
        r.field('immediateNotification'),
        r.at('immediateNotification'),
        IMMEDIATE_NOTIFICATION_SUPPORT,
      ),
      busy: literal(r.field('busy'), r.at('busy'), BUSY_BEHAVIORS),
      receiptEvidence,
      reconcileByReleaseId: literal(r.field('reconcileByReleaseId'), r.at('reconcileByReleaseId'), RECONCILE_SUPPORT),
      limits: readDeliveryLimits(r.field('limits'), r.at('limits')),
      evidenceRef,
    };
  });
}

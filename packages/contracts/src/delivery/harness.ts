// Harness-neutral capabilities and effects. Evidence is scoped to one exact
// harness/version/adapter route; this module selects no automation or busy default.

import {
  type Decoded, type DeliveryLimits, array, booleanValue, decodeWith, elementField, fail, identifier, literal, nullable,
  object, readDeliveryLimits,
} from './decode';
import type { SessionBinding } from './binding';
import type { ReleaseId } from './ids';
import type { ReleasedJob } from './jobs';
import { RECEIPT_KINDS, type DeliveryReceipt, type ReceiptKind } from './receipts';

const HARNESS_SUPPORT = ['tested', 'experimental', 'unsupported'] as const;
const BUSY_BEHAVIORS = ['queue', 'steer', 'reject', 'unknown'] as const;

export type HarnessCapabilities = Readonly<{
  harness: string;
  version: string;
  adapterVersion: string;
  support: (typeof HARNESS_SUPPORT)[number];
  existingSession: boolean;
  immediateNotification: boolean;
  busy: (typeof BUSY_BEHAVIORS)[number];
  receiptEvidence: readonly ReceiptKind[];
  reconcileByReleaseId: boolean;
  limits: DeliveryLimits;
  evidenceRef: string | null;
}>;

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
      harness: identifier(r.field('harness'), r.at('harness')),
      version: identifier(r.field('version'), r.at('version')),
      adapterVersion: identifier(r.field('adapterVersion'), r.at('adapterVersion')),
      support,
      existingSession: booleanValue(r.field('existingSession'), r.at('existingSession')),
      immediateNotification: booleanValue(r.field('immediateNotification'), r.at('immediateNotification')),
      busy: literal(r.field('busy'), r.at('busy'), BUSY_BEHAVIORS),
      receiptEvidence,
      reconcileByReleaseId: booleanValue(r.field('reconcileByReleaseId'), r.at('reconcileByReleaseId')),
      limits: readDeliveryLimits(r.field('limits'), r.at('limits')),
      evidenceRef,
    };
  });
}

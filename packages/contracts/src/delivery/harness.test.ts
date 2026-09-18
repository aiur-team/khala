import { describe, expect, it } from 'vitest';
import exact from '../../fixtures/delivery/exact-release.json';
import views from '../../fixtures/delivery/views.json';
import type { SessionBinding } from './binding';
import {
  EXISTING_SESSION_SUPPORT, IMMEDIATE_NOTIFICATION_SUPPORT, RECONCILE_SUPPORT,
  type HarnessCapabilities, type HarnessPort, decodeHarnessCapabilities,
} from './harness';
import { type DeliveryReceipt, RECEIPT_ERROR_CODES, RECEIPT_KINDS, decodeDeliveryReceipt } from './receipts';

const capabilityViews = views.valid.filter(view => view.decoder === 'capabilities');
const route = (name: string): unknown => capabilityViews.find(view => view.name.startsWith(name))!.input;

describe('HarnessCapabilities', () => {
  it('has no boolean capability: each is unknown, unsupported or evidence-scoped', () => {
    for (const values of [EXISTING_SESSION_SUPPORT, IMMEDIATE_NOTIFICATION_SUPPORT, RECONCILE_SUPPORT]) {
      expect(values.slice(0, 2)).toEqual(['unknown', 'unsupported']);
      expect(values).toHaveLength(3);
    }
    expect(EXISTING_SESSION_SUPPORT[2]).toBe('khala_hosted_resume');
    expect(IMMEDIATE_NOTIFICATION_SUPPORT[2]).toBe('khala_hosted_idle');
    expect(RECONCILE_SUPPORT[2]).toBe('while_queued');
  });

  it('claims for the proven Codex route only what KHA-104 observed', () => {
    expect(decodeHarnessCapabilities(exact.capabilities)).toEqual({ ok: true, value: exact.capabilities });
    expect(exact.capabilities).toMatchObject({
      harness: 'codex',
      version: '0.154.0',
      support: 'tested',
      existingSession: 'khala_hosted_resume',
      reconcileByReleaseId: 'while_queued',
      busy: 'queue',
      evidenceRef: 'docs/evidence/codex.md',
    });
  });

  it('keeps the Claude session and every foreign or generic route out of support claims', () => {
    expect(route('Claude')).toMatchObject({ support: 'unsupported', existingSession: 'unsupported' });
    for (const name of ['Codex executor Khala did not start', 'unproven generic harness']) {
      expect(route(name)).toMatchObject({
        support: 'unsupported',
        existingSession: 'unknown',
        immediateNotification: 'unknown',
        reconcileByReleaseId: 'unknown',
        busy: 'unknown',
        receiptEvidence: [],
      });
    }
  });

  it('uses one harness name for a harness across fixtures', () => {
    expect(exact.binding.harness).toBe(exact.capabilities.harness);
    expect(exact.releasedJob.binding.harness).toBe(exact.capabilities.harness);
  });
});

describe('DeliveryReceipt', () => {
  it('pins the receipt vocabulary as independent evidence facts', () => {
    expect(RECEIPT_KINDS).toEqual([
      'queued',
      'dispatching',
      'transport_written',
      'harness_queued',
      'context_consumed',
      'completed',
      'outcome_unknown',
      'failed',
      'cancel_requested',
      'cancelled',
    ]);
  });

  it('pins a closed, content-free error vocabulary', () => {
    expect(RECEIPT_ERROR_CODES).toEqual([
      'harness_unavailable',
      'harness_rejected',
      'session_unavailable',
      'busy_rejected',
      'stale_binding',
      'payload_digest_mismatch',
      'limit_exceeded',
      'disconnected',
      'timeout',
    ]);
  });

  it.each(RECEIPT_ERROR_CODES)('accepts closed code %s on a failed receipt', errorCode => {
    const receipt = { ...exact.receipt, kind: 'failed', errorCode };
    expect(decodeDeliveryReceipt(receipt)).toEqual({ ok: true, value: receipt });
  });
});

describe('HarnessPort', () => {
  it('keeps notification to a release hint and exposes reconciliation without cancellation', async () => {
    let notification: { v: 1; releaseId: string } | null = null;
    const capabilities = exact.capabilities as unknown as HarnessCapabilities;
    const receipt = exact.receipt as unknown as DeliveryReceipt;
    const port = {
      inspect: async () => capabilities,
      notify: async (...args: [SessionBinding, { v: 1; releaseId: string }]) => {
        notification = args[1];
      },
      submit: async () => receipt,
      reconcile: async () => receipt,
      close: async () => undefined,
    } satisfies HarnessPort;

    await port.notify({} as SessionBinding, { v: 1, releaseId: 'release-1' });
    expect(notification).toEqual({ v: 1, releaseId: 'release-1' });
    expect(Object.keys(notification ?? {})).toEqual(['v', 'releaseId']);
    expect('cancel' in port).toBe(false);
  });
});

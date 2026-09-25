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
const route = (adapterVersion: string): unknown => {
  const view = capabilityViews.find(candidate => candidate.input.adapterVersion === adapterVersion);
  if (view === undefined) throw new Error(`missing capability fixture: ${adapterVersion}`);
  return view.input;
};

describe('HarnessCapabilities', () => {
  it('has no boolean capability: each is unknown, unsupported or evidence-scoped', () => {
    for (const values of [EXISTING_SESSION_SUPPORT, IMMEDIATE_NOTIFICATION_SUPPORT, RECONCILE_SUPPORT]) {
      expect(values.slice(0, 2)).toEqual(['unknown', 'unsupported']);
    }
    expect(EXISTING_SESSION_SUPPORT).toEqual([
      'unknown', 'unsupported', 'khala_hosted_resume', 'native_cli_queue', 'agent_installed_listener',
    ]);
    expect(IMMEDIATE_NOTIFICATION_SUPPORT).toEqual([
      'unknown', 'unsupported', 'khala_hosted_idle', 'native_cli_queue', 'agent_installed_listener',
    ]);
    expect(RECONCILE_SUPPORT).toEqual(['unknown', 'unsupported', 'while_queued']);
  });

  it('claims for the proven Codex route only what KHA-104 observed', () => {
    expect(decodeHarnessCapabilities(exact.capabilities)).toEqual({ ok: true, value: exact.capabilities });
    expect(exact.capabilities).toMatchObject({
      v: 3,
      harness: 'codex',
      version: '0.154.0',
      support: 'tested',
      existingSession: 'khala_hosted_resume',
      reconcileByReleaseId: 'while_queued',
      busy: 'queue',
      evidenceRef: 'docs/evidence/codex.md',
      acknowledgement: 'unknown',
    });
    expect(exact.capabilities.modes).toMatchObject({
      steer: { status: 'unknown' }, sync: { status: 'unknown' }, async: { status: 'unknown' },
    });
  });

  it('pins the KHA-146 native queue to tested notification-only support', () => {
    const nativeQueue = route('native-cli-notification');
    expect(nativeQueue).toMatchObject({
      support: 'tested',
      existingSession: 'native_cli_queue',
      immediateNotification: 'native_cli_queue',
      busy: 'queue',
      receiptEvidence: ['harness_queued', 'context_consumed', 'outcome_unknown', 'failed'],
      reconcileByReleaseId: 'unsupported',
      evidenceRef: 'docs/evidence/codex-native-cli.md#queue-idle',
    });
    expect(decodeHarnessCapabilities({ ...(nativeQueue as Record<string, unknown>), evidenceRef: null }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'evidenceRef' });
  });

  it('keeps the KHA-145 agent-installed listener fail-closed without live proof', () => {
    expect(route('generic-agent-installed-listener')).toMatchObject({
      harness: 'generic-agent-listener',
      version: 'unproven',
      support: 'unsupported',
      existingSession: 'agent_installed_listener',
      immediateNotification: 'agent_installed_listener',
      busy: 'unknown',
      receiptEvidence: ['transport_written', 'outcome_unknown', 'failed'],
      reconcileByReleaseId: 'unsupported',
      evidenceRef: null,
    });
  });

  it('keeps every Claude capability row off unproven native routes', () => {
    const claudeRoutes = capabilityViews.filter(view => view.input.harness === 'claude');
    expect(claudeRoutes.length).toBeGreaterThan(0);
    for (const view of claudeRoutes) {
      expect(['unknown', 'unsupported']).toContain(view.input.existingSession);
      expect(['unknown', 'unsupported']).toContain(view.input.immediateNotification);
    }
  });

  it('rejects the v1 capabilities envelope after the v2 route expansion', () => {
    expect(decodeHarnessCapabilities({ ...exact.capabilities, v: 1 }))
      .toEqual({ ok: false, code: 'invalid_version', field: 'v' });
  });

  it('decodes a retained v2 envelope into a conservative v3 view', () => {
    const legacy = structuredClone(exact.capabilities) as Record<string, unknown>;
    legacy.v = 2;
    delete legacy.modes;
    delete legacy.acknowledgement;
    const decoded = decodeHarnessCapabilities(legacy);
    expect(decoded).toMatchObject({
      ok: true,
      value: {
        v: 3,
        acknowledgement: 'unknown',
        modes: {
          steer: { status: 'unknown' },
          sync: { status: 'unknown' },
          async: { status: 'unknown' },
        },
      },
    });
    if (decoded.ok) {
      expect(Object.values(decoded.value.modes).every(mode => mode.reason?.includes('v2'))).toBe(true);
    }
  });

  it('keeps acknowledgement independent of otherwise identical mode support', () => {
    for (const acknowledgement of ['unknown', 'unsupported', 'batch_token_next_call'] as const) {
      expect(decodeHarnessCapabilities({ ...exact.capabilities, acknowledgement })).toEqual({
        ok: true, value: { ...exact.capabilities, acknowledgement },
      });
    }
  });

  it('keeps the Claude session and every foreign or generic route out of support claims', () => {
    expect(route('native-route-unavailable-1')).toMatchObject({
      support: 'unsupported', existingSession: 'unsupported', evidenceRef: 'docs/evidence/claude-native-cli.md',
    });
    for (const adapterVersion of ['foreign-executor', 'unimplemented']) {
      expect(route(adapterVersion)).toMatchObject({
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

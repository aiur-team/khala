import { describe, expect, it } from 'vitest';
import capabilityFixtures from '../../fixtures/delivery/capabilities.json';
import type { SessionBinding } from './binding';
import { decodeHarnessCapabilities, type HarnessCapabilities, type HarnessPort } from './harness';
import { decodeDeliveryReceipt, RECEIPT_KINDS, type DeliveryReceipt } from './receipts';

const clone = <T>(value: T): T => structuredClone(value);

const validReceipt = {
  v: 1,
  receiptId: 'receipt-release-b-1-queued',
  releaseId: 'release-b-1',
  bindingId: 'bind-b-1',
  generation: 0,
  kind: 'harness_queued',
  observedAt: '2026-09-18T02:38:00.125Z',
  source: 'harness',
  evidenceRef: 'codex:userMessage:release-b-1',
  errorCode: null,
};

describe('HarnessCapabilities', () => {
  it('decodes every evidence-scoped fixture without broadening its claim', () => {
    const decoded = capabilityFixtures.valid.map(testCase => decodeHarnessCapabilities(testCase.input));
    expect(decoded.every(result => result.ok)).toBe(true);

    const values = decoded.map(result => {
      if (!result.ok) throw new Error(`fixture failed at ${result.field}`);
      return result.value;
    });
    expect(values[0]).toMatchObject({
      harness: 'codex',
      version: '0.154.0',
      adapterVersion: 'probe-driver@9a28af84',
      support: 'tested',
      busy: 'queue',
      evidenceRef: 'docs/evidence/codex.md',
    });
    expect(values[1]).toMatchObject({
      harness: 'claude',
      version: '2.1.276',
      support: 'unsupported',
      existingSession: true,
      immediateNotification: true,
      busy: 'unknown',
      evidenceRef: 'docs/evidence/claude.md',
    });
    expect(values[2]).toMatchObject({
      harness: 'unproven-extension',
      support: 'unsupported',
      busy: 'unknown',
      evidenceRef: null,
    });
  });

  it('requires evidence for tested support', () => {
    const candidate = clone(capabilityFixtures.valid[0]!.input);
    candidate.evidenceRef = null;
    expect(decodeHarnessCapabilities(candidate)).toEqual({ ok: false, code: 'invalid_field', field: 'evidenceRef' });
  });

  it('does not choose a busy default', () => {
    const candidate = clone(capabilityFixtures.valid[0]!.input) as Record<string, unknown>;
    delete candidate.busy;
    expect(decodeHarnessCapabilities(candidate)).toEqual({ ok: false, code: 'invalid_field', field: 'busy' });

    candidate.busy = 'interrupt';
    expect(decodeHarnessCapabilities(candidate)).toEqual({ ok: false, code: 'invalid_field', field: 'busy' });
  });

  it('requires explicit configured delivery limits', () => {
    const missing = clone(capabilityFixtures.valid[0]!.input) as Record<string, unknown>;
    delete missing.limits;
    expect(decodeHarnessCapabilities(missing)).toEqual({ ok: false, code: 'invalid_field', field: 'limits' });

    const invalid = clone(capabilityFixtures.valid[0]!.input);
    invalid.limits.maxPayloadBytes = 0;
    expect(decodeHarnessCapabilities(invalid)).toEqual({
      ok: false,
      code: 'invalid_field',
      field: 'limits.maxPayloadBytes',
    });
  });

  it('rejects duplicate or invented receipt evidence', () => {
    const duplicate = clone(capabilityFixtures.valid[0]!.input);
    duplicate.receiptEvidence = ['completed', 'completed'];
    expect(decodeHarnessCapabilities(duplicate)).toEqual({
      ok: false,
      code: 'invalid_field',
      field: 'receiptEvidence[1]',
    });

    const invented = clone(capabilityFixtures.valid[0]!.input);
    invented.receiptEvidence = ['prompt_delivered'];
    expect(decodeHarnessCapabilities(invented)).toEqual({
      ok: false,
      code: 'invalid_field',
      field: 'receiptEvidence[0]',
    });
  });

  it('rejects unknown fields instead of silently dropping them', () => {
    const candidate = { ...clone(capabilityFixtures.valid[0]!.input), model: 'any' };
    expect(decodeHarnessCapabilities(candidate)).toEqual({ ok: false, code: 'invalid_field', field: 'model' });
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

  it('decodes a correlated version 1 receipt unchanged', () => {
    expect(decodeDeliveryReceipt(validReceipt)).toEqual({ ok: true, value: validReceipt });
  });

  it.each([
    ['v', { ...validReceipt, v: 2 }, 'invalid_version'],
    ['kind', { ...validReceipt, kind: 'delivered' }, 'invalid_field'],
    ['generation', { ...validReceipt, generation: -1 }, 'invalid_field'],
    ['observedAt', { ...validReceipt, observedAt: '2026-09-18 02:38:00Z' }, 'invalid_field'],
    ['source', { ...validReceipt, source: 'model' }, 'invalid_field'],
  ])('rejects an invalid %s', (field, candidate, code) => {
    expect(decodeDeliveryReceipt(candidate)).toEqual({ ok: false, code, field });
  });

  it('accepts nullable evidence and safe error codes without plaintext detail', () => {
    const receipt = { ...validReceipt, kind: 'failed', evidenceRef: null, errorCode: 'writer_unavailable' };
    expect(decodeDeliveryReceipt(receipt)).toEqual({ ok: true, value: receipt });
  });

  it('rejects content-bearing or cancellation-authority fields', () => {
    expect(decodeDeliveryReceipt({ ...validReceipt, preview: 'pending plaintext' })).toEqual({
      ok: false,
      code: 'invalid_field',
      field: 'preview',
    });
    expect(decodeDeliveryReceipt({ ...validReceipt, cancellationSucceeded: true })).toEqual({
      ok: false,
      code: 'invalid_field',
      field: 'cancellationSucceeded',
    });
  });
});

describe('HarnessPort', () => {
  it('keeps notification to a release hint and exposes reconciliation without cancellation', async () => {
    let notification: { v: 1; releaseId: string } | null = null;
    const capabilities = capabilityFixtures.valid[0]!.input as unknown as HarnessCapabilities;
    const receipt = validReceipt as unknown as DeliveryReceipt;
    const port = {
      inspect: async () => capabilities,
      notify: async (...args: [SessionBinding, { v: 1; releaseId: string }]) => {
        const hint = args[1];
        notification = hint;
      },
      submit: async () => receipt,
      reconcile: async () => receipt,
      close: async () => undefined,
    } satisfies HarnessPort;

    await port.notify({} as SessionBinding, { v: 1, releaseId: 'release-b-1' });
    expect(notification).toEqual({ v: 1, releaseId: 'release-b-1' });
    expect(Object.keys(notification ?? {})).toEqual(['v', 'releaseId']);
    expect('cancel' in port).toBe(false);
  });
});

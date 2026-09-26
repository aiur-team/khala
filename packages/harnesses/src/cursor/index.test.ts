import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type AppHarnessIdentity, type ReleasedJob, type SessionBinding, LISTENING_MODES, decodeAppHarnessRecord,
  decodeApprovalCommand, decodeDeliveryLimits, decodeSessionBinding, releaseFromApproval,
} from '@khala/contracts/delivery/index';
import exact from '../../../contracts/fixtures/delivery/exact-release.json';
import {
  CURSOR_BLOCKED_REASONS, CURSOR_BLOCKED_SUMMARIES, CURSOR_MODE_ROUTES, CURSOR_NEXT_TURN_ONLY_REASON, CURSOR_PROOF_MATRIX_REF,
  CURSOR_ROUTE_PROOFS, type CursorInspection, type CursorRouteProof, createCursorHarness, cursorAppRecord,
  cursorReceiptKind,
} from './index';

const unwrap = <T>(decoded: { ok: true; value: T } | { ok: false; field: string }): T => {
  if (!decoded.ok) throw new Error(`fixture failed at ${decoded.field}`);
  return decoded.value;
};

const limits = unwrap(decodeDeliveryLimits(exact.limits));
const clock = { now: () => new Date('2026-09-25T10:00:00.000Z') };
const repoFile = (relative: string) => JSON.parse(readFileSync(new URL(`../../../../${relative}`, import.meta.url), 'utf8'));

const local: CursorInspection = {
  shape: 'local_chat', appVersion: '1.7.4', accountTier: 'pro', administratorPolicyScope: 'personal-no-admin-policy',
};
const identity = (overrides: Partial<AppHarnessIdentity> = {}): AppHarnessIdentity => ({
  v: 1, app: 'cursor', shape: 'local_chat', appVersion: '1.7.4', accountTier: 'pro',
  administratorPolicyScope: 'personal-no-admin-policy', ...overrides,
});
const proof = (mode: CursorRouteProof['mode'], overrides: Partial<AppHarnessIdentity> = {}): CursorRouteProof => ({
  identity: identity(overrides), mode, evidenceRef: `${CURSOR_PROOF_MATRIX_REF}#${mode}`, evidenceRevision: 'abc123',
});

function cursorBinding(generation = 0): SessionBinding {
  return unwrap(decodeSessionBinding({ ...exact.binding, harness: 'cursor', sessionId: 'conversation-1/session-1', generation }));
}

function releasedJob(): ReleasedJob {
  const approval = unwrap(decodeApprovalCommand(exact.approvalCommand, limits));
  const released = releaseFromApproval({
    approval, items: approval.selection, binding: cursorBinding(), policyVersion: approval.expectedPolicyVersion,
    release: exact.release as never,
  });
  if (!released.ok) throw new Error(`release failed: ${released.code}`);
  return released.value;
}

describe('Cursor app capability record', () => {
  it('reports every mode unknown for every shape while no proof exists', () => {
    expect(CURSOR_ROUTE_PROOFS).toEqual([]);
    for (const inspection of [local, { ...local, shape: 'cloud_task' as const }]) {
      const record = cursorAppRecord(inspection, limits);
      expect(decodeAppHarnessRecord(record)).toEqual({ ok: true, value: record });
      expect(record.boundaries).toEqual({ steer: null, sync: null, async: null });
      expect(record.capabilities).toMatchObject({
        harness: 'cursor', version: '1.7.4', support: 'unsupported', existingSession: 'unknown',
        receiptEvidence: ['failed'], evidenceRef: null, acknowledgement: 'unknown',
      });
      for (const mode of LISTENING_MODES) {
        const support = record.capabilities.modes[mode];
        expect(support).toMatchObject({ status: 'unknown', route: CURSOR_MODE_ROUTES[mode], evidenceRef: null });
        expect(support.reason).toContain(CURSOR_BLOCKED_SUMMARIES[inspection.shape]);
      }
      // Decisions 34 and 37: the honest idle claim rides on every push mode.
      expect(record.capabilities.modes.steer.reason).toContain(CURSOR_NEXT_TURN_ONLY_REASON);
      expect(record.capabilities.modes.sync.reason).toContain(CURSOR_NEXT_TURN_ONLY_REASON);
    }
  });

  it('keeps the proof table and the Blocked reasons in step with the committed proof record', () => {
    type Cell = { status: string; route: string; evidenceRef: string | null; evidenceRevision: string | null };
    const matrix = repoFile(CURSOR_PROOF_MATRIX_REF) as Record<string, Record<string, Cell>>;
    const blocked = repoFile('experiments/interactive-cli/cursor-app/evidence/blocked.json');
    expect(blocked).toEqual(CURSOR_BLOCKED_REASONS);
    const provenCells: string[] = [];
    // A proof must name the same cell, evidence and revision as the verifier's matrix.
    for (const [shape, modes] of Object.entries(matrix)) {
      for (const [mode, cell] of Object.entries(modes)) {
        expect(cell.route).toBe(CURSOR_MODE_ROUTES[mode as keyof typeof CURSOR_MODE_ROUTES]);
        if (cell.status === 'proven') provenCells.push(`${shape}/${mode} ${cell.evidenceRef} ${cell.evidenceRevision}`);
      }
    }
    const table = CURSOR_ROUTE_PROOFS.map(entry => `${entry.identity.shape}/${entry.mode} ${entry.evidenceRef} ${entry.evidenceRevision}`);
    expect(table.sort()).toEqual(provenCells.sort());
  });

  it('credits a proof only for its exact shape, version, account tier and policy', () => {
    const proofs = [proof('async')];
    const record = cursorAppRecord(local, limits, proofs);
    expect(record.capabilities.modes.async).toEqual({
      status: 'proven', route: 'mcp.khala_read', testedVersion: '1.7.4',
      evidenceRef: `${CURSOR_PROOF_MATRIX_REF}#async`, evidenceRevision: 'abc123', reason: null,
    });
    expect(record.boundaries).toEqual({ steer: null, sync: null, async: 'khala_read' });
    expect(record.capabilities.acknowledgement).toBe('batch_token_next_call');
    expect(record.capabilities.modes.steer.status).toBe('unknown');

    for (const other of [
      { ...local, appVersion: '1.7.5' }, { ...local, accountTier: 'business' },
      { ...local, administratorPolicyScope: 'enterprise-hooks' },
    ]) {
      const unmatched = cursorAppRecord(other, limits, proofs);
      expect(unmatched.capabilities.modes.async.status).toBe('unknown');
      expect(unmatched.capabilities.acknowledgement).toBe('unknown');
      expect(unmatched.boundaries.async).toBeNull();
    }
  });

  it('fails closed when any tuple field could not be inspected', () => {
    const proofs = [proof('steer'), proof('sync'), proof('async')];
    for (const field of ['appVersion', 'accountTier', 'administratorPolicyScope'] as const) {
      const record = cursorAppRecord({ ...local, [field]: null }, limits, proofs);
      for (const mode of LISTENING_MODES) {
        expect(record.capabilities.modes[mode].status).toBe('unknown');
        expect(record.capabilities.modes[mode].reason).toContain(`${field} could not be inspected`);
      }
    }
    const unknownVersion = cursorAppRecord({ ...local, appVersion: null }, limits, proofs);
    expect(unknownVersion.capabilities.version).toBe('unknown');
  });

  it('wrong implementation: a cloud proof cannot enable local support', () => {
    const cloudOnly = LISTENING_MODES.map(mode => proof(mode, { shape: 'cloud_task' }));
    const localRecord = cursorAppRecord(local, limits, cloudOnly);
    for (const mode of LISTENING_MODES) expect(localRecord.capabilities.modes[mode].status).toBe('unknown');
    expect(localRecord.boundaries).toEqual({ steer: null, sync: null, async: null });
    expect(localRecord.capabilities.existingSession).toBe('unknown');

    const cloudRecord = cursorAppRecord({ ...local, shape: 'cloud_task' }, limits, cloudOnly);
    for (const mode of LISTENING_MODES) expect(cloudRecord.capabilities.modes[mode].status).toBe('proven');
    expect(cloudRecord.capabilities.existingSession).toBe('native_hooks');
  });

  it('refuses a proof that does not name an exact Cursor tuple', () => {
    expect(() => cursorAppRecord(local, limits, [proof('async', { accountTier: 'unknown' })])).toThrow(/exact Cursor tuple/);
    expect(() => cursorAppRecord(local, limits, [proof('async', { app: 'codex' })])).toThrow(/exact Cursor tuple/);
    expect(() => cursorAppRecord(local, limits, [proof('async', { shape: 'browser' })])).toThrow(/exact Cursor tuple/);
  });

  it('reports a version the contract cannot carry as uninspected', () => {
    const record = cursorAppRecord({ ...local, appVersion: 'x'.repeat(10_000) }, limits, [proof('async')]);
    expect(record.appVersion).toBe('unknown');
    expect(record.capabilities.modes.async.status).toBe('unknown');
  });
});

describe('Cursor receipts', () => {
  const proven = cursorAppRecord(local, limits, [proof('steer'), proof('sync'), proof('async')]);
  const unproven = cursorAppRecord(local, limits);

  it('wrong implementation: a postToolUse receipt alone cannot report context consumption', () => {
    const kind = cursorReceiptKind({ kind: 'hook_output_accepted', boundary: 'postToolUse' }, proven);
    expect(kind).toBe('harness_queued');
    expect(kind).not.toBe('context_consumed');
    expect(cursorReceiptKind({ kind: 'hook_output_accepted', boundary: 'stop' }, proven)).toBe('harness_queued');
    expect(cursorReceiptKind({ kind: 'read_returned' }, proven)).toBe('harness_queued');
  });

  it('credits nothing for an unproven route, and acknowledges only through the batch token', () => {
    expect(cursorReceiptKind({ kind: 'hook_output_accepted', boundary: 'postToolUse' }, unproven)).toBeNull();
    expect(cursorReceiptKind({ kind: 'hook_output_accepted', boundary: 'stop' }, unproven)).toBeNull();
    expect(cursorReceiptKind({ kind: 'read_returned' }, unproven)).toBeNull();
    expect(cursorReceiptKind({ kind: 'next_call_acknowledged' }, unproven)).toBeNull();
    expect(cursorReceiptKind({ kind: 'next_call_acknowledged' }, proven)).toBe('agent_acknowledged');
  });
});

describe('Cursor harness port', () => {
  const harness = (inspection: unknown, proofs?: readonly CursorRouteProof[]) => createCursorHarness({
    probe: { inspect: async () => inspection as CursorInspection }, clock, limits, ...(proofs ? { proofs } : {}),
  });

  it('inspects the exact tuple and never delivers', async () => {
    const port = harness(local);
    const capabilities = await port.inspect(cursorBinding());
    expect(capabilities).toEqual(cursorAppRecord(local, limits).capabilities);
    const job = releasedJob();
    const receipt = await port.submit({ job, payload: new Uint8Array() });
    expect(receipt).toMatchObject({ kind: 'failed', errorCode: 'harness_unavailable', source: 'connector' });
    expect(await port.submit({ job, payload: new Uint8Array() })).toEqual(receipt);
    await expect(port.notify(cursorBinding(), { v: 1, releaseId: job.releaseId })).resolves.toBeUndefined();
    expect(await port.reconcile(job)).toBeNull();
  });

  it('keeps failing closed even when the inspected tuple is proven', async () => {
    const port = harness(local, [proof('steer'), proof('sync'), proof('async')]);
    expect((await port.inspectApp(cursorBinding())).capabilities.modes.async.status).toBe('proven');
    expect((await port.submit({ job: releasedJob(), payload: new Uint8Array() })).kind).toBe('failed');
  });

  it('treats a malformed probe answer as an uninspected local chat', async () => {
    for (const garbage of [null, { shape: 'browser' }, { shape: 'local_chat', appVersion: 7 }]) {
      const record = await harness(garbage, [proof('async')]).inspectApp(cursorBinding());
      expect(record.shape).toBe('local_chat');
      expect(record.capabilities.modes.async.status).toBe('unknown');
    }
  });

  it('refuses another harness and a closed adapter', async () => {
    const port = harness(local);
    const codex = unwrap(decodeSessionBinding({ ...exact.binding, harness: 'codex' }));
    await expect(port.inspect(codex)).rejects.toThrow(/another harness/);
    await port.close();
    await expect(port.inspect(cursorBinding())).rejects.toThrow(/closed/);
  });
});

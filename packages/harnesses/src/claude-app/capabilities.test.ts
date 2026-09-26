import {
  type AppHarnessIdentity, type BindingId, type DeliveryLimits, type ReleasedJob, decodeAppHarnessRecord,
  decodeDeliveryLimits,
} from '@khala/contracts/delivery/index';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_APP_EVIDENCE, CLAUDE_APP_SHAPES, type ClaudeAppEvidence, type ClaudeAppObservation, claudeAppIdentity,
  claudeAppRecord, createClaudeAppHarness,
} from './index';

const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 65_536 });
if (!decodedLimits.ok) throw new Error('fixture limits');
const limits: DeliveryLimits = decodedLimits.value;
const desktop: ClaudeAppObservation = {
  shape: 'desktop_extension', appVersion: '1.2.3', accountTier: 'max', administratorPolicyScope: 'personal',
};
const identity = (observation: ClaudeAppObservation): AppHarnessIdentity => claudeAppIdentity(observation);

const row = (overrides: Partial<ClaudeAppEvidence> = {}): ClaudeAppEvidence => ({
  identity: identity(desktop),
  mode: 'async',
  boundary: 'khala_read',
  delivery: 'khala_read_result',
  route: 'claude-app-desktop-extension-khala-read',
  evidenceRef: 'experiments/interactive-cli/claude-app/evidence/desktop_extension/verdict.json',
  evidenceRevision: 'claude-app-2026-10-01',
  ...overrides,
});

describe('claudeAppRecord', () => {
  it('ships every shape with every mode unknown and nothing selectable', () => {
    expect(CLAUDE_APP_EVIDENCE).toEqual([]);
    for (const shape of CLAUDE_APP_SHAPES) {
      const record = claudeAppRecord({ ...desktop, shape }, limits);
      expect(decodeAppHarnessRecord(record)).toEqual({ ok: true, value: record });
      expect(record.shape).toBe(shape);
      expect(record.boundaries).toEqual({ steer: null, sync: null, async: null });
      expect(record.capabilities.support).toBe('unsupported');
      expect(record.capabilities.acknowledgement).toBe('unknown');
      expect(Object.values(record.capabilities.modes).map(mode => mode.status)).toEqual(['unknown', 'unknown', 'unknown']);
    }
  });

  it('reports uninspected identity fields as unknown and says why', () => {
    const record = claudeAppRecord({ shape: 'browser', appVersion: null, accountTier: null, administratorPolicyScope: null }, limits);
    expect(record).toMatchObject({ appVersion: 'unknown', accountTier: 'unknown', administratorPolicyScope: 'unknown' });
    expect(record.capabilities.modes.async.reason).toMatch(/was not inspected/);
  });

  it('proves the pull route only for the exact tuple its evidence names', () => {
    const proven = claudeAppRecord(desktop, limits, [row()]);
    expect(proven.boundaries).toEqual({ steer: null, sync: null, async: 'khala_read' });
    expect(proven.capabilities).toMatchObject({ support: 'tested', acknowledgement: 'batch_token_next_call' });
    expect(proven.capabilities.modes.async).toMatchObject({ status: 'proven', testedVersion: '1.2.3' });
    expect(proven.capabilities.modes.steer.status).toBe('unknown');

    for (const other of [
      { ...desktop, shape: 'browser' as const },
      { ...desktop, shape: 'remote_connector' as const },
      { ...desktop, appVersion: '1.2.4' },
      { ...desktop, accountTier: 'enterprise' },
      { ...desktop, administratorPolicyScope: 'organization-managed' },
    ]) {
      const record = claudeAppRecord(other, limits, [row()]);
      expect(record.capabilities.modes.async.status).toBe('unknown');
      expect(record.capabilities.acknowledgement).toBe('unknown');
    }
  });

  it('never matches an incomplete tuple, even against evidence recorded for it', () => {
    const blank = { ...desktop, accountTier: null };
    expect(claudeAppRecord(blank, limits, [row({ identity: identity(blank) })]).capabilities.modes.async.status).toBe('unknown');
  });

  it('admits a push mode only for a model-context injection at its own boundary', () => {
    const injected = claudeAppRecord(desktop, limits, [
      row({ mode: 'sync', boundary: 'Stop', delivery: 'model_context_injection', route: 'claude-app-stop' }),
    ]);
    expect(injected.capabilities.modes.sync.status).toBe('proven');
    expect(injected.boundaries.sync).toBe('Stop');

    const misplaced = claudeAppRecord(desktop, limits, [
      row({ mode: 'sync', boundary: 'PostToolUse', delivery: 'model_context_injection' }),
    ]);
    expect(misplaced.capabilities.modes.sync.status).toBe('unknown');
  });

  it('falls back to an uninspected tuple when a value cannot be carried', () => {
    const record = claudeAppRecord({ ...desktop, appVersion: '\u0000' }, limits);
    expect(record.appVersion).toBe('unknown');
  });
});

describe('createClaudeAppHarness', () => {
  const binding = { bindingId: 'binding-1' as BindingId, harness: 'claude', sessionId: 's', generation: 1 };
  const harness = () => createClaudeAppHarness({
    observe: async () => desktop,
    clock: { now: () => new Date('2026-09-25T00:00:00.000Z') },
    limits,
  });

  it('refuses every push without claiming delivery', async () => {
    const port = harness();
    const job = { releaseId: 'release-1', binding, payloadDigest: 'sha256:0' } as unknown as ReleasedJob;
    const receipt = await port.submit({ job, payload: new Uint8Array([1]) });
    expect(receipt).toMatchObject({ kind: 'failed', errorCode: 'harness_unavailable', source: 'connector' });
    expect(await port.reconcile(job)).toBeNull();
  });

  it('keeps modes unknown after a notification', async () => {
    const port = harness();
    const bound = binding as unknown as Parameters<typeof port.inspect>[0];
    await port.notify(bound, {} as Parameters<typeof port.notify>[1]);
    const capabilities = await port.inspect(bound);
    expect(capabilities.modes.steer.status).toBe('unknown');
    await port.close();
    await expect(port.inspect(bound)).rejects.toThrow(/closed/);
  });

  it('refuses a binding for another harness', async () => {
    const port = harness();
    await expect(port.inspect({ ...binding, harness: 'codex' } as unknown as Parameters<typeof port.inspect>[0]))
      .rejects.toThrow(/another harness/);
  });
});

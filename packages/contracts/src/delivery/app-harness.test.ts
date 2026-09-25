import { describe, expect, it } from 'vitest';
import {
  type AppHarness, type AppHarnessIdentity, type AppHarnessRecord,
  decodeAppHarnessRecord, sameAppHarnessIdentity,
} from './app-harness';
import { unknownModeSupportMap } from './listening-mode';

const capabilities = (app: AppHarness, appVersion: string) => ({
  v: 3 as const,
  harness: app,
  version: appVersion,
  adapterVersion: 'app-contract-v1',
  support: 'unsupported' as const,
  existingSession: 'unknown' as const,
  immediateNotification: 'unknown' as const,
  busy: 'unknown' as const,
  receiptEvidence: [],
  reconcileByReleaseId: 'unknown' as const,
  limits: { maxSelectionEvents: 20, maxPayloadBytes: 65_536 },
  evidenceRef: 'docs/app-candidate-inventory',
  modes: unknownModeSupportMap(
    `${app}-app`,
    'This exact app tuple has not been inspected.',
    appVersion,
  ),
  acknowledgement: 'unknown' as const,
});

const cursorLocal = {
  v: 1 as const,
  app: 'cursor' as const,
  shape: 'local_chat' as const,
  appVersion: '1.7.3',
  accountTier: 'business',
  administratorPolicyScope: 'workspace-managed',
  boundaries: { steer: 'postToolUse' as const, sync: 'stop' as const, async: 'khala_read' as const },
  capabilities: capabilities('cursor', '1.7.3'),
};

const claudeBrowser = {
  v: 1 as const,
  app: 'claude' as const,
  shape: 'browser' as const,
  appVersion: '2026-09-24',
  accountTier: 'enterprise',
  administratorPolicyScope: 'organization-default',
  boundaries: { steer: null, sync: null, async: 'khala_read' as const },
  capabilities: capabilities('claude', '2026-09-24'),
};

const without = (input: object, field: string): Record<string, unknown> => {
  const value = structuredClone(input) as Record<string, unknown>;
  delete value[field];
  return value;
};

describe('AppHarnessRecord', () => {
  it('decodes exact Cursor local and Claude browser records', () => {
    expect(decodeAppHarnessRecord(cursorLocal)).toEqual({ ok: true, value: cursorLocal });
    expect(decodeAppHarnessRecord(claudeBrowser)).toEqual({ ok: true, value: claudeBrowser });
  });

  it('accepts both documented case-sensitive hook variants', () => {
    for (const boundaries of [
      { ...cursorLocal.boundaries, steer: 'PostToolUse' as const },
      { ...cursorLocal.boundaries, sync: 'Stop' as const },
    ]) {
      const record = { ...cursorLocal, boundaries };
      expect(decodeAppHarnessRecord(record)).toEqual({ ok: true, value: record });
    }
  });

  it('rejects generic or redefined app capability records', () => {
    expect(decodeAppHarnessRecord({ ...cursorLocal, vendor: 'cursor' }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'vendor' });
    expect(decodeAppHarnessRecord({ ...cursorLocal, support: 'proven' }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'support' });
    expect(decodeAppHarnessRecord({ ...cursorLocal, evidenceRef: 'app-local-evidence' }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'evidenceRef' });
    expect(decodeAppHarnessRecord({ ...cursorLocal, modes: cursorLocal.capabilities.modes }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'modes' });

    const vendorOnly = { ...without(cursorLocal, 'app'), vendor: 'cursor' };
    expect(decodeAppHarnessRecord(vendorOnly))
      .toEqual({ ok: false, code: 'invalid_field', field: 'vendor' });
  });

  it('requires every strict identity component and its closed app and shape values', () => {
    for (const field of ['app', 'shape', 'appVersion', 'accountTier', 'administratorPolicyScope']) {
      expect(decodeAppHarnessRecord(without(cursorLocal, field)))
        .toEqual({ ok: false, code: 'invalid_field', field });
    }
    expect(decodeAppHarnessRecord({ ...cursorLocal, app: 'Cursor' }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'app' });
    expect(decodeAppHarnessRecord({ ...cursorLocal, shape: 'desktop' }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'shape' });
    expect(decodeAppHarnessRecord({ ...cursorLocal, accountTier: '' }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'accountTier' });
  });

  it('rejects boundaries outside their listening mode', () => {
    const substitutions = [
      ['steer', 'Posttooluse'],
      ['steer', 'stop'],
      ['sync', 'Stop '],
      ['sync', 'postToolUse'],
      ['async', 'Khala_read'],
      ['async', 'Stop'],
    ] as const;
    for (const [mode, boundary] of substitutions) {
      expect(decodeAppHarnessRecord({
        ...cursorLocal,
        boundaries: { ...cursorLocal.boundaries, [mode]: boundary },
      })).toEqual({ ok: false, code: 'invalid_field', field: `boundaries.${mode}` });
    }
  });

  it('rejects inconsistent nested capabilities', () => {
    const legacy = structuredClone(cursorLocal.capabilities) as Record<string, unknown>;
    legacy.v = 2;
    delete legacy.modes;
    delete legacy.acknowledgement;
    expect(decodeAppHarnessRecord({ ...cursorLocal, capabilities: legacy }))
      .toEqual({ ok: false, code: 'invalid_version', field: 'capabilities.v' });

    expect(decodeAppHarnessRecord({
      ...cursorLocal,
      capabilities: { ...cursorLocal.capabilities, harness: 'codex' },
    })).toEqual({ ok: false, code: 'invalid_field', field: 'capabilities.harness' });
    expect(decodeAppHarnessRecord({
      ...cursorLocal,
      capabilities: {
        ...cursorLocal.capabilities,
        version: '1.7.4',
        modes: {
          steer: { ...cursorLocal.capabilities.modes.steer, testedVersion: '1.7.4' },
          sync: { ...cursorLocal.capabilities.modes.sync, testedVersion: '1.7.4' },
          async: { ...cursorLocal.capabilities.modes.async, testedVersion: '1.7.4' },
        },
      },
    })).toEqual({ ok: false, code: 'invalid_field', field: 'capabilities.version' });

    const malformed = structuredClone(cursorLocal.capabilities) as Record<string, unknown>;
    const modes = malformed.modes as Record<string, Record<string, unknown>>;
    modes.sync!.status = 'proven';
    modes.sync!.evidenceRef = null;
    expect(decodeAppHarnessRecord({ ...cursorLocal, capabilities: malformed }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'capabilities.modes.sync.evidenceRef' });
  });

  it('compares every app harness identity field', () => {
    const identity: AppHarnessIdentity = {
      v: cursorLocal.v,
      app: cursorLocal.app,
      shape: cursorLocal.shape,
      appVersion: cursorLocal.appVersion,
      accountTier: cursorLocal.accountTier,
      administratorPolicyScope: cursorLocal.administratorPolicyScope,
    };
    const substitutions: { [Field in keyof AppHarnessIdentity]: AppHarnessIdentity[Field] } = {
      v: 2 as AppHarnessIdentity['v'],
      app: 'claude',
      shape: 'cloud_task',
      appVersion: '1.7.4',
      accountTier: 'individual',
      administratorPolicyScope: 'user-default',
    };

    expect(Object.keys(substitutions).sort()).toEqual(Object.keys(identity).sort());
    expect(sameAppHarnessIdentity(identity, { ...identity })).toBe(true);
    for (const [field, value] of Object.entries(substitutions)) {
      const changed = { ...identity, [field]: value } as AppHarnessIdentity;
      expect(sameAppHarnessIdentity(identity, changed)).toBe(false);
      expect(sameAppHarnessIdentity(changed, identity)).toBe(false);
    }
  });

  it('keeps an uninspected tuple unknown despite documented candidate boundaries', () => {
    const decoded = decodeAppHarnessRecord(cursorLocal);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const record: AppHarnessRecord = decoded.value;
    expect(record.boundaries).toEqual({ steer: 'postToolUse', sync: 'stop', async: 'khala_read' });
    expect(record.capabilities.acknowledgement).toBe('unknown');
    expect(record.capabilities.evidenceRef).toBe('docs/app-candidate-inventory');
    for (const support of Object.values(record.capabilities.modes)) {
      expect(support.status).toBe('unknown');
      expect(support.evidenceRef).toBeNull();
      expect(support.evidenceRevision).toBeNull();
      expect(support.reason).toBeTruthy();
    }
  });
});

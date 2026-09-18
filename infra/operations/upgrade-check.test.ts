import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationsError } from './backup.ts';
import { dockerComposePorts, isNoOpUpgrade, runUpgradeCheck } from './upgrade-check.ts';
import type { UpgradeCheckInputs, UpgradeCheckPorts } from './upgrade-check.ts';

const baseInputs: UpgradeCheckInputs = {
  currentSynapseImageDigest: `sha256:${'a'.repeat(64)}`,
  targetSynapseImage: `ghcr.io/element-hq/synapse:v1.162.0@sha256:${'b'.repeat(64)}`,
  databaseDumpPath: '/artifacts/database.dump',
  sourceStateNamespace: 'khala-source-preview',
  copyStateNamespace: 'khala-upgrade-copy',
  allowedCopyNamespaces: ['khala-upgrade-copy'],
};

function fakePorts(overrides: Partial<UpgradeCheckPorts> = {}): { ports: UpgradeCheckPorts; calls: string[] } {
  const calls: string[] = [];
  const ports: UpgradeCheckPorts = {
    targetVolumesExist: async () => {
      calls.push('targetVolumesExist');
      return false;
    },
    denyEgress: async () => {
      calls.push('denyEgress');
    },
    probeEgressDenied: async () => {
      calls.push('probeEgressDenied');
      return true;
    },
    restoreDatabaseCopy: async () => {
      calls.push('restoreDatabaseCopy');
    },
    bootTargetImage: async () => {
      calls.push('bootTargetImage');
    },
    checkHealth: async () => {
      calls.push('checkHealth');
      return true;
    },
    supportsBackwardMigration: async () => {
      calls.push('supportsBackwardMigration');
      return false;
    },
    now: () => new Date('2026-09-17T00:00:00.000Z'),
    ...overrides,
  };
  return { ports, calls };
}

test('a same-image target is a no-op, not a migration rehearsal', () => {
  assert.equal(isNoOpUpgrade({ ...baseInputs, targetSynapseImage: `ghcr.io/element-hq/synapse:v1.161.0@${baseInputs.currentSynapseImageDigest}` }), true);
  assert.equal(isNoOpUpgrade(baseInputs), false);
});

test('a target image sharing only a digest prefix with the current one is never mistaken for a no-op', () => {
  // Guards against a loosened isNoOpUpgrade that matches on a truncated
  // prefix instead of the full digest: these two digests share their first
  // 16 characters but are not the same image.
  const currentSynapseImageDigest = 'sha256:aaaaaaaaaaaaaaaa1111111111111111111111111111111111111111111111';
  const targetSynapseImage = `ghcr.io/element-hq/synapse:v1.162.0@sha256:aaaaaaaaaaaaaaaa2222222222222222222222222222222222222222222222`;
  assert.equal(isNoOpUpgrade({ ...baseInputs, currentSynapseImageDigest, targetSynapseImage }), false);
});

test('the real supportsBackwardMigration port reports false, per Synapse operator docs, not a hardcoded true', async () => {
  assert.equal(await dockerComposePorts.supportsBackwardMigration(baseInputs), false);
});

test('a no-op upgrade check never restores, isolates or boots anything', async () => {
  const { ports, calls } = fakePorts();
  const result = await runUpgradeCheck({ ...baseInputs, targetSynapseImage: `ghcr.io/element-hq/synapse:v1.161.0@${baseInputs.currentSynapseImageDigest}` }, ports);
  assert.equal(result.ready, true);
  assert.equal(result.reason, 'no-op-same-image');
  assert.deepEqual(result.safeSequence, []);
  assert.deepEqual(calls, []);
});

test('refuses a copy namespace outside the explicit allowlist before any mutation', async () => {
  const { ports, calls } = fakePorts();
  await assert.rejects(
    runUpgradeCheck({ ...baseInputs, allowedCopyNamespaces: ['some-other-namespace'] }, ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'copy-namespace-not-allowlisted',
  );
  assert.deepEqual(calls, []);
});

test('refuses a copy namespace equal to the source namespace before any mutation', async () => {
  const { ports, calls } = fakePorts();
  await assert.rejects(
    runUpgradeCheck({ ...baseInputs, copyStateNamespace: baseInputs.sourceStateNamespace, allowedCopyNamespaces: [baseInputs.sourceStateNamespace] }, ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'source-volume-reuse-refused',
  );
  assert.deepEqual(calls, []);
});

test('refuses a copy namespace whose docker volumes already exist, before any mutation', async () => {
  const { ports, calls } = fakePorts({
    targetVolumesExist: async () => {
      calls.push('targetVolumesExist');
      return true;
    },
  });
  await assert.rejects(
    runUpgradeCheck(baseInputs, ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'copy-target-volumes-not-fresh',
  );
  assert.deepEqual(calls, ['targetVolumesExist']);
});

test('failed egress isolation aborts before the database copy or target image boots', async () => {
  const { ports, calls } = fakePorts({ probeEgressDenied: async () => {
    calls.push('probeEgressDenied');
    return false;
  } });
  await assert.rejects(
    runUpgradeCheck(baseInputs, ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'egress-isolation-failed',
  );
  assert.deepEqual(calls, ['targetVolumesExist', 'denyEgress', 'probeEgressDenied']);
});

test('a version change without backward-migration support is never called a rollback, and the safe sequence includes restoring the pre-upgrade backup', async () => {
  const { ports, calls } = fakePorts();
  const result = await runUpgradeCheck(baseInputs, ports);
  assert.equal(result.ready, true);
  assert.equal(result.reason, 'migration-verified');
  assert.equal(result.isRollback, false);
  assert.equal(result.supportsBackwardMigration, false);
  assert.deepEqual(result.safeSequence, ['restore-database-copy', 'boot-target-image', 'health-check', 'restore-pre-upgrade-backup']);
  assert.deepEqual(calls, ['targetVolumesExist', 'denyEgress', 'probeEgressDenied', 'restoreDatabaseCopy', 'bootTargetImage', 'checkHealth', 'supportsBackwardMigration']);
});

test('a version change with proven backward-migration support omits the restore step from the safe sequence', async () => {
  const { ports } = fakePorts({ supportsBackwardMigration: async () => true });
  const result = await runUpgradeCheck(baseInputs, ports);
  assert.deepEqual(result.safeSequence, ['restore-database-copy', 'boot-target-image', 'health-check']);
  assert.equal(result.supportsBackwardMigration, true);
});

test('a failed health check after migration reports failure rather than a passing upgrade', async () => {
  const { ports } = fakePorts({ checkHealth: async () => false });
  const result = await runUpgradeCheck(baseInputs, ports);
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'health-check-failed');
});

test('records exact source and target versions', async () => {
  const { ports } = fakePorts();
  const result = await runUpgradeCheck(baseInputs, ports);
  assert.equal(result.currentSynapseImageDigest, baseInputs.currentSynapseImageDigest);
  assert.equal(result.targetSynapseImage, baseInputs.targetSynapseImage);
  assert.equal(result.checkedAt, '2026-09-17T00:00:00.000Z');
});

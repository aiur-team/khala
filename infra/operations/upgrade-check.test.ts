import assert from 'node:assert/strict';
import test from 'node:test';
import { isNoOpUpgrade, runUpgradeCheck } from './upgrade-check.ts';
import type { UpgradeCheckInputs, UpgradeCheckPorts } from './upgrade-check.ts';

const baseInputs: UpgradeCheckInputs = {
  currentSynapseImageDigest: `sha256:${'a'.repeat(64)}`,
  targetSynapseImage: `ghcr.io/element-hq/synapse:v1.162.0@sha256:${'b'.repeat(64)}`,
  databaseDumpPath: '/artifacts/database.dump',
  copyStateNamespace: 'khala-upgrade-copy',
  checkOrigin: 'https://matrix.upgrade-copy.test',
};

function fakePorts(overrides: Partial<UpgradeCheckPorts> = {}): { ports: UpgradeCheckPorts; calls: string[] } {
  const calls: string[] = [];
  const ports: UpgradeCheckPorts = {
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

test('a no-op upgrade check never restores or boots anything', async () => {
  const { ports, calls } = fakePorts();
  const result = await runUpgradeCheck({ ...baseInputs, targetSynapseImage: `ghcr.io/element-hq/synapse:v1.161.0@${baseInputs.currentSynapseImageDigest}` }, ports);
  assert.equal(result.ready, true);
  assert.equal(result.reason, 'no-op-same-image');
  assert.deepEqual(result.safeSequence, []);
  assert.deepEqual(calls, []);
});

test('a version change without backward-migration support is never called a rollback, and the safe sequence includes restoring the pre-upgrade backup', async () => {
  const { ports, calls } = fakePorts();
  const result = await runUpgradeCheck(baseInputs, ports);
  assert.equal(result.ready, true);
  assert.equal(result.reason, 'migration-verified');
  assert.equal(result.isRollback, false);
  assert.equal(result.supportsBackwardMigration, false);
  assert.deepEqual(result.safeSequence, ['restore-database-copy', 'boot-target-image', 'health-check', 'restore-pre-upgrade-backup']);
  assert.deepEqual(calls, ['restoreDatabaseCopy', 'bootTargetImage', 'checkHealth', 'supportsBackwardMigration']);
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

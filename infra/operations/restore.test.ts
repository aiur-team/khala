import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationsError, validateManifest } from './backup.ts';
import type { RecoveryManifest } from './backup.ts';
import { runRestore } from './restore.ts';
import type { ExpectedFixture, RestorePorts, RestoreTarget } from './restore.ts';

const validManifest = (overrides: Partial<RecoveryManifest> = {}): RecoveryManifest => ({
  schema_version: 1,
  environment: 'preview',
  created_at: '2026-09-16T00:00:00.000Z',
  database_version: 'PostgreSQL 16.4',
  synapse_image_digest: `sha256:${'a'.repeat(64)}`,
  artifacts: [
    { kind: 'database', sha256: 'b'.repeat(64), path: 'database.dump' },
    { kind: 'signing-key', reference: 'signing-key.tar.gz' },
    { kind: 'config', reference: 'config.tar.gz' },
    { kind: 'media', sha256: 'c'.repeat(64), path: 'media.tar.gz' },
  ],
  restore_proof: 'not-run',
  ...overrides,
});

test('validateManifest requires every artifact, hash and version field', () => {
  assert.deepEqual(validateManifest(validManifest()), validManifest());

  const cases: Array<[Partial<RecoveryManifest>, string]> = [
    [{ database_version: '' }, 'missing-database-version'],
    [{ synapse_image_digest: 'not-a-digest' }, 'missing-synapse-digest'],
    [{ schema_version: 2 as 1 }, 'invalid-manifest-schema-version'],
    [{ environment: 'staging' as 'preview' }, 'invalid-manifest-environment'],
    [{ created_at: 'not-a-date' }, 'invalid-manifest-timestamp'],
  ];
  for (const [overrides, code] of cases) {
    assert.throws(() => validateManifest(validManifest(overrides)), (error: unknown) => error instanceof OperationsError && error.code === code);
  }
});

test('validateManifest rejects a manifest missing a required artifact kind', () => {
  const manifest = validManifest({ artifacts: validManifest().artifacts.filter((artifact) => artifact.kind !== 'signing-key') });
  assert.throws(() => validateManifest(manifest), (error: unknown) => error instanceof OperationsError && error.code === 'missing-artifact:signing-key');
});

test('validateManifest rejects a content artifact missing its hash and a secret artifact missing its reference', () => {
  const missingHash = validManifest({
    artifacts: validManifest().artifacts.map((artifact) => (artifact.kind === 'database' ? { kind: 'database', path: 'database.dump' } : artifact)),
  });
  assert.throws(() => validateManifest(missingHash), (error: unknown) => error instanceof OperationsError && error.code === 'missing-artifact-hash:database');

  const missingReference = validManifest({
    artifacts: validManifest().artifacts.map((artifact) => (artifact.kind === 'signing-key' ? { kind: 'signing-key' } : artifact)),
  });
  assert.throws(() => validateManifest(missingReference), (error: unknown) => error instanceof OperationsError && error.code === 'missing-artifact-reference:signing-key');
});

test('a valid manifest never carries decryption keys or database credentials, only opaque references and hashes', () => {
  const manifest = validateManifest(validManifest());
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /password/i);
  assert.doesNotMatch(serialized, /-----BEGIN/);
  for (const artifact of manifest.artifacts) {
    if (artifact.kind === 'signing-key' || artifact.kind === 'config') {
      assert.equal(artifact.sha256, undefined);
      assert.match(artifact.reference!, /^[a-z0-9.-]+$/);
    }
  }
});

interface Call {
  name: string;
}

function fakePorts(overrides: Partial<RestorePorts> = {}): { ports: RestorePorts; calls: Call[] } {
  const calls: Call[] = [];
  const ports: RestorePorts = {
    verifyArtifactChecksum: async () => {
      calls.push({ name: 'verifyArtifactChecksum' });
      return true;
    },
    denyEgress: async () => {
      calls.push({ name: 'denyEgress' });
    },
    probeEgressDenied: async () => {
      calls.push({ name: 'probeEgressDenied' });
      return true;
    },
    restoreDatabase: async () => {
      calls.push({ name: 'restoreDatabase' });
    },
    restoreMedia: async () => {
      calls.push({ name: 'restoreMedia' });
    },
    restoreIdentity: async () => {
      calls.push({ name: 'restoreIdentity' });
    },
    verifyRestoredData: async (_target, expectations: ExpectedFixture) => {
      calls.push({ name: 'verifyRestoredData' });
      return { matchedEventIds: expectations.eventIds, missingEventIds: [] };
    },
    now: (() => {
      let tick = 0;
      return () => {
        tick += 1;
        return new Date(Date.parse('2026-09-17T00:00:00.000Z') + tick * 1000);
      };
    })(),
    ...overrides,
  };
  return { ports, calls };
}

const isolatedTarget: RestoreTarget = { stateNamespace: 'khala-rehearsal-7', environment: 'preview', usesFreshVolumes: true };
const expectations: ExpectedFixture = { eventIds: ['$synthetic-event-1', '$synthetic-event-2'], syntheticUserId: '@khala_boundary_synthetic:matrix.rehearsal.test' };

function baseInputs(overrides: Record<string, unknown> = {}) {
  return {
    manifest: validManifest(),
    sourceStateNamespace: 'khala-preview',
    artifactDir: '/artifacts',
    secretsDir: '/secrets',
    target: isolatedTarget,
    allowedTargetIds: ['khala-rehearsal-7'],
    expectations,
    ...overrides,
  };
}

test('refuses a target outside the explicit allowlist before any mutation', async () => {
  const { ports, calls } = fakePorts();
  await assert.rejects(
    runRestore(baseInputs({ allowedTargetIds: ['some-other-namespace'] }), ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'target-not-allowlisted',
  );
  assert.deepEqual(calls, []);
});

test('refuses a production restore target before any mutation', async () => {
  const { ports, calls } = fakePorts();
  await assert.rejects(
    runRestore(baseInputs({ target: { ...isolatedTarget, environment: 'production' as 'preview' } }), ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'restore-target-must-be-isolated',
  );
  assert.deepEqual(calls, []);
});

test('refuses reusing the source volume before any mutation', async () => {
  const { ports, calls } = fakePorts();
  await assert.rejects(
    runRestore(baseInputs({ target: { ...isolatedTarget, usesFreshVolumes: false } }), ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'source-volume-reuse-refused',
  );
  assert.deepEqual(calls, []);

  await assert.rejects(
    runRestore(baseInputs({ target: { ...isolatedTarget, stateNamespace: 'khala-preview' }, allowedTargetIds: ['khala-preview'] }), ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'source-volume-reuse-refused',
  );
  assert.deepEqual(calls, []);
});

test('AE2: a missing signing-key artifact fails validation before any mutation, even though database and media are present', async () => {
  const { ports, calls } = fakePorts();
  const manifest = validManifest({ artifacts: validManifest().artifacts.filter((artifact) => artifact.kind !== 'signing-key') });
  await assert.rejects(
    runRestore(baseInputs({ manifest }), ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'missing-artifact:signing-key',
  );
  assert.deepEqual(calls, []);
});

test('a corrupt artifact fails checksum verification before any restore mutation runs', async () => {
  const { ports, calls } = fakePorts({
    verifyArtifactChecksum: async (path: string) => {
      calls.push({ name: 'verifyArtifactChecksum' });
      return !path.includes('database');
    },
  });
  await assert.rejects(
    runRestore(baseInputs(), ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'artifact-checksum-mismatch:database',
  );
  assert.deepEqual(calls, [{ name: 'verifyArtifactChecksum' }]);
});

test('failed egress isolation aborts before any restore boots', async () => {
  const { ports, calls } = fakePorts({
    probeEgressDenied: async () => {
      calls.push({ name: 'probeEgressDenied' });
      return false;
    },
  });
  await assert.rejects(
    runRestore(baseInputs(), ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'egress-isolation-failed',
  );
  assert.deepEqual(
    calls.map((call) => call.name),
    ['verifyArtifactChecksum', 'verifyArtifactChecksum', 'denyEgress', 'probeEgressDenied'],
  );
});

test('a successful restore records measured recovery time, data-loss window and matched event IDs, identity restoring only after isolation is verified', async () => {
  const { ports, calls } = fakePorts();
  const proof = await runRestore(baseInputs(), ports);

  assert.equal(proof.ready, true);
  assert.equal(proof.reason, 'restore-verified');
  assert.deepEqual(proof.matchedEventIds, expectations.eventIds);
  assert.deepEqual(proof.missingEventIds, []);
  assert.ok(proof.recoveryTimeMs > 0);
  assert.ok(proof.dataLossWindowMs >= 0);
  assert.equal(new Date(proof.restoreCompletedAt) > new Date(proof.restoreStartedAt), true);
  assert.equal(new Date(proof.isolationVerifiedAt) <= new Date(proof.restoreStartedAt), true);

  const order = calls.map((call) => call.name);
  assert.deepEqual(order, [
    'verifyArtifactChecksum',
    'verifyArtifactChecksum',
    'denyEgress',
    'probeEgressDenied',
    'restoreDatabase',
    'restoreMedia',
    'restoreIdentity',
    'verifyRestoredData',
  ]);
  assert.ok(order.indexOf('restoreIdentity') > order.indexOf('probeEgressDenied'));
});

test('reports missing expected events instead of claiming readiness', async () => {
  const { ports } = fakePorts({
    verifyRestoredData: async () => ({ matchedEventIds: ['$synthetic-event-1'], missingEventIds: ['$synthetic-event-2'] }),
  });
  const proof = await runRestore(baseInputs(), ports);
  assert.equal(proof.ready, false);
  assert.equal(proof.reason, 'expected-events-missing');
  assert.deepEqual(proof.missingEventIds, ['$synthetic-event-2']);
});

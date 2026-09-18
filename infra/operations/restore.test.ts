import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OperationsError, validateManifest } from './backup.ts';
import type { RecoveryManifest } from './backup.ts';
import { run, runRestore, verifyArtifactChecksumOnDisk } from './restore.ts';
import type { ExpectedFixture, RestorePorts, RestoreTarget } from './restore.ts';

const validManifest = (overrides: Partial<RecoveryManifest> = {}): RecoveryManifest => ({
  schema_version: 1,
  environment: 'preview',
  created_at: '2026-09-16T00:00:00.000Z',
  database_version: 'PostgreSQL 16.4',
  synapse_image_digest: `sha256:${'a'.repeat(64)}`,
  artifacts: [
    { kind: 'database', sha256: 'b'.repeat(64), path: 'database.dump' },
    { kind: 'signing-key', sha256: 'd'.repeat(64), reference: 'signing-key.tar.gz' },
    { kind: 'config', sha256: 'e'.repeat(64), reference: 'config.tar.gz' },
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
    artifacts: validManifest().artifacts.map((artifact) => (artifact.kind === 'signing-key' ? { kind: 'signing-key', sha256: 'd'.repeat(64) } : artifact)),
  });
  assert.throws(() => validateManifest(missingReference), (error: unknown) => error instanceof OperationsError && error.code === 'missing-artifact-reference:signing-key');
});

test('validateManifest requires a checksum for the signing-key and config artifacts too', () => {
  const missingSigningKeyHash = validManifest({
    artifacts: validManifest().artifacts.map((artifact) => (artifact.kind === 'signing-key' ? { kind: 'signing-key', reference: 'signing-key.tar.gz' } : artifact)),
  });
  assert.throws(
    () => validateManifest(missingSigningKeyHash),
    (error: unknown) => error instanceof OperationsError && error.code === 'missing-artifact-hash:signing-key',
  );
});

test('validateManifest rejects an out-of-format hash and an invalid restore_proof value', () => {
  const badHash = validManifest({
    artifacts: validManifest().artifacts.map((artifact) => (artifact.kind === 'database' ? { ...artifact, sha256: 'not-a-hash' } : artifact)),
  });
  assert.throws(() => validateManifest(badHash), (error: unknown) => error instanceof OperationsError && error.code === 'missing-artifact-hash:database');

  const badRestoreProof = validManifest({ restore_proof: 'maybe' as 'not-run' });
  assert.throws(() => validateManifest(badRestoreProof), (error: unknown) => error instanceof OperationsError && error.code === 'invalid-manifest-restore-proof');
});

test('verifyArtifactChecksumOnDisk (the real port, not a fake) distinguishes a matching file from a corrupt one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'khala-restore-checksum-test-'));
  const filePath = join(dir, 'artifact.bin');
  await writeFile(filePath, 'real-artifact-content');
  const correctHash = createHash('sha256').update('real-artifact-content').digest('hex');

  assert.equal(await verifyArtifactChecksumOnDisk(filePath, correctHash), true);
  assert.equal(await verifyArtifactChecksumOnDisk(filePath, 'f'.repeat(64)), false);
  assert.equal(await verifyArtifactChecksumOnDisk(join(dir, 'missing.bin'), correctHash), false);
});

test('validateManifest rejects an unknown top-level key and an unknown artifact key, per manifest.schema.json', () => {
  const withUnknownTopLevelKey = { ...validManifest(), decryption_key: 'nope' };
  assert.throws(
    () => validateManifest(withUnknownTopLevelKey),
    (error: unknown) => error instanceof OperationsError && error.code === 'invalid-manifest-unknown-key:decryption_key',
  );

  const withUnknownArtifactKey = validManifest({
    artifacts: validManifest().artifacts.map((artifact) => (artifact.kind === 'database' ? { ...artifact, plaintext_preview: 'nope' } : artifact)),
  });
  assert.throws(
    () => validateManifest(withUnknownArtifactKey),
    (error: unknown) => error instanceof OperationsError && error.code === 'invalid-manifest-artifact-unknown-key:plaintext_preview',
  );
});

test('a valid manifest never carries decryption keys or database credentials, only opaque references and hashes', () => {
  const manifest = validateManifest(validManifest());
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /password/i);
  assert.doesNotMatch(serialized, /-----BEGIN/);
  for (const artifact of manifest.artifacts) {
    if (artifact.kind === 'signing-key' || artifact.kind === 'config') {
      assert.match(artifact.sha256!, /^[0-9a-f]{64}$/);
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
    targetVolumesExist: async () => {
      calls.push({ name: 'targetVolumesExist' });
      return false;
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

const isolatedTarget: RestoreTarget = { stateNamespace: 'khala-rehearsal-7', environment: 'preview' };
const expectations: ExpectedFixture = { eventIds: ['$synthetic-event-1', '$synthetic-event-2'], syntheticUserId: '@khala_boundary_synthetic:matrix.rehearsal.test' };

function baseInputs(overrides: Record<string, unknown> = {}) {
  return {
    manifest: validManifest(),
    sourceStateNamespace: 'khala-preview',
    sourceConfigDir: '/private/khala-source-config',
    targetConfigDir: '/private/khala-rehearsal-config',
    artifactDir: '/artifacts',
    secretsDir: '/secrets',
    target: isolatedTarget,
    allowedTargetIds: ['khala-rehearsal-7'],
    expectations,
    ...overrides,
  };
}

test('runRestore itself rejects an invalid manifest before any mutation, not just validateManifest in isolation', async () => {
  const { ports, calls } = fakePorts();
  const invalidManifest = { ...validManifest(), schema_version: 2 as 1 };
  await assert.rejects(
    runRestore(baseInputs({ manifest: invalidManifest }), ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'invalid-manifest-schema-version',
  );
  assert.deepEqual(calls, []);
});

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
    runRestore(baseInputs({ target: { ...isolatedTarget, stateNamespace: 'khala-preview' }, allowedTargetIds: ['khala-preview'] }), ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'source-volume-reuse-refused',
  );
  assert.deepEqual(calls, []);
});

test('refuses a target whose docker volumes already exist, even if the caller believes it is fresh', async () => {
  const { ports, calls } = fakePorts({
    targetVolumesExist: async () => {
      calls.push({ name: 'targetVolumesExist' });
      return true;
    },
  });
  await assert.rejects(
    runRestore(baseInputs(), ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'target-volumes-not-fresh',
  );
  assert.deepEqual(calls, [{ name: 'targetVolumesExist' }]);
});

test('refuses a target config directory that matches the source config directory', async () => {
  const { ports, calls } = fakePorts();
  await assert.rejects(
    runRestore(baseInputs({ targetConfigDir: '/private/khala-source-config' }), ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'target-config-dir-must-differ-from-source',
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
  assert.deepEqual(calls.map((call) => call.name), ['targetVolumesExist', 'verifyArtifactChecksum']);
});

test('a corrupt media artifact fails checksum verification before any restore mutation runs', async () => {
  const { ports, calls } = fakePorts({
    verifyArtifactChecksum: async (path: string) => {
      calls.push({ name: 'verifyArtifactChecksum' });
      return !path.includes('media');
    },
  });
  await assert.rejects(
    runRestore(baseInputs(), ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'artifact-checksum-mismatch:media',
  );
  assert.deepEqual(
    calls.map((call) => call.name),
    ['targetVolumesExist', 'verifyArtifactChecksum', 'verifyArtifactChecksum'],
  );
});

test('a corrupt signing-key or config artifact fails checksum verification before any restore mutation runs', async () => {
  const { ports: signingKeyPorts, calls: signingKeyCalls } = fakePorts({
    verifyArtifactChecksum: async (path: string) => {
      signingKeyCalls.push({ name: 'verifyArtifactChecksum' });
      return !path.includes('signing-key');
    },
  });
  await assert.rejects(
    runRestore(baseInputs(), signingKeyPorts),
    (error: unknown) => error instanceof OperationsError && error.code === 'artifact-checksum-mismatch:signing-key',
  );

  const { ports: configPorts, calls: configCalls } = fakePorts({
    verifyArtifactChecksum: async (path: string) => {
      configCalls.push({ name: 'verifyArtifactChecksum' });
      return !path.includes('config');
    },
  });
  await assert.rejects(
    runRestore(baseInputs(), configPorts),
    (error: unknown) => error instanceof OperationsError && error.code === 'artifact-checksum-mismatch:config',
  );
});

test('rejects a manifest artifact path that escapes the artifact directory', async () => {
  const { ports, calls } = fakePorts();
  const manifest = validManifest({
    artifacts: validManifest().artifacts.map((artifact) => (artifact.kind === 'database' ? { ...artifact, path: '../../etc/passwd' } : artifact)),
  });
  await assert.rejects(
    runRestore(baseInputs({ manifest }), ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'artifact-path-escapes-directory:database',
  );
  assert.deepEqual(calls, [{ name: 'targetVolumesExist' }]);
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
    ['targetVolumesExist', 'verifyArtifactChecksum', 'verifyArtifactChecksum', 'verifyArtifactChecksum', 'verifyArtifactChecksum', 'denyEgress', 'probeEgressDenied'],
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
    'targetVolumesExist',
    'verifyArtifactChecksum',
    'verifyArtifactChecksum',
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

test('restores exactly the checksum-verified path for each artifact, never a differently named file', async () => {
  // Fixture paths deliberately differ from the names backup.ts happens to
  // write (database.dump, media.tar.gz, ...): a restore step that hardcoded
  // those defaults instead of using the manifest-declared, checksum-verified
  // path would still pass if the fixture reused them by coincidence.
  const manifest = validManifest({
    artifacts: [
      { kind: 'database', sha256: 'b'.repeat(64), path: 'db-artifact-9f2.bin' },
      { kind: 'signing-key', sha256: 'd'.repeat(64), reference: 'signing-key-artifact-9f2.bin' },
      { kind: 'config', sha256: 'e'.repeat(64), reference: 'config-artifact-9f2.bin' },
      { kind: 'media', sha256: 'c'.repeat(64), path: 'media-artifact-9f2.bin' },
    ],
  });
  const restoredPaths: Record<string, string> = {};
  const { ports } = fakePorts({
    restoreDatabase: async (databaseDumpPath: string) => {
      restoredPaths.database = databaseDumpPath;
    },
    restoreMedia: async (mediaArchivePath: string) => {
      restoredPaths.media = mediaArchivePath;
    },
    restoreIdentity: async (signingKeyArchivePath: string, configArchivePath: string) => {
      restoredPaths.signingKey = signingKeyArchivePath;
      restoredPaths.config = configArchivePath;
    },
  });
  await runRestore(baseInputs({ manifest }), ports);
  assert.equal(restoredPaths.database, '/artifacts/db-artifact-9f2.bin');
  assert.equal(restoredPaths.media, '/artifacts/media-artifact-9f2.bin');
  assert.equal(restoredPaths.signingKey, '/secrets/signing-key-artifact-9f2.bin');
  assert.equal(restoredPaths.config, '/secrets/config-artifact-9f2.bin');
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

test('the CLI refuses a manifest whose recorded environment does not match the requested --environment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'khala-restore-cli-test-'));
  const manifestPath = join(dir, 'backup-manifest.json');
  await writeFile(manifestPath, JSON.stringify(validManifest({ environment: 'preview' })));

  await assert.rejects(
    run(['--manifest', manifestPath, '--environment', 'production', '--validate-only']),
    (error: unknown) => error instanceof OperationsError && error.code === 'environment-mismatch',
  );
});

test('the CLI validates a manifest whose environment matches --environment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'khala-restore-cli-test-'));
  const manifestPath = join(dir, 'backup-manifest.json');
  await writeFile(manifestPath, JSON.stringify(validManifest({ environment: 'preview' })));

  const result = await run(['--manifest', manifestPath, '--environment', 'preview', '--validate-only']);
  assert.equal(result.ok, true);
  assert.equal(result.validated, true);
});

test('the CLI requires an explicit --manifest argument', async () => {
  await assert.rejects(
    run(['--validate-only']),
    (error: unknown) => error instanceof OperationsError && error.code === 'missing-manifest-argument',
  );
});

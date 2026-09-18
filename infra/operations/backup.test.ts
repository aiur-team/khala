import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OperationsError, runBackup, validateBackupInputs } from './backup.ts';
import type { BackupInputs, BackupPorts } from './backup.ts';

async function tempDirs(): Promise<{ outputDir: string; secretsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'khala-backup-test-'));
  return { outputDir: join(root, 'output'), secretsDir: join(root, 'secrets') };
}

function baseInputs(overrides: Partial<BackupInputs> = {}): BackupInputs {
  return {
    environment: 'preview',
    stateNamespace: 'khala-source-preview',
    dbHost: 'postgres',
    dbPort: 5432,
    dbName: 'synapse',
    dbUser: 'synapse',
    dbPassword: 'synthetic-password',
    configDir: '/config',
    outputDir: '/unused',
    secretsDir: '/unused',
    ...overrides,
  };
}

interface Call {
  name: string;
}

function fakePorts(overrides: Partial<BackupPorts> = {}): { ports: BackupPorts; calls: Call[] } {
  const calls: Call[] = [];
  const ports: BackupPorts = {
    inspectDatabaseVersion: async () => {
      calls.push({ name: 'inspectDatabaseVersion' });
      return 'PostgreSQL 16.4';
    },
    inspectSynapseImageDigest: async () => {
      calls.push({ name: 'inspectSynapseImageDigest' });
      return `sha256:${'a'.repeat(64)}`;
    },
    quiesceWrites: async () => {
      calls.push({ name: 'quiesceWrites' });
    },
    resumeWrites: async () => {
      calls.push({ name: 'resumeWrites' });
    },
    dumpDatabase: async (_inputs, targetPath) => {
      calls.push({ name: 'dumpDatabase' });
      await writeFile(targetPath, 'synthetic-database-dump');
    },
    archiveMedia: async (_inputs, targetPath) => {
      calls.push({ name: 'archiveMedia' });
      await writeFile(targetPath, 'synthetic-media-archive');
    },
    archiveSigningKey: async (_inputs, targetPath) => {
      calls.push({ name: 'archiveSigningKey' });
      await writeFile(targetPath, 'synthetic-signing-key-archive');
    },
    archiveConfig: async (_inputs, targetPath) => {
      calls.push({ name: 'archiveConfig' });
      await writeFile(targetPath, 'synthetic-config-archive');
    },
    now: () => new Date('2026-09-17T00:00:00.000Z'),
    ...overrides,
  };
  return { ports, calls };
}

test('a successful backup quiesces writes before dumping the database and media, and always resumes them', async () => {
  const { outputDir, secretsDir } = await tempDirs();
  const { ports, calls } = fakePorts();
  const result = await runBackup(baseInputs({ outputDir, secretsDir }), ports);

  const order = calls.map((call) => call.name);
  assert.deepEqual(order, [
    'inspectDatabaseVersion',
    'inspectSynapseImageDigest',
    'quiesceWrites',
    'dumpDatabase',
    'archiveMedia',
    'resumeWrites',
    'archiveSigningKey',
    'archiveConfig',
  ]);

  assert.equal(result.manifest.artifacts.length, 4);
  for (const artifact of result.manifest.artifacts) {
    assert.match(artifact.sha256!, /^[0-9a-f]{64}$/);
  }
  assert.equal(result.manifest.restore_proof, 'not-run');
});

test('writes matter to the manifest are the actual hashes of the archived artifacts, not placeholders', async () => {
  const { outputDir, secretsDir } = await tempDirs();
  const { ports } = fakePorts();
  const { manifestPath, manifest } = await runBackup(baseInputs({ outputDir, secretsDir }), ports);

  const onDisk = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(onDisk, manifest);

  const databaseArtifact = manifest.artifacts.find((artifact) => artifact.kind === 'database')!;
  const databaseOnDisk = await readFile(join(outputDir, 'database.dump'), 'utf8');
  assert.equal(databaseOnDisk, 'synthetic-database-dump');
  // A mutated database file must not match the recorded hash: proves the
  // hash is computed from real content, not a constant.
  const { createHash } = await import('node:crypto');
  assert.equal(databaseArtifact.sha256, createHash('sha256').update(databaseOnDisk).digest('hex'));

  // Signing-key and config are the secrets restore.ts checksums before
  // restoring identity (AE2); their hashes must be real too, not just the
  // database/media hashes a narrower test could pass with.
  const signingKeyArtifact = manifest.artifacts.find((artifact) => artifact.kind === 'signing-key')!;
  const signingKeyOnDisk = await readFile(join(secretsDir, 'signing-key.tar.gz'), 'utf8');
  assert.equal(signingKeyArtifact.sha256, createHash('sha256').update(signingKeyOnDisk).digest('hex'));

  const configArtifact = manifest.artifacts.find((artifact) => artifact.kind === 'config')!;
  const configOnDisk = await readFile(join(secretsDir, 'config.tar.gz'), 'utf8');
  assert.equal(configArtifact.sha256, createHash('sha256').update(configOnDisk).digest('hex'));
});

test('resumeWrites still runs when the dump fails, and no manifest is written for a partial backup', async () => {
  const { outputDir, secretsDir } = await tempDirs();
  const { ports, calls } = fakePorts({
    dumpDatabase: async () => {
      calls.push({ name: 'dumpDatabase' });
      throw new OperationsError('subprocess-failed', 'pg_dump exited 1');
    },
  });
  await assert.rejects(
    runBackup(baseInputs({ outputDir, secretsDir }), ports),
    (error: unknown) => error instanceof OperationsError && error.code === 'subprocess-failed',
  );
  assert.deepEqual(calls.map((call) => call.name), ['inspectDatabaseVersion', 'inspectSynapseImageDigest', 'quiesceWrites', 'dumpDatabase', 'resumeWrites']);

  let outputEntries: string[] = [];
  try {
    outputEntries = await readdir(outputDir);
  } catch {
    outputEntries = [];
  }
  assert.equal(outputEntries.includes('backup-manifest.json'), false);
});

test('a failure after every artifact step but before the manifest write leaves no manifest behind', async () => {
  const { outputDir, secretsDir } = await tempDirs();
  const { ports } = fakePorts({
    archiveConfig: async (_inputs, targetPath) => {
      await writeFile(targetPath, 'synthetic-config-archive');
      throw new OperationsError('subprocess-failed', 'tar exited 1');
    },
  });
  await assert.rejects(runBackup(baseInputs({ outputDir, secretsDir }), ports));
  const outputEntries = await readdir(outputDir).catch((): string[] => []);
  assert.equal(outputEntries.includes('backup-manifest.json'), false);
});

function baseCliEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    KHALA_ENVIRONMENT: 'preview',
    KHALA_STATE_NAMESPACE: 'khala-source-preview',
    KHALA_DB_HOST: 'postgres',
    KHALA_DB_PORT: '5432',
    KHALA_DB_NAME: 'synapse',
    KHALA_DB_USER: 'synapse',
    KHALA_DB_PASSWORD: 'synthetic-password',
    KHALA_CONFIG_DIR: '/config',
    KHALA_BACKUP_OUTPUT_DIR: '/output',
    KHALA_BACKUP_SECRETS_DIR: '/secrets',
    ...overrides,
  };
}

test('the CLI refuses an --environment that does not match KHALA_ENVIRONMENT, matching the other two CLIs', () => {
  assert.throws(
    () => validateBackupInputs(baseCliEnv(), 'production'),
    (error: unknown) => error instanceof OperationsError && error.code === 'environment-mismatch',
  );
});

test('the CLI accepts an --environment that matches KHALA_ENVIRONMENT', () => {
  const inputs = validateBackupInputs(baseCliEnv(), 'preview');
  assert.equal(inputs.environment, 'preview');
});

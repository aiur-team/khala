#!/usr/bin/env node
// Produces one recovery set (database + server signing identity + config +
// media) plus a manifest describing it, per docs/plans/2026-09-16-kha-109-backend-recovery-operations-plan.md.
// Shares the recovery manifest contract and error type with restore.ts and
// upgrade-check.ts.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class OperationsError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = 'OperationsError';
    this.code = code;
  }
}

export type EnvironmentName = 'preview' | 'production';
export type ArtifactKind = 'database' | 'signing-key' | 'config' | 'media';

export interface ArtifactRecord {
  kind: ArtifactKind;
  sha256?: string;
  path?: string;
  reference?: string;
}

export interface RecoveryManifest {
  schema_version: 1;
  environment: EnvironmentName;
  created_at: string;
  database_version: string;
  synapse_image_digest: string;
  artifacts: ArtifactRecord[];
  restore_proof: 'not-run' | 'pass' | 'fail';
}

const requiredArtifactKinds: readonly ArtifactKind[] = ['database', 'signing-key', 'config', 'media'];
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const hashPattern = /^[0-9a-f]{64}$/;

// Validated against infra/operations/manifest.schema.json's structural
// contract in code, matching this package's existing convention (see
// infra/messaging/check.ts) of explicit checks over a schema-library
// dependency the repository does not otherwise carry.
export function validateManifest(candidate: unknown): RecoveryManifest {
  if (typeof candidate !== 'object' || candidate === null) throw new OperationsError('invalid-manifest');
  const manifest = candidate as Record<string, unknown>;
  if (manifest.schema_version !== 1) throw new OperationsError('invalid-manifest-schema-version');
  if (manifest.environment !== 'preview' && manifest.environment !== 'production') throw new OperationsError('invalid-manifest-environment');
  if (typeof manifest.created_at !== 'string' || Number.isNaN(Date.parse(manifest.created_at))) throw new OperationsError('invalid-manifest-timestamp');
  if (typeof manifest.database_version !== 'string' || manifest.database_version.length === 0) throw new OperationsError('missing-database-version');
  if (typeof manifest.synapse_image_digest !== 'string' || !digestPattern.test(manifest.synapse_image_digest)) throw new OperationsError('missing-synapse-digest');
  if (!Array.isArray(manifest.artifacts)) throw new OperationsError('missing-artifacts');
  if (manifest.restore_proof !== 'not-run' && manifest.restore_proof !== 'pass' && manifest.restore_proof !== 'fail') {
    throw new OperationsError('invalid-manifest-restore-proof');
  }

  const byKind = new Map<ArtifactKind, ArtifactRecord>();
  for (const entry of manifest.artifacts as unknown[]) {
    if (typeof entry !== 'object' || entry === null) throw new OperationsError('invalid-manifest-artifact');
    const artifact = entry as ArtifactRecord;
    if (!requiredArtifactKinds.includes(artifact.kind)) throw new OperationsError('invalid-manifest-artifact-kind');
    if (artifact.kind === 'database' || artifact.kind === 'media') {
      if (typeof artifact.sha256 !== 'string' || !hashPattern.test(artifact.sha256)) throw new OperationsError(`missing-artifact-hash:${artifact.kind}`);
      if (typeof artifact.path !== 'string' || artifact.path.length === 0) throw new OperationsError(`missing-artifact-path:${artifact.kind}`);
    } else {
      if (typeof artifact.reference !== 'string' || artifact.reference.length === 0) throw new OperationsError(`missing-artifact-reference:${artifact.kind}`);
    }
    byKind.set(artifact.kind, artifact);
  }
  for (const kind of requiredArtifactKinds) {
    if (!byKind.has(kind)) throw new OperationsError(`missing-artifact:${kind}`);
  }
  return manifest as unknown as RecoveryManifest;
}

export function findArtifact(manifest: RecoveryManifest, kind: ArtifactKind): ArtifactRecord {
  const artifact = manifest.artifacts.find((entry) => entry.kind === kind);
  if (!artifact) throw new OperationsError(`missing-artifact:${kind}`);
  return artifact;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise());
  });
  return hash.digest('hex');
}

export interface BackupInputs {
  environment: EnvironmentName;
  stateNamespace: string;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  configDir: string;
  outputDir: string;
  // Kept separate from outputDir: outputDir may be shared/uploaded, secretsDir
  // never should be. Never logged.
  secretsDir: string;
}

export interface BackupPorts {
  inspectDatabaseVersion(inputs: BackupInputs): Promise<string>;
  inspectSynapseImageDigest(inputs: BackupInputs): Promise<string>;
  dumpDatabase(inputs: BackupInputs, targetPath: string): Promise<void>;
  archiveMedia(inputs: BackupInputs, targetPath: string): Promise<void>;
  archiveSigningKey(inputs: BackupInputs, targetPath: string): Promise<void>;
  archiveConfig(inputs: BackupInputs, targetPath: string): Promise<void>;
  now(): Date;
}

export interface BackupResult {
  manifestPath: string;
  manifest: RecoveryManifest;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new OperationsError('missing-input', `Missing ${key}`);
  return value;
}

export function validateBackupInputs(env: NodeJS.ProcessEnv, expectedEnvironment?: string): BackupInputs {
  const environment = required(env, 'KHALA_ENVIRONMENT');
  if (environment !== 'preview' && environment !== 'production') throw new OperationsError('invalid-environment');
  if (expectedEnvironment && environment !== expectedEnvironment) throw new OperationsError('environment-mismatch');

  const dbPortText = required(env, 'KHALA_DB_PORT');
  const dbPort = Number(dbPortText);
  if (!Number.isInteger(dbPort) || dbPort < 1 || dbPort > 65535) throw new OperationsError('invalid-database-port');

  const outputDir = required(env, 'KHALA_BACKUP_OUTPUT_DIR');
  if (!isAbsolute(outputDir)) throw new OperationsError('invalid-output-directory');
  const secretsDir = required(env, 'KHALA_BACKUP_SECRETS_DIR');
  if (!isAbsolute(secretsDir)) throw new OperationsError('invalid-secrets-directory');
  const configDir = required(env, 'KHALA_CONFIG_DIR');
  if (!isAbsolute(configDir)) throw new OperationsError('invalid-config-directory');

  return {
    environment,
    stateNamespace: required(env, 'KHALA_STATE_NAMESPACE'),
    dbHost: required(env, 'KHALA_DB_HOST'),
    dbPort,
    dbName: required(env, 'KHALA_DB_NAME'),
    dbUser: required(env, 'KHALA_DB_USER'),
    dbPassword: required(env, 'KHALA_DB_PASSWORD'),
    configDir,
    outputDir,
    secretsDir,
  };
}

// A backup job that fails partway must never leave behind a manifest that
// claims completion: every artifact step runs before the manifest is built,
// and the manifest file itself lands via write-then-atomic-rename.
export async function runBackup(inputs: BackupInputs, ports: BackupPorts): Promise<BackupResult> {
  await mkdir(inputs.outputDir, { recursive: true, mode: 0o700 });
  await chmod(inputs.outputDir, 0o700);
  await mkdir(inputs.secretsDir, { recursive: true, mode: 0o700 });
  await chmod(inputs.secretsDir, 0o700);

  const databasePath = resolve(inputs.outputDir, 'database.dump');
  const mediaPath = resolve(inputs.outputDir, 'media.tar.gz');
  const signingKeyPath = resolve(inputs.secretsDir, 'signing-key.tar.gz');
  const configPath = resolve(inputs.secretsDir, 'config.tar.gz');

  const databaseVersion = await ports.inspectDatabaseVersion(inputs);
  const synapseImageDigest = await ports.inspectSynapseImageDigest(inputs);
  await ports.dumpDatabase(inputs, databasePath);
  await ports.archiveMedia(inputs, mediaPath);
  await ports.archiveSigningKey(inputs, signingKeyPath);
  await ports.archiveConfig(inputs, configPath);

  const databaseHash = await sha256File(databasePath);
  const mediaHash = await sha256File(mediaPath);

  const manifest: RecoveryManifest = {
    schema_version: 1,
    environment: inputs.environment,
    created_at: ports.now().toISOString(),
    database_version: databaseVersion,
    synapse_image_digest: synapseImageDigest,
    artifacts: [
      { kind: 'database', sha256: databaseHash, path: 'database.dump' },
      { kind: 'signing-key', reference: 'signing-key.tar.gz' },
      { kind: 'config', reference: 'config.tar.gz' },
      { kind: 'media', sha256: mediaHash, path: 'media.tar.gz' },
    ],
    restore_proof: 'not-run',
  };
  validateManifest(manifest);

  const manifestPath = resolve(inputs.outputDir, 'backup-manifest.json');
  const temporary = resolve(inputs.outputDir, `.backup-manifest.json.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, manifestPath);
  await chmod(manifestPath, 0o600);
  return { manifestPath, manifest };
}

export function runProcess(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; stdoutPath?: string } = {}): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env: options.env ?? process.env, stdio: ['ignore', options.stdoutPath ? 'pipe' : 'ignore', 'pipe'] });
    let stderr = '';
    if (options.stdoutPath) {
      const out = createWriteStream(options.stdoutPath, { mode: 0o600 });
      child.stdout?.pipe(out);
    }
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => reject(new OperationsError('subprocess-unavailable', `${command}: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new OperationsError('subprocess-failed', `${command} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

// Captures stdout for short-lived introspection commands (docker inspect,
// psql -tAc, ...). Not used for backup-content streams: those go straight to
// disk via runProcess's stdoutPath so multi-gigabyte dumps never sit in
// process memory.
export function captureProcess(command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, { env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => reject(new OperationsError('subprocess-unavailable', `${command}: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new OperationsError('subprocess-failed', `${command} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

const messagingComposeFile = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'messaging', 'compose.yaml');

export const dockerComposePorts: BackupPorts = {
  async inspectDatabaseVersion(inputs) {
    const output = await captureProcess('docker', ['compose', '-p', inputs.stateNamespace, '-f', messagingComposeFile, 'exec', '-T', 'postgres', 'psql', '-U', inputs.dbUser, '-d', inputs.dbName, '-tAc', 'show server_version']);
    const version = output.trim();
    if (!version) throw new OperationsError('database-version-unavailable');
    return `PostgreSQL ${version}`;
  },
  async inspectSynapseImageDigest(inputs) {
    const output = await captureProcess('docker', ['compose', '-p', inputs.stateNamespace, '-f', messagingComposeFile, 'images', '--format', 'json', 'synapse']);
    const images = JSON.parse(output.trim()) as Array<{ ID: string }>;
    if (images.length === 0 || !images[0]) throw new OperationsError('synapse-digest-unavailable');
    if (!digestPattern.test(images[0].ID)) throw new OperationsError('synapse-digest-unavailable');
    return images[0].ID;
  },
  async dumpDatabase(inputs, targetPath) {
    await runProcess('docker', [
      'compose', '-p', inputs.stateNamespace, '-f', messagingComposeFile, 'exec', '-T', 'postgres',
      'pg_dump', '--format=custom', '--no-owner', '--no-privileges', '-U', inputs.dbUser, '-d', inputs.dbName,
    ], { stdoutPath: targetPath });
  },
  async archiveMedia(inputs, targetPath) {
    await runProcess('docker', [
      'compose', '-p', inputs.stateNamespace, '-f', messagingComposeFile, 'exec', '-T', 'synapse',
      'tar', 'czf', '-', '-C', '/data', 'media_store',
    ], { stdoutPath: targetPath });
  },
  async archiveSigningKey(inputs, targetPath) {
    await runProcess('docker', [
      'compose', '-p', inputs.stateNamespace, '-f', messagingComposeFile, 'exec', '-T', 'synapse',
      'tar', 'czf', '-', '-C', '/data', 'server.signing.key',
    ], { stdoutPath: targetPath });
  },
  async archiveConfig(inputs, targetPath) {
    await runProcess('tar', ['czf', targetPath, '-C', inputs.configDir, 'homeserver.yaml']);
    await chmod(targetPath, 0o600);
  },
  now: () => new Date(),
};

async function run(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2)): Promise<BackupResult> {
  const environmentArgument = argv.includes('--environment') ? argv[argv.indexOf('--environment') + 1] : undefined;
  const inputs = validateBackupInputs(env, environmentArgument);
  return runBackup(inputs, dockerComposePorts);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
    .then((result) => console.log(JSON.stringify({ manifest_path: result.manifestPath, artifacts: result.manifest.artifacts.map((artifact) => artifact.kind) })))
    .catch((error) => {
      const reason = error instanceof OperationsError ? error.code : 'unexpected-error';
      console.error(JSON.stringify({ ok: false, reason }));
      process.exitCode = 1;
    });
}

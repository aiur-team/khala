#!/usr/bin/env node
// Rehearses restoration of a recovery manifest into an isolated, disposable
// target. Never restores toward production or a live-facing target; see
// docs/plans/2026-09-16-kha-109-backend-recovery-operations-plan.md's
// "Mechanical restore isolation" section for the ordering this enforces.

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OperationsError,
  captureProcess,
  findArtifact,
  runProcess,
  sha256File,
  validateManifest,
} from './backup.ts';
// Node's runtime type stripping does not infer which imports are types, so
// interface-only imports must use `import type` or the plain import above
// fails at runtime looking for a nonexistent named export.
import type { ArtifactRecord, RecoveryManifest } from './backup.ts';

export interface RestoreTarget {
  stateNamespace: string;
  environment: 'preview';
}

export interface ExpectedFixture {
  eventIds: string[];
  syntheticUserId: string;
}

export interface RestoreProof {
  ready: boolean;
  reason: string;
  matchedEventIds: string[];
  missingEventIds: string[];
  isolationVerifiedAt: string;
  restoreStartedAt: string;
  restoreCompletedAt: string;
  recoveryTimeMs: number;
  dataLossWindowMs: number;
}

export interface RestorePorts {
  verifyArtifactChecksum(artifactPath: string, expectedSha256: string): Promise<boolean>;
  // Real inspection of the target's own docker state, not a caller-supplied
  // claim: a target that already has volumes is refused even if the caller
  // believes (or asserts) they are fresh.
  targetVolumesExist(target: RestoreTarget): Promise<boolean>;
  denyEgress(target: RestoreTarget): Promise<void>;
  probeEgressDenied(target: RestoreTarget): Promise<boolean>;
  restoreDatabase(databaseDumpPath: string, target: RestoreTarget): Promise<void>;
  restoreMedia(mediaArchivePath: string, target: RestoreTarget): Promise<void>;
  restoreIdentity(signingKeyArchivePath: string, configArchivePath: string, targetConfigDir: string, target: RestoreTarget): Promise<void>;
  verifyRestoredData(target: RestoreTarget, expectations: ExpectedFixture): Promise<{ matchedEventIds: string[]; missingEventIds: string[] }>;
  now(): Date;
}

export interface RestoreInputs {
  manifest: RecoveryManifest;
  sourceStateNamespace: string;
  // The production/source config directory the backup's config artifact was
  // captured from. targetConfigDir must never equal this: restoring config
  // into the live source directory would overwrite it in place.
  sourceConfigDir: string;
  targetConfigDir: string;
  artifactDir: string;
  secretsDir: string;
  target: RestoreTarget;
  allowedTargetIds: string[];
  expectations: ExpectedFixture;
}

function requireArtifactLocator(artifact: ArtifactRecord): { path: string; sha256: string } {
  if (!artifact.path || !artifact.sha256) throw new OperationsError(`missing-artifact-hash:${artifact.kind}`);
  return { path: artifact.path, sha256: artifact.sha256 };
}

function requireArtifactReference(artifact: ArtifactRecord): { reference: string; sha256: string } {
  if (!artifact.reference || !artifact.sha256) throw new OperationsError(`missing-artifact-hash:${artifact.kind}`);
  return { reference: artifact.reference, sha256: artifact.sha256 };
}

// Resolves a manifest-declared relative path against its owning directory and
// refuses any result that would escape it (a `../`-laden path, or an absolute
// path smuggled into the manifest), so a verified checksum can never be
// silently swapped for a file outside the artifact/secrets directory.
function resolveWithinDirectory(baseDir: string, relativePath: string, artifactKind: string): string {
  if (isAbsolute(relativePath)) throw new OperationsError(`artifact-path-escapes-directory:${artifactKind}`);
  const resolved = resolve(baseDir, relativePath);
  const relativeToBase = relative(baseDir, resolved);
  if (relativeToBase === '' || relativeToBase.startsWith('..') || isAbsolute(relativeToBase)) {
    throw new OperationsError(`artifact-path-escapes-directory:${artifactKind}`);
  }
  return resolved;
}

// Every check in this function must run, and must be able to refuse, before
// any restore mutation happens: a wrong target or a corrupt artifact is
// refused here, never discovered mid-restore.
export async function runRestore(inputs: RestoreInputs, ports: RestorePorts): Promise<RestoreProof> {
  validateManifest(inputs.manifest);

  if (inputs.target.environment !== 'preview') throw new OperationsError('restore-target-must-be-isolated');
  if (!inputs.allowedTargetIds.includes(inputs.target.stateNamespace)) throw new OperationsError('target-not-allowlisted');
  if (inputs.target.stateNamespace === inputs.sourceStateNamespace) {
    throw new OperationsError('source-volume-reuse-refused');
  }
  if (resolve(inputs.targetConfigDir) === resolve(inputs.sourceConfigDir)) {
    throw new OperationsError('target-config-dir-must-differ-from-source');
  }
  if (await ports.targetVolumesExist(inputs.target)) {
    throw new OperationsError('target-volumes-not-fresh');
  }

  const databaseArtifact = requireArtifactLocator(findArtifact(inputs.manifest, 'database'));
  const mediaArtifact = requireArtifactLocator(findArtifact(inputs.manifest, 'media'));
  // AE2: a missing signing-key artifact must fail validation even though the
  // database and media artifacts restore cleanly.
  const signingKeyArtifact = requireArtifactReference(findArtifact(inputs.manifest, 'signing-key'));
  const configArtifact = requireArtifactReference(findArtifact(inputs.manifest, 'config'));

  const databasePath = resolveWithinDirectory(inputs.artifactDir, databaseArtifact.path, 'database');
  const mediaPath = resolveWithinDirectory(inputs.artifactDir, mediaArtifact.path, 'media');
  const signingKeyPath = resolveWithinDirectory(inputs.secretsDir, signingKeyArtifact.reference, 'signing-key');
  const configPath = resolveWithinDirectory(inputs.secretsDir, configArtifact.reference, 'config');

  if (!(await ports.verifyArtifactChecksum(databasePath, databaseArtifact.sha256))) {
    throw new OperationsError('artifact-checksum-mismatch:database');
  }
  if (!(await ports.verifyArtifactChecksum(mediaPath, mediaArtifact.sha256))) {
    throw new OperationsError('artifact-checksum-mismatch:media');
  }
  if (!(await ports.verifyArtifactChecksum(signingKeyPath, signingKeyArtifact.sha256))) {
    throw new OperationsError('artifact-checksum-mismatch:signing-key');
  }
  if (!(await ports.verifyArtifactChecksum(configPath, configArtifact.sha256))) {
    throw new OperationsError('artifact-checksum-mismatch:config');
  }

  await ports.denyEgress(inputs.target);
  const isolationVerifiedAt = ports.now();
  if (!(await ports.probeEgressDenied(inputs.target))) {
    throw new OperationsError('egress-isolation-failed');
  }

  const restoreStartedAt = ports.now();
  // Each restore step below receives exactly the path that was just
  // checksum-verified above, so a verified file can never be swapped for a
  // different one at restore time.
  await ports.restoreDatabase(databasePath, inputs.target);
  await ports.restoreMedia(mediaPath, inputs.target);
  // The server signing identity boots only after isolation is verified and
  // the boundary data is already in place.
  await ports.restoreIdentity(signingKeyPath, configPath, inputs.targetConfigDir, inputs.target);

  const { matchedEventIds, missingEventIds } = await ports.verifyRestoredData(inputs.target, inputs.expectations);
  const restoreCompletedAt = ports.now();
  const backupCreatedAt = new Date(inputs.manifest.created_at);

  return {
    ready: missingEventIds.length === 0,
    reason: missingEventIds.length === 0 ? 'restore-verified' : 'expected-events-missing',
    matchedEventIds,
    missingEventIds,
    isolationVerifiedAt: isolationVerifiedAt.toISOString(),
    restoreStartedAt: restoreStartedAt.toISOString(),
    restoreCompletedAt: restoreCompletedAt.toISOString(),
    recoveryTimeMs: restoreCompletedAt.getTime() - restoreStartedAt.getTime(),
    dataLossWindowMs: Math.max(0, restoreStartedAt.getTime() - backupCreatedAt.getTime()),
  };
}

export async function verifyArtifactChecksumOnDisk(artifactPath: string, expectedSha256: string): Promise<boolean> {
  try {
    return (await sha256File(artifactPath)) === expectedSha256;
  } catch {
    return false;
  }
}

const operationsDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const messagingComposeFile = resolve(operationsDirectory, '..', 'messaging', 'compose.yaml');
const isolationOverrideFile = resolve(operationsDirectory, 'rehearsal-isolation.override.yaml');

function composeArgs(target: RestoreTarget): string[] {
  return ['compose', '-p', target.stateNamespace, '-f', messagingComposeFile, '-f', isolationOverrideFile];
}

export const dockerComposePorts: RestorePorts = {
  verifyArtifactChecksum: verifyArtifactChecksumOnDisk,
  async targetVolumesExist(target) {
    // Compose labels every volume it creates with the project name
    // (`com.docker.compose.project`); if any already exist for this
    // namespace, the target is not fresh regardless of what the caller
    // believes, and restoring into it would silently mix rehearsal runs.
    const output = await captureProcess('docker', [
      'volume', 'ls', '--filter', `label=com.docker.compose.project=${target.stateNamespace}`, '--format', '{{.Name}}',
    ]);
    return output.trim().length > 0;
  },
  async denyEgress(target) {
    // The override's `internal: true` client-edge network makes isolation a
    // property of the compose project itself; bringing the boundary
    // containers up under it is the "deny" step. synapse-data-init is a
    // one-shot service (exits 0 once done): `--wait` only understands that
    // as success when resolving it as a dependency, not as a direct target,
    // so it is started without `--wait` and only postgres is waited on.
    await runProcess('docker', [...composeArgs(target), 'up', '-d', 'synapse-data-init']);
    await runProcess('docker', [...composeArgs(target), 'up', '-d', '--wait', 'postgres']);
  },
  async probeEgressDenied(target) {
    // python is guaranteed present (the compose healthcheck already relies
    // on it). The probe script itself always exits 0 and reports
    // REACHABLE/UNREACHABLE on stdout, so a genuine OS-level network
    // failure (isolation working) is never conflated with the probe itself
    // being broken (wrong interpreter, crashed container, ...), which would
    // instead surface as a thrown captureProcess error.
    const probeScript = "import urllib.request\ntry:\n    urllib.request.urlopen('https://1.1.1.1', timeout=3)\n    print('REACHABLE')\nexcept OSError:\n    print('UNREACHABLE')\n";
    const output = await captureProcess('docker', [...composeArgs(target), 'run', '--rm', '--no-deps', '--entrypoint', 'python', 'synapse', '-c', probeScript]);
    return output.trim() === 'UNREACHABLE';
  },
  async restoreDatabase(databaseDumpPath, target) {
    await runProcess('docker', [...composeArgs(target), 'exec', '-T', 'postgres', 'pg_restore', '--clean', '--if-exists', '--no-owner', '--no-privileges', '-U', 'synapse', '-d', 'synapse'], { stdinPath: databaseDumpPath });
  },
  async restoreMedia(mediaArchivePath, target) {
    // synapse is not running yet at this point (only postgres and the
    // one-shot volume-owner init are up): use `run` against the same
    // synapse-data volume rather than `exec` against a running service.
    await runProcess('docker', [...composeArgs(target), 'run', '--rm', '--no-deps', '--entrypoint', 'sh', 'synapse', '-c', 'tar xzf - -C /data'], { stdinPath: mediaArchivePath });
  },
  async restoreIdentity(signingKeyArchivePath, configArchivePath, targetConfigDir, target) {
    // The target's own config directory (same contract compose.yaml itself
    // requires) is where the rendered homeserver.yaml bind-mounts from; the
    // caller (runRestore) has already refused a targetConfigDir equal to the
    // source's.
    await runProcess('docker', [...composeArgs(target), 'run', '--rm', '--no-deps', '--entrypoint', 'sh', 'synapse', '-c', 'tar xzf - -C /data'], { stdinPath: signingKeyArchivePath });
    await runProcess('tar', ['xzf', configArchivePath, '-C', targetConfigDir]);
    await runProcess('docker', [...composeArgs(target), 'up', '-d', '--wait', 'synapse']);
  },
  async verifyRestoredData(target, expectations) {
    const matchedEventIds: string[] = [];
    const missingEventIds: string[] = [];
    for (const eventId of expectations.eventIds) {
      const output = await captureProcess('docker', [...composeArgs(target), 'exec', '-T', 'postgres', 'psql', '-U', 'synapse', '-d', 'synapse', '-tAc', `select 1 from events where event_id = '${eventId.replaceAll("'", "''")}'`]);
      (output.trim() === '1' ? matchedEventIds : missingEventIds).push(eventId);
    }
    return { matchedEventIds, missingEventIds };
  },
  now: () => new Date(),
};

function parseArguments(argv: string[]): { validateOnly: boolean; manifestPath?: string; environment?: string } {
  let validateOnly = false;
  let manifestPath: string | undefined;
  let environment: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--validate-only') validateOnly = true;
    else if (argument === '--manifest') manifestPath = argv[++index];
    else if (argument === '--environment') environment = argv[++index];
    else throw new OperationsError('invalid-argument');
  }
  return { validateOnly, manifestPath, environment };
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<{ ok: true; validated: boolean; manifest?: RecoveryManifest }> {
  const args = parseArguments(argv);
  if (!args.manifestPath) throw new OperationsError('missing-manifest-argument');
  const raw = JSON.parse(await readFile(args.manifestPath, 'utf8'));
  const manifest = validateManifest(raw);
  if (args.environment && manifest.environment !== args.environment) throw new OperationsError('environment-mismatch');
  if (args.validateOnly) return { ok: true, validated: true, manifest };
  throw new OperationsError('restore-requires-explicit-target', 'Full restore execution requires target/expectations supplied by the rehearsal runbook, not the bare CLI; see docs/operations/backend.md.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
    .then((result) => console.log(JSON.stringify({ ok: result.ok, validated: result.validated })))
    .catch((error) => {
      const reason = error instanceof OperationsError ? error.code : 'unexpected-error';
      console.error(JSON.stringify({ ok: false, reason }));
      process.exitCode = 1;
    });
}

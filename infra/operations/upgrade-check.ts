#!/usr/bin/env node
// Exercises an upgrade rehearsal: test the target Synapse image's migration
// against a disposable copy of the current database, then record whether a
// same-version image swap can be called a rollback or whether a
// schema-changing downgrade must instead go through restore.ts (R3).

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OperationsError, captureProcess, runProcess } from './backup.ts';

export interface UpgradeCheckInputs {
  currentSynapseImageDigest: string;
  // The full current image reference (including its `vX.Y.Z` tag), separate
  // from currentSynapseImageDigest: the digest alone carries no ordering, so
  // proving a rehearsal is a forward migration (not a downgrade dressed up as
  // one) requires comparing the current and target *versions*.
  currentSynapseImage: string;
  targetSynapseImage: string;
  databaseDumpPath: string;
  sourceStateNamespace: string;
  copyStateNamespace: string;
  allowedCopyNamespaces: string[];
  // Event IDs already present in the source database copy before migration;
  // a health check alone proves the server booted, not that history survived
  // the schema migration.
  expectedEventIds: string[];
}

export interface UpgradeCheckPorts {
  // Real inspection of the copy target's own docker state, not a
  // caller-supplied claim; mirrors restore.ts's targetVolumesExist so the
  // rehearsal copy can never land on a namespace with pre-existing volumes.
  targetVolumesExist(copyStateNamespace: string): Promise<boolean>;
  denyEgress(copyStateNamespace: string): Promise<void>;
  probeEgressDenied(copyStateNamespace: string): Promise<boolean>;
  restoreDatabaseCopy(inputs: UpgradeCheckInputs): Promise<void>;
  bootTargetImage(inputs: UpgradeCheckInputs): Promise<void>;
  // Checked from inside the isolated copy project (never a host-reachable
  // origin): the copy's client-edge network is forced internal, same as
  // restore.ts's target, so a host-side fetch would never reach it anyway.
  checkHealth(copyStateNamespace: string): Promise<boolean>;
  // Reads the migrated copy's own database, from inside the isolated
  // project, for exactly the event IDs the source copy had before migration:
  // a passing /health check proves the server booted, not that the schema
  // migration preserved history.
  verifyEventHistory(copyStateNamespace: string, expectedEventIds: string[]): Promise<{ matchedEventIds: string[]; missingEventIds: string[] }>;
  supportsBackwardMigration(inputs: UpgradeCheckInputs): Promise<boolean>;
  now(): Date;
}

export type UpgradeSequenceStep = 'restore-database-copy' | 'boot-target-image' | 'health-check' | 'restore-pre-upgrade-backup';

export interface UpgradeCheckResult {
  ready: boolean;
  reason: string;
  currentSynapseImageDigest: string;
  targetSynapseImage: string;
  isRollback: boolean;
  supportsBackwardMigration: boolean;
  safeSequence: UpgradeSequenceStep[];
  matchedEventIds: string[];
  missingEventIds: string[];
  checkedAt: string;
}

// A same-version (or same-digest) image swap is not a migration rehearsal at
// all; calling that "rollback" would be false evidence.
export function isNoOpUpgrade(inputs: UpgradeCheckInputs): boolean {
  return inputs.targetSynapseImage.includes(inputs.currentSynapseImageDigest);
}

// Synapse image references carry their version as a `vX.Y.Z` tag
// (`ghcr.io/element-hq/synapse:v1.161.0@sha256:...`). Returns null for a
// reference this cannot parse, so callers can distinguish "not newer" from
// "not a version we understand" without guessing.
export function extractSynapseVersion(imageRef: string): [number, number, number] | null {
  const match = /:v(\d+)\.(\d+)\.(\d+)(?:@|$)/.exec(imageRef);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// R3's forward-migration proof is only real when the target is a genuinely
// newer Synapse release than what is currently running: booting an older
// image against a copy of the current database is a downgrade rehearsal, not
// a migration rehearsal, and must never be recorded as one.
export function isForwardUpgrade(inputs: Pick<UpgradeCheckInputs, 'currentSynapseImage' | 'targetSynapseImage'>): boolean {
  const current = extractSynapseVersion(inputs.currentSynapseImage);
  const target = extractSynapseVersion(inputs.targetSynapseImage);
  if (!current || !target) return false;
  for (let index = 0; index < 3; index += 1) {
    if (target[index] !== current[index]) return target[index] > current[index];
  }
  return false;
}

// The env override that boots the target image instead of compose.yaml's
// pinned default. Extracted as a pure function so the fix for "the rehearsal
// always boots the pinned image, never the target" can be asserted directly,
// without invoking docker.
export function bootTargetImageEnv(inputs: UpgradeCheckInputs, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...baseEnv, KHALA_SYNAPSE_IMAGE: inputs.targetSynapseImage };
}

// Every check in this function must run, and must be able to refuse, before
// any rehearsal mutation happens: a wrong or non-disposable copy namespace is
// refused here, mirroring restore.ts's ordering guarantee.
export async function runUpgradeCheck(inputs: UpgradeCheckInputs, ports: UpgradeCheckPorts): Promise<UpgradeCheckResult> {
  if (isNoOpUpgrade(inputs)) {
    return {
      ready: true,
      reason: 'no-op-same-image',
      currentSynapseImageDigest: inputs.currentSynapseImageDigest,
      targetSynapseImage: inputs.targetSynapseImage,
      isRollback: false,
      supportsBackwardMigration: false,
      safeSequence: [],
      matchedEventIds: [],
      missingEventIds: [],
      checkedAt: ports.now().toISOString(),
    };
  }

  // A target that is not a genuinely newer Synapse release is a downgrade
  // rehearsal, not the forward-migration proof R3 requires; refuse it before
  // any mutation rather than record a downgrade as a migration.
  if (!isForwardUpgrade(inputs)) throw new OperationsError('target-not-newer-than-current');

  if (!inputs.allowedCopyNamespaces.includes(inputs.copyStateNamespace)) throw new OperationsError('copy-namespace-not-allowlisted');
  if (inputs.copyStateNamespace === inputs.sourceStateNamespace) throw new OperationsError('source-volume-reuse-refused');
  if (await ports.targetVolumesExist(inputs.copyStateNamespace)) throw new OperationsError('copy-target-volumes-not-fresh');

  await ports.denyEgress(inputs.copyStateNamespace);
  if (!(await ports.probeEgressDenied(inputs.copyStateNamespace))) throw new OperationsError('egress-isolation-failed');

  await ports.restoreDatabaseCopy(inputs);
  await ports.bootTargetImage(inputs);
  const healthy = await ports.checkHealth(inputs.copyStateNamespace);
  // A booted-but-unhealthy target never gets asked about its history: a
  // health check failure is already conclusive, and querying a server that
  // failed to come up would misreport every event as missing.
  const { matchedEventIds, missingEventIds } = healthy
    ? await ports.verifyEventHistory(inputs.copyStateNamespace, inputs.expectedEventIds)
    : { matchedEventIds: [], missingEventIds: inputs.expectedEventIds };
  const supportsBackwardMigration = await ports.supportsBackwardMigration(inputs);

  // R3: downgrading the image alone is never called a rollback when the
  // schema migration it ran cannot itself go backward. The safe sequence for
  // that case is a restore of the pre-upgrade backup, not a downgraded boot.
  const safeSequence: UpgradeSequenceStep[] = supportsBackwardMigration
    ? ['restore-database-copy', 'boot-target-image', 'health-check']
    : ['restore-database-copy', 'boot-target-image', 'health-check', 'restore-pre-upgrade-backup'];

  const ready = healthy && missingEventIds.length === 0;
  const reason = !healthy ? 'health-check-failed' : missingEventIds.length > 0 ? 'history-check-failed' : 'migration-verified';

  return {
    ready,
    reason,
    currentSynapseImageDigest: inputs.currentSynapseImageDigest,
    targetSynapseImage: inputs.targetSynapseImage,
    isRollback: false,
    supportsBackwardMigration,
    safeSequence,
    matchedEventIds,
    missingEventIds,
    checkedAt: ports.now().toISOString(),
  };
}

const operationsDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const messagingComposeFile = resolve(operationsDirectory, '..', 'messaging', 'compose.yaml');
const isolationOverrideFile = resolve(operationsDirectory, 'rehearsal-isolation.override.yaml');

function composeArgs(copyStateNamespace: string): string[] {
  return ['compose', '-p', copyStateNamespace, '-f', messagingComposeFile, '-f', isolationOverrideFile];
}

export const dockerComposePorts: UpgradeCheckPorts = {
  async targetVolumesExist(copyStateNamespace) {
    const output = await captureProcess('docker', [
      'volume', 'ls', '--filter', `label=com.docker.compose.project=${copyStateNamespace}`, '--format', '{{.Name}}',
    ]);
    return output.trim().length > 0;
  },
  async denyEgress(copyStateNamespace) {
    await runProcess('docker', [...composeArgs(copyStateNamespace), 'up', '-d', 'synapse-data-init']);
    await runProcess('docker', [...composeArgs(copyStateNamespace), 'up', '-d', '--wait', 'postgres']);
  },
  async probeEgressDenied(copyStateNamespace) {
    const probeScript = "import urllib.request\ntry:\n    urllib.request.urlopen('https://1.1.1.1', timeout=3)\n    print('REACHABLE')\nexcept OSError:\n    print('UNREACHABLE')\n";
    const output = await captureProcess('docker', [...composeArgs(copyStateNamespace), 'run', '--rm', '--no-deps', '--entrypoint', 'python', 'synapse', '-c', probeScript]);
    return output.trim() === 'UNREACHABLE';
  },
  async restoreDatabaseCopy(inputs) {
    // Array-form spawn with the dump piped via stdin, never a shell string
    // interpolating the namespace or dump path.
    await runProcess('docker', [...composeArgs(inputs.copyStateNamespace), 'exec', '-T', 'postgres', 'pg_restore', '--clean', '--if-exists', '--no-owner', '--no-privileges', '-U', 'synapse', '-d', 'synapse'], { stdinPath: inputs.databaseDumpPath });
  },
  async bootTargetImage(inputs) {
    // KHALA_SYNAPSE_IMAGE overrides compose.yaml's pinned synapse image for
    // this invocation only, so the target image is what actually boots
    // rather than the pinned version silently standing in for it. Synapse
    // runs its own pending schema migrations as part of ordinary startup
    // (`/start.py run`, the same command compose.yaml already uses) — that
    // boot against the disposable database copy *is* the migration
    // rehearsal; there is no separate "migrate" subcommand to invoke, and
    // `migrate_config` is a config-file generator, not a schema migration.
    await runProcess('docker', [...composeArgs(inputs.copyStateNamespace), 'up', '-d', '--wait', 'synapse'], { env: bootTargetImageEnv(inputs) });
  },
  async checkHealth(copyStateNamespace) {
    try {
      const output = await captureProcess('docker', [...composeArgs(copyStateNamespace), 'exec', '-T', 'synapse', 'python', '-c', "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8008/health', timeout=5).status)"]);
      return output.trim() === '200';
    } catch {
      return false;
    }
  },
  async verifyEventHistory(copyStateNamespace, expectedEventIds) {
    const matchedEventIds: string[] = [];
    const missingEventIds: string[] = [];
    for (const eventId of expectedEventIds) {
      const output = await captureProcess('docker', [...composeArgs(copyStateNamespace), 'exec', '-T', 'postgres', 'psql', '-U', 'synapse', '-d', 'synapse', '-tAc', `select 1 from events where event_id = '${eventId.replaceAll("'", "''")}'`]);
      (output.trim() === '1' ? matchedEventIds : missingEventIds).push(eventId);
    }
    return { matchedEventIds, missingEventIds };
  },
  async supportsBackwardMigration() {
    // Synapse's own operator documentation states schema downgrades are not
    // supported once a newer version has run its migrations; treat that as
    // the default unless a specific pinned version pair is proven otherwise.
    return false;
  },
  now: () => new Date(),
};

function parseArguments(argv: string[]): { environment: string } {
  let environment: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--environment') environment = argv[++index];
    else throw new OperationsError('invalid-argument');
  }
  if (!environment) throw new OperationsError('missing-environment-argument');
  return { environment };
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new OperationsError('missing-input', `Missing ${key}`);
  return value;
}

export async function run(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<UpgradeCheckResult> {
  const { environment } = parseArguments(argv);
  // The upgrade rehearsal only ever runs against a disposable preview copy;
  // any other value means the caller passed the wrong environment on purpose
  // or by mistake, and both are refused rather than silently rehearsing
  // against the wrong stack.
  if (environment !== 'preview') throw new OperationsError('environment-mismatch');
  const inputs: UpgradeCheckInputs = {
    currentSynapseImageDigest: requiredEnv(env, 'KHALA_SYNAPSE_CURRENT_DIGEST'),
    currentSynapseImage: requiredEnv(env, 'KHALA_SYNAPSE_CURRENT_IMAGE'),
    targetSynapseImage: requiredEnv(env, 'KHALA_SYNAPSE_TARGET_IMAGE'),
    databaseDumpPath: requiredEnv(env, 'KHALA_BACKUP_DATABASE_DUMP'),
    sourceStateNamespace: requiredEnv(env, 'KHALA_STATE_NAMESPACE'),
    expectedEventIds: requiredEnv(env, 'KHALA_UPGRADE_EXPECTED_EVENT_IDS').split(',').map((eventId) => eventId.trim()).filter(Boolean),
    copyStateNamespace: requiredEnv(env, 'KHALA_UPGRADE_COPY_NAMESPACE'),
    // Set independently from KHALA_UPGRADE_COPY_NAMESPACE (not derived from
    // it) so the allowlist is a real check against a typo'd or wrong copy
    // namespace, matching restore.ts's allowedTargetIds contract.
    allowedCopyNamespaces: requiredEnv(env, 'KHALA_UPGRADE_ALLOWED_NAMESPACES').split(',').map((namespace) => namespace.trim()).filter(Boolean),
  };
  return runUpgradeCheck(inputs, dockerComposePorts);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      const reason = error instanceof OperationsError ? error.code : 'unexpected-error';
      console.error(JSON.stringify({ ready: false, reason }));
      process.exitCode = 1;
    });
}

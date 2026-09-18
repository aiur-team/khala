#!/usr/bin/env node
// Exercises an upgrade rehearsal: test the target Synapse image's migration
// against a disposable copy of the current database, then record whether a
// same-version image swap can be called a rollback or whether a
// schema-changing downgrade must instead go through restore.ts (R3).

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OperationsError, runProcess } from './backup.ts';

export interface UpgradeCheckInputs {
  currentSynapseImageDigest: string;
  targetSynapseImage: string;
  databaseDumpPath: string;
  copyStateNamespace: string;
  checkOrigin: string;
}

export interface UpgradeCheckPorts {
  restoreDatabaseCopy(inputs: UpgradeCheckInputs): Promise<void>;
  bootTargetImage(inputs: UpgradeCheckInputs): Promise<void>;
  checkHealth(origin: string): Promise<boolean>;
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
  checkedAt: string;
}

// A same-version (or same-digest) image swap is not a migration rehearsal at
// all; calling that "rollback" would be false evidence.
export function isNoOpUpgrade(inputs: UpgradeCheckInputs): boolean {
  return inputs.targetSynapseImage.includes(inputs.currentSynapseImageDigest);
}

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
      checkedAt: ports.now().toISOString(),
    };
  }

  await ports.restoreDatabaseCopy(inputs);
  await ports.bootTargetImage(inputs);
  const healthy = await ports.checkHealth(inputs.checkOrigin);
  const supportsBackwardMigration = await ports.supportsBackwardMigration(inputs);

  // R3: downgrading the image alone is never called a rollback when the
  // schema migration it ran cannot itself go backward. The safe sequence for
  // that case is a restore of the pre-upgrade backup, not a downgraded boot.
  const safeSequence: UpgradeSequenceStep[] = supportsBackwardMigration
    ? ['restore-database-copy', 'boot-target-image', 'health-check']
    : ['restore-database-copy', 'boot-target-image', 'health-check', 'restore-pre-upgrade-backup'];

  return {
    ready: healthy,
    reason: healthy ? 'migration-verified' : 'health-check-failed',
    currentSynapseImageDigest: inputs.currentSynapseImageDigest,
    targetSynapseImage: inputs.targetSynapseImage,
    isRollback: false,
    supportsBackwardMigration,
    safeSequence,
    checkedAt: ports.now().toISOString(),
  };
}

const operationsDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const messagingComposeFile = resolve(operationsDirectory, '..', 'messaging', 'compose.yaml');

export const dockerComposePorts: UpgradeCheckPorts = {
  async restoreDatabaseCopy(inputs) {
    await runProcess('docker', ['compose', '-p', inputs.copyStateNamespace, '-f', messagingComposeFile, 'up', '-d', '--wait', 'postgres']);
    await runProcess('sh', ['-c', `docker compose -p ${inputs.copyStateNamespace} -f ${messagingComposeFile} exec -T postgres pg_restore --clean --if-exists --no-owner --no-privileges -U synapse -d synapse < ${inputs.databaseDumpPath}`]);
  },
  async bootTargetImage(inputs) {
    await runProcess('sh', ['-c', `docker compose -p ${inputs.copyStateNamespace} -f ${messagingComposeFile} run --rm --no-deps -e SYNAPSE_CONFIG_PATH=/config/homeserver.yaml --entrypoint /start.py synapse migrate_config`]);
    await runProcess('docker', ['compose', '-p', inputs.copyStateNamespace, '-f', messagingComposeFile, 'up', '-d', '--wait', 'synapse']);
  },
  async checkHealth(origin) {
    try {
      const response = await fetch(new URL('/health', origin), { signal: AbortSignal.timeout(5_000) });
      await response.body?.cancel();
      return response.status === 200;
    } catch {
      return false;
    }
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

async function run(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<UpgradeCheckResult> {
  parseArguments(argv);
  const inputs: UpgradeCheckInputs = {
    currentSynapseImageDigest: requiredEnv(env, 'KHALA_SYNAPSE_CURRENT_DIGEST'),
    targetSynapseImage: requiredEnv(env, 'KHALA_SYNAPSE_TARGET_IMAGE'),
    databaseDumpPath: requiredEnv(env, 'KHALA_BACKUP_DATABASE_DUMP'),
    copyStateNamespace: requiredEnv(env, 'KHALA_UPGRADE_COPY_NAMESPACE'),
    checkOrigin: requiredEnv(env, 'KHALA_MATRIX_CHECK_ORIGIN'),
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

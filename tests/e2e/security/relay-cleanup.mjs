// Run this outside the resource-limited test scope (for example ExecStopPost).
// It is idempotent and targets only one helper-created disposable Compose project.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function docker(args, env) {
  try { return execFileSync('docker', args, { encoding: 'utf8', timeout: 180_000,
    stdio: ['ignore', 'pipe', 'pipe'], env }).trim(); }
  catch { throw new Error('relay_cleanup_docker_failed'); }
}

function cleanup(recoveryFile) {
  const privateRoot = path.join(os.homedir(), '.cache', 'khala-executor');
  const recoveryMatch = /^relay-recovery-([a-f0-9]{12})\.json$/u.exec(path.basename(recoveryFile));
  if (path.dirname(recoveryFile) !== privateRoot || !recoveryMatch) {
    throw new Error('relay_cleanup_path_invalid');
  }
  const scratch = path.join(privateRoot, `s-${recoveryMatch[1]}`);
  if (!existsSync(recoveryFile)) { rmSync(scratch, { recursive: true, force: true }); return; }
  const item = JSON.parse(readFileSync(recoveryFile, 'utf8'));
  const composeFile = fileURLToPath(new URL('../../../experiments/backend/compose.yaml', import.meta.url));
  if (item.v !== 1 || !/^khala-closure-[a-f0-9]{16}$/u.test(item.project)
    || item.composeFile !== composeFile
    || path.dirname(item.configDir) !== path.join(os.homedir(), '.cache')
    || !/^khala-345-synapse-[A-Za-z0-9]+$/u.test(path.basename(item.configDir))
    || item.overrideFile !== null && item.overrideFile !== path.join(item.configDir, 'limits.yaml')) {
    throw new Error('relay_cleanup_metadata_invalid');
  }
  const env = { ...process.env, EXPERIMENT_CONFIG_DIR: item.configDir };
  docker(['compose', '-p', item.project, '-f', composeFile,
    ...(item.overrideFile ? ['-f', item.overrideFile] : []), 'down', '--volumes', '--remove-orphans'], env);
  const label = `label=com.docker.compose.project=${item.project}`;
  if (docker(['ps', '-aq', '--filter', label], env)
    || docker(['volume', 'ls', '-q', '--filter', label], env)
    || docker(['network', 'ls', '-q', '--filter', label], env)) throw new Error('relay_cleanup_resources_remain');
  rmSync(item.configDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  rmSync(recoveryFile, { force: true });
}

try {
  if (process.argv.length !== 3) throw new Error('relay_cleanup_argument_required');
  cleanup(path.resolve(process.argv[2]));
  process.stdout.write('relay_cleanup_complete\n');
} catch {
  process.stderr.write('relay_cleanup_failed\n');
  process.exitCode = 1;
}

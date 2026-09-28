// Fixture-only lifecycle adapter. It supervises an operator-provisioned native
// session unit; it never creates a Khala binding or manufactures MCP metadata.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fail() { throw new Error('live_connector_control_unavailable'); }
function exactPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) fail();
  return value;
}
export function configAt(configPath) {
  exactPath(configPath);
  const file = statSync(configPath);
  if (!file.isFile() || file.uid !== process.getuid() || (file.mode & 0o077) !== 0) fail();
  const value = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!value || value.v !== 1
    || !/^khala-e2e-connector-[a-f0-9]{12}\.service$/u.test(value.unit)
    || value.harness !== 'codex' || typeof value.sessionId !== 'string' || !value.sessionId
    || typeof value.bindingId !== 'string' || !value.bindingId
    || !Number.isSafeInteger(value.generation) || value.generation < 0
    || typeof value.processCgroup !== 'string' || !value.processCgroup.endsWith(`/${value.unit}`)) fail();
  for (const key of ['stateRoot', 'workdir', 'processExecutable', 'processCwd', 'unitFragment']) exactPath(value[key]);
  if (realpathSync(value.workdir) !== value.workdir || realpathSync(value.processCwd) !== value.processCwd
    || realpathSync(value.processExecutable) !== value.processExecutable) fail();
  const fragment = statSync(value.unitFragment);
  if (!fragment.isFile() || fragment.uid !== process.getuid()) fail();
  return value;
}
function systemctl(args) {
  return execFileSync('systemctl', ['--user', ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4096,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function processStartTicks(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
  if (fields[0] === 'Z' || !fields[19]) fail();
  return fields[19];
}
export function bindingFor(config) {
  const sessionHash = createHash('sha256').update(JSON.stringify([
    'khala.hosted.session.v1', config.harness, config.sessionId, config.workdir,
  ])).digest('hex');
  const binding = JSON.parse(readFileSync(path.join(config.stateRoot, sessionHash, 'current-binding.json'), 'utf8'));
  if (binding.bindingId !== config.bindingId || binding.generation !== config.generation
    || binding.harness !== config.harness || binding.sessionId !== config.sessionId) fail();
  return binding;
}
function unitWitness(config) {
  const pairs = Object.fromEntries(systemctl(['show', config.unit, '--no-pager',
    '--property=Id,ActiveState,MainPID,ControlGroup,FragmentPath']).split('\n').map(line => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  if (pairs.Id !== config.unit || pairs.ActiveState !== 'active'
    || !/^[1-9][0-9]*$/u.test(pairs.MainPID ?? '')
    || pairs.ControlGroup !== config.processCgroup
    || pairs.FragmentPath !== config.unitFragment) fail();
  const pid = Number(pairs.MainPID);
  if (!Number.isSafeInteger(pid) || pid <= 0
    || realpathSync(`/proc/${pid}/exe`) !== config.processExecutable
    || realpathSync(`/proc/${pid}/cwd`) !== config.processCwd
    || !readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n')
      .some(line => line.split(':').slice(2).join(':') === config.processCgroup)) fail();
  const startTicks = processStartTicks(pid);
  const binding = bindingFor(config);
  return { pid, bindingId: binding.bindingId, generation: binding.generation,
    sessionId: binding.sessionId, startTicks };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || !['status', 'restart'].includes(process.argv[3])) fail();
    const config = configAt(process.argv[2]);
    const before = unitWitness(config);
    if (process.argv[3] === 'restart') {
      systemctl(['restart', config.unit]);
      const after = unitWitness(config);
      if (after.pid === before.pid || after.startTicks === before.startTicks) fail();
      try {
        if (processStartTicks(before.pid) === before.startTicks) fail();
      } catch (error) {
        if (error instanceof Error && error.message === 'live_connector_control_unavailable') throw error;
      }
      process.stdout.write(JSON.stringify(after) + '\n');
    } else {
      process.stdout.write(JSON.stringify(before) + '\n');
    }
  } catch {
    process.stderr.write('live_connector_control_unavailable\n');
    process.exitCode = 1;
  }
}

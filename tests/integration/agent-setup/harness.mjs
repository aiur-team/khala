// Black-box harness for the setup acceptance suite. It installs the packed `@aiur/khala`
// tarball into an empty prefix outside this repository and drives the installed bin against
// synthetic homes. Harnesses are fake `claude`/`codex`/`opencode` executables that answer
// `--version` and record every argv they receive; setup never needs more of them, because
// every adapter mutates through guarded direct edits.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_NAME, gatePackage } from '../../../scripts/agent-cli-package-gate.mjs';

export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** The versions each adapter certifies today; anything else is a detected, unsupported harness. */
export const SUPPORTED = Object.freeze({
  claude: '2.1.283 (Claude Code)',
  codex: 'codex-cli 0.154.0',
  opencode: '1.17.10',
});

// A scratch root outside the repository, so module resolution can never reach the
// workspace's `node_modules` from the installed package.
function outsideRepository() {
  const candidate = fs.realpathSync(os.tmpdir());
  const repository = fs.realpathSync(repositoryRoot);
  return candidate === repository || candidate.startsWith(repository + path.sep) ? '/tmp' : candidate;
}

const scratchRoots = [];

export function scratch(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(outsideRepository(), prefix)));
  scratchRoots.push(root);
  return root;
}

/** Removes every prefix, repack, and synthetic machine this process created. */
export function removeScratch() {
  for (const root of scratchRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  return result;
}

/**
 * The tarball under test: `KHALA_SETUP_TARBALL` when the release workflow hands over the
 * exact tarball its package gate accepted, otherwise one packed and gated now.
 */
export function packedTarball() {
  const given = process.env.KHALA_SETUP_TARBALL;
  if (given) return { tarball: path.resolve(given), cleanup: () => {} };
  const { errors, tarball, work } = gatePackage();
  if (errors.length) throw new Error(`package gate refused the tarball:\n${errors.join('\n')}`);
  return { tarball, cleanup: () => fs.rmSync(work, { recursive: true, force: true }) };
}

/** Installs a tarball into a fresh prefix with no network and returns the installed bin. */
export function installTarball(tarball) {
  const prefix = scratch('khala-setup-prefix-');
  fs.writeFileSync(path.join(prefix, 'package.json'), '{"private":true}\n');
  run('npm', ['install', '--offline', '--no-package-lock', tarball], {
    cwd: prefix,
    env: { ...process.env, npm_config_cache: path.join(prefix, '.npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' },
  });
  const packageDirectory = path.join(prefix, 'node_modules', ...PACKAGE_NAME.split('/'));
  const version = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8')).version;
  return { prefix, bin: path.join(packageDirectory, 'dist', 'khala.js'), version };
}

/**
 * A packed copy of the package at another version, for upgrade tests. Only the manifest
 * version changes; that is what setup stages the runtime and Claude marketplace under.
 */
export function repackAtVersion(tarball, version) {
  const work = scratch('khala-setup-repack-');
  run('tar', ['-xzf', tarball, '-C', work]);
  const manifestPath = path.join(work, 'package', 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version }, null, 2) + '\n');
  const repacked = path.join(work, `aiur-khala-${version}.tgz`);
  run('tar', ['-czf', repacked, '-C', work, 'package']);
  return repacked;
}

const shellQuote = value => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * A synthetic machine: `home`, a `bin` directory of fake harnesses first on PATH, and an
 * `argv` directory where each fake records the arguments it was run with.
 */
export function createMachine(harnesses = {}) {
  const root = scratch('khala-setup-home-');
  const machine = {
    root,
    home: path.join(root, 'home'),
    bin: path.join(root, 'bin'),
    argv: path.join(root, 'argv'),
    cwd: path.join(root, 'work'),
  };
  machine.tools = path.join(root, 'tools');
  for (const directory of [machine.home, machine.bin, machine.argv, machine.cwd, machine.tools]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Only the utilities the fakes use. The host's own `/usr/bin` (which may hold a real
  // harness, and is `/bin` on merged-usr systems) is never on the machine's PATH.
  for (const tool of TOOLS) fs.symlinkSync(resolveHostTool(tool), path.join(machine.tools, tool));
  for (const [name, version] of Object.entries(harnesses)) installHarness(machine, name, version);
  return machine;
}

const TOOLS = ['cat', 'sleep', 'wc'];

function resolveHostTool(tool) {
  for (const directory of ['/usr/bin', '/bin']) {
    const candidate = path.join(directory, tool);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`host tool ${tool} not found`);
}

/**
 * Puts a fake harness on the machine's PATH that prints `version` for `--version`. When
 * `<root>/<name>.hold-at` names its call count, that call creates `<name>.held` and waits
 * (below the CLI's 5 s probe deadline) while `<name>.hold` exists: a deterministic point
 * inside a setup run, since the executor replans, and so probes, under its lock.
 */
export function installHarness(machine, name, version) {
  const log = shellQuote(path.join(machine.argv, `${name}.log`));
  const file = suffix => shellQuote(path.join(machine.root, `${name}.${suffix}`));
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> ${log}
if [ -f ${file('hold-at')} ] && [ "$(wc -l < ${log})" -eq "$(cat ${file('hold-at')})" ]; then
  : > ${file('held')}
  n=0
  while [ -f ${file('hold')} ] && [ $n -lt 80 ]; do sleep 0.05; n=$((n + 1)); done
fi
printf '%s\\n' ${shellQuote(version)}
`;
  fs.writeFileSync(path.join(machine.bin, name), script, { mode: 0o755 });
}

export const harnessCalls = (machine, name) => {
  const log = path.join(machine.argv, `${name}.log`);
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
};

/**
 * Arranges for the harness's `calls`-th next probe to block until the returned `release`
 * is called; `held()` resolves once a process is blocked there.
 */
export function holdProbe(machine, name, calls) {
  const at = path.join(machine.root, `${name}.hold-at`);
  const hold = path.join(machine.root, `${name}.hold`);
  const held = path.join(machine.root, `${name}.held`);
  fs.rmSync(held, { force: true });
  fs.writeFileSync(hold, '');
  fs.writeFileSync(at, `${harnessCalls(machine, name) + calls}\n`);
  return {
    async held(timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (!fs.existsSync(held)) {
        if (Date.now() > deadline) throw new Error(`${name} probe was never held`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    },
    release() {
      fs.rmSync(hold, { force: true });
      fs.rmSync(at, { force: true });
    },
  };
}

export function removeHarness(machine, name) {
  fs.rmSync(path.join(machine.bin, name), { force: true });
}

/** The exact environment the CLI sees: HOME and PATH only, nothing inherited. */
export function machineEnvironment(machine, extra = {}) {
  return { HOME: machine.home, PATH: `${machine.bin}:${machine.tools}`, ...extra };
}

function parse(stdout) {
  try { return JSON.parse(stdout); } catch { return undefined; }
}

/** Runs the installed CLI on a machine and returns its exit code, JSON result, and raw streams. */
export function khala(install, machine, args, options = {}) {
  const result = spawnSync(process.execPath, [install.bin, ...args], {
    cwd: machine.cwd, encoding: 'utf8', env: machineEnvironment(machine, options.env), timeout: 60_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, json: parse(result.stdout) };
}

/** Starts the installed CLI without waiting, for concurrency and kill tests. */
export function khalaAsync(install, machine, args, options = {}) {
  const child = spawn(process.execPath, [install.bin, ...args], {
    cwd: machine.cwd, env: machineEnvironment(machine, options.env), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise(resolve => child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr, json: parse(stdout) })));
  return { child, done };
}

/** Plans, then confirms exactly the digest the plan returned, as a relaying agent would. */
export function confirmed(install, machine, command) {
  const plan = khala(install, machine, [command]);
  if (plan.status !== 5 || plan.json?.state !== 'confirmation_required') return { plan, applied: null };
  return { plan, applied: khala(install, machine, [command, '--confirm', plan.json.planDigest]) };
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Every entry below `directory`: type, mode, and content hash (plus mtime when asked). */
export function snapshot(directory, options = {}) {
  const result = {};
  const walk = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const target = path.join(current, name);
      if (options.exclude?.some(prefix => target === prefix || target.startsWith(prefix + path.sep))) continue;
      const stat = fs.lstatSync(target);
      const key = path.relative(directory, target);
      const mode = (stat.mode & 0o7777).toString(8);
      const mtime = options.mtimes ? ` ${stat.mtimeMs}` : '';
      if (stat.isSymbolicLink()) result[key] = `link ${fs.readlinkSync(target)}`;
      else if (stat.isDirectory()) {
        result[key] = `dir ${mode}${mtime}`;
        walk(target);
      } else result[key] = `file ${mode} ${sha256(fs.readFileSync(target))}${mtime}`;
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return result;
}

/** Every regular file below `directory` with its bytes, for byte-sequence searches. */
export function filesBelow(directory) {
  const files = [];
  const walk = current => {
    for (const name of fs.readdirSync(current)) {
      const target = path.join(current, name);
      const stat = fs.lstatSync(target);
      if (stat.isDirectory()) walk(target);
      else if (stat.isFile()) files.push({ path: target, bytes: fs.readFileSync(target) });
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return files;
}

/**
 * What Codex's "Hooks need review" dialog persists when the person trusts every Khala hook
 * handler: one `[hooks.state."<hooks.json>:<event>:<group>:<handler>"] trusted_hash` table
 * each, appended to `config.toml`. Khala only observes these; returns the appended bytes.
 */
export function approveCodexHooksNatively(machine) {
  const codex = path.join(machine.home, '.codex');
  const hooksPath = path.join(codex, 'hooks.json');
  const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks;
  const events = { PreToolUse: 'pre_tool_use', PostToolUse: 'post_tool_use', UserPromptSubmit: 'user_prompt_submit', Stop: 'stop' };
  // The installed handler: the staged launcher by absolute path, shell-quoted.
  const command = `'${path.join(machine.home, '.local', 'share', 'khala', 'bin', 'khala')}' codex-hook`;
  let tables = '';
  for (const [event, spelled] of Object.entries(events)) {
    for (const [group, entry] of (hooks[event] ?? []).entries()) {
      for (const [handler, candidate] of entry.hooks.entries()) {
        if (candidate.command !== command) continue;
        tables += `\n[hooks.state."${hooksPath}:${spelled}:${group}:${handler}"]\ntrusted_hash = "sha256:${'cd'.repeat(32)}"\n`;
      }
    }
  }
  fs.appendFileSync(path.join(codex, 'config.toml'), tables);
  return tables;
}

/**
 * Writes the owner-only runtime descriptor where the internal server publishes it and the
 * installed runtime re-reads it: `$XDG_STATE_HOME/khala/internal/active.json`.
 */
export function writeDescriptor(machine, descriptor) {
  const target = path.join(machine.home, '.local', 'state', 'khala', 'internal', 'active.json');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, JSON.stringify(descriptor) + '\n', { mode: 0o600 });
  return target;
}

/**
 * Writes one harness session's own granted descriptor where the launcher keeps it,
 * `discovery/<principal>/grant.json`, and where the installed `mcp-serve` and
 * `codex-hook` entries look it up for the session a call names.
 */
export function writeSessionGrant(machine, harness, sessionId, descriptor) {
  const preimage = ['khala.internal.principal.v1', harness, sessionId].join('\0');
  const principal = `agent_${createHash('sha256').update(preimage).digest('base64url')}`;
  const target = path.join(machine.home, '.local', 'state', 'khala', 'internal', 'discovery', principal, 'grant.json');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, JSON.stringify(descriptor) + '\n', { mode: 0o600 });
  return target;
}

// Smoke-tests a packed khala-cli tarball the way users get it, with no checkout on the path:
//   node packages/agent/scripts/smoke-package.mjs <khala-cli-x.y.z.tgz>
// Installs it globally into a temp prefix under a temp HOME, then checks `khala --version`,
// an MCP initialize + tools/list over stdio, a delivery hook, `install cursor` (MCP server
// started exactly as mcp.json says, a Cursor hook through the shell, uninstall) and
// `npx -y <tgz> --version`. Runs on Linux, macOS and native Windows.
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const windows = process.platform === 'win32';
const tarball = path.resolve(process.argv[2] ?? '');
const version = path.basename(tarball).match(/-(\d+\.\d+\.\d+(?:-[\w.]+)?)\.tgz$/)?.[1];
if (!version) throw new Error('usage: smoke-package.mjs <name-x.y.z.tgz>');
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'khala-smoke-')));
const prefix = path.join(root, 'prefix');
const home = path.join(root, 'home');
// npm on Windows lays a global prefix out flat: shims in <prefix>, packages in <prefix>\node_modules.
const binDir = windows ? prefix : path.join(prefix, 'bin');
const env = {
  // Windows processes need the system environment (SystemRoot, ComSpec, PATHEXT, …).
  ...(windows ? process.env : {}),
  PATH: [binDir, path.dirname(process.execPath), ...(windows ? [process.env.PATH ?? ''] : ['/usr/bin', '/bin'])].join(path.delimiter),
  HOME: home, USERPROFILE: home, COPILOT_HOME: path.join(home, '.copilot'), LOCALAPPDATA: path.join(root, 'localappdata'),
  XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'), XDG_DATA_HOME: path.join(root, 'data'),
  npm_config_cache: path.join(root, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false',
};
await fs.mkdir(home, { recursive: true });

function check(label, command, args, options = {}) {
  // npm, npx and the khala shim are .cmd files on Windows, which only start through a shell.
  const result = spawnSync(command, args, { env, cwd: root, encoding: 'utf8', shell: windows, ...options });
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}): ${result.stdout}${result.stderr}${result.error ?? ''}`);
  console.log(`ok ${label}`);
  return result.stdout;
}
const quote = value => windows ? `"${value}"` : value;

/** Captures bytes or absence before install and verifies exact restoration after uninstall. */
async function readOriginal(file) {
  try { return await fs.readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function captureOriginals(files) {
  return Promise.all(files.map(async file => [file, await readOriginal(file)]));
}
async function assertRestored(originals) {
  for (const [file, original] of originals) {
    assert.deepStrictEqual(await readOriginal(file), original, `uninstall did not restore ${file}`);
  }
}

/** Starts an MCP server, runs initialize + tools/list and stops it. */
async function mcpSmoke(label, command, args, callStatus = false, childEnv = env) {
  const child = spawn(command, args, { env: childEnv, cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8').on('data', data => {
    buffer += data;
    for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) {
      const line = buffer.slice(0, i).trim();
      if (line) { const message = JSON.parse(line); replies.get(message.id)?.(message); }
    }
  });
  const exited = new Promise(resolve => child.once('close', resolve));
  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: no reply to ${method}`)), 30000);
    replies.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const init = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    if (init.result?.serverInfo?.version !== version) throw new Error(`${label} initialize: ${JSON.stringify(init)}`);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await request(2, 'tools/list', {});
    const names = (tools.result?.tools ?? []).map(tool => tool.name);
    if (!names.includes('khala_join')) throw new Error(`${label} tools/list: ${JSON.stringify(tools)}`);
    console.log(`ok ${label} initialize + tools/list (${names.join(', ')})`);
    if (callStatus) {
      // Creates and reads the session state directory: the private-directory and atomic-write
      // paths that differ on Windows.
      const status = await request(3, 'tools/call', { name: 'khala_status', arguments: {} });
      const text = status.result?.content?.[0]?.text ?? '';
      if (status.result?.isError || !text.includes('"state"')) throw new Error(`${label} khala_status: ${JSON.stringify(status)}`);
      console.log(`ok ${label} khala_status ${text}`);
    }
  } finally {
    child.stdin.end();
    child.kill();
    await exited;
  }
}


try {
  check('npm install -g', 'npm', ['install', '--global', '--prefix', quote(prefix), quote(tarball)]);
  const bin = path.join(binDir, windows ? 'khala.cmd' : 'khala');
  const script = path.join(prefix, ...(windows ? [] : ['lib']), 'node_modules', 'khala-cli', 'dist', 'khala.mjs');
  const reported = check('khala --version', quote(bin), ['--version']).trim();
  if (reported !== version) throw new Error(`khala --version printed ${reported}, expected ${version}`);
  check('hook deliver', quote(bin), ['hook', 'deliver', '--harness', 'claude'], { input: '{}' });
  await mcpSmoke('mcp --harness claude', process.execPath, [script, 'mcp', '--harness', 'claude']);

  // Cursor: install from this tarball into the temp profile, then run exactly what Cursor would.
  const cursorDir = path.join(home, '.cursor');
  const cursorOriginals = await captureOriginals(['mcp.json', 'hooks.json'].map(file => path.join(cursorDir, file)));
  check('install cursor', process.execPath, [script, 'install', 'cursor'], { shell: false, env: { ...env, KHALA_INSTALL_SPEC: tarball } });
  const mcp = JSON.parse(await fs.readFile(path.join(cursorDir, 'mcp.json'), 'utf8'));
  const server = mcp.mcpServers?.khala;
  if (!server || server.env?.KHALA_CURSOR_WORKSPACE !== '${workspaceFolder}') throw new Error(`mcp.json: ${JSON.stringify(mcp)}`);
  await mcpSmoke('cursor mcp.json server', server.command, server.args, true);
  const hooks = JSON.parse(await fs.readFile(path.join(cursorDir, 'hooks.json'), 'utf8'));
  const command = hooks.hooks?.stop?.[0]?.command;
  if (typeof command !== 'string' || !['beforeSubmitPrompt', 'postToolUse', 'stop'].every(event => hooks.hooks[event]?.length === 1)) {
    throw new Error(`hooks.json: ${JSON.stringify(hooks)}`);
  }
  // Cursor feeds hooks a BOM-prefixed payload on Windows; the hook must still answer valid JSON.
  const payload = '﻿' + JSON.stringify({ hook_event_name: 'beforeSubmitPrompt', workspace_roots: [root], conversation_id: 'c' });
  const hookOut = check('cursor hook command', command, [], { shell: true, input: payload }).trim();
  if (hookOut !== '{"continue":true}') throw new Error(`cursor hook printed ${hookOut}`);
  check('install cursor (again)', process.execPath, [script, 'install', 'cursor'], { shell: false, env: { ...env, KHALA_INSTALL_SPEC: tarball } });
  const again = JSON.parse(await fs.readFile(path.join(cursorDir, 'hooks.json'), 'utf8'));
  if (JSON.stringify(again) !== JSON.stringify(hooks)) throw new Error('install cursor is not idempotent');
  check('install cursor --uninstall', process.execPath, [script, 'install', 'cursor', '--uninstall'], { shell: false });
  await assertRestored(cursorOriginals);

  // Gemini uses the same managed-file restore path on POSIX and native Windows.
  // XDG's parent may be public; only Khala's recording directory must be private.
  await fs.chmod(env.XDG_STATE_HOME, 0o755);
  check('install gemini', process.execPath, [script, 'install', 'gemini'], { shell: false, env: { ...env, KHALA_INSTALL_SPEC: tarball } });
  const geminiConfig = path.join(home, '.gemini', 'settings.json');
  const gemini = JSON.parse(await fs.readFile(geminiConfig, 'utf8'));
  assert.equal(gemini.mcpServers.khala.command, process.execPath);
  assert.equal(gemini.mcpServers.khala.trust, undefined);
  assert.ok(['SessionStart', 'BeforeAgent', 'AfterTool', 'AfterAgent'].every(event => gemini.hooks[event]?.length === 1));
  check('install gemini --uninstall', process.execPath, [script, 'install', 'gemini', '--uninstall'], { shell: false });
  await assert.rejects(fs.stat(geminiConfig), { code: 'ENOENT' });

  // Copilot: execute the installed shell command with the CLI's event-less camelCase payload.
  const copilotDir = path.join(home, '.copilot');
  await fs.mkdir(copilotDir, { recursive: true });
  const cpOriginal = JSON.stringify({ mcpServers: { other: { command: 'other' } } });
  await fs.writeFile(path.join(copilotDir, 'mcp-config.json'), cpOriginal);
  check('install copilot', process.execPath, [script, 'install', 'copilot'], { shell: false, env: { ...env, KHALA_INSTALL_SPEC: tarball } });
  const cp = JSON.parse(await fs.readFile(path.join(copilotDir, 'mcp-config.json'), 'utf8'));
  if (cp.mcpServers?.khala?.type !== 'local' || cp.mcpServers?.other?.command !== 'other') throw new Error('Copilot MCP config');
  await mcpSmoke('copilot mcp-config.json server', cp.mcpServers.khala.command, cp.mcpServers.khala.args);
  const cpHooks = JSON.parse(await fs.readFile(path.join(copilotDir, 'hooks', 'khala.json'), 'utf8'));
  for (const event of ['sessionStart', 'userPromptSubmitted', 'postToolUse', 'agentStop']) {
    const handler = cpHooks.hooks?.[event]?.[0];
    if (handler?.type !== 'command' || !handler.bash || !handler.powershell) throw new Error(`Copilot hook ${event}`);
    const hookArgs = windows ? ['-NoProfile', '-NonInteractive', '-Command', handler.powershell] : ['-c', handler.bash];
    const hookOut = check(`copilot ${event} hook`, windows ? 'powershell.exe' : 'bash', hookArgs,
      { shell: false, input: JSON.stringify({ sessionId: 'smoke-session', cwd: root }) }).trim();
    if (hookOut !== '{}') throw new Error(`copilot hook printed ${hookOut}`);
  }
  check('install copilot (again)', process.execPath, [script, 'install', 'copilot'], { shell: false, env: { ...env, KHALA_INSTALL_SPEC: tarball } });
  if (JSON.stringify(JSON.parse(await fs.readFile(path.join(copilotDir, 'hooks', 'khala.json'), 'utf8'))) !== JSON.stringify(cpHooks)) throw new Error('install copilot is not idempotent');
  check('install copilot --uninstall', process.execPath, [script, 'install', 'copilot', '--uninstall'], { shell: false });
  const cpRemoved = JSON.parse(await fs.readFile(path.join(copilotDir, 'mcp-config.json'), 'utf8'));
  if (cpRemoved.mcpServers.khala || cpRemoved.mcpServers.other?.command !== 'other') throw new Error('Copilot uninstall');
  if (await fs.readFile(path.join(copilotDir, 'mcp-config.json'), 'utf8') !== cpOriginal) throw new Error('Copilot original bytes not restored');
  for (const file of [path.join(copilotDir, 'mcp-config.json.khala-bak'), path.join(copilotDir, 'hooks', 'khala.json'), path.join(copilotDir, 'hooks', 'khala.json.khala-bak')]) {
    if (await fs.stat(file).catch(() => null)) throw new Error(`Copilot uninstall left ${file}`);
  }

  // Force plugin mode so this smoke stays deterministic before plugin publication.
  const opencodeConfig = path.join(root, 'config', 'opencode', 'opencode.json');
  const opencodeOriginals = await captureOriginals([opencodeConfig]);
  check('install opencode', process.execPath, [script, 'install', 'opencode'], { shell: false, env: { ...env, KHALA_INSTALL_SPEC: tarball, KHALA_OPENCODE_PLUGIN_SPEC: `khala-opencode@${version}` } });
  const oc = JSON.parse(await fs.readFile(opencodeConfig, 'utf8'));
  if (JSON.stringify(oc) !== JSON.stringify({ plugin: [`khala-opencode@${version}`] })) throw new Error(`opencode.json: ${JSON.stringify(oc)}`);
  check('install opencode (again)', process.execPath, [script, 'install', 'opencode'], { shell: false, env: { ...env, KHALA_INSTALL_SPEC: tarball, KHALA_OPENCODE_PLUGIN_SPEC: `khala-opencode@${version}` } });
  if (JSON.stringify(JSON.parse(await fs.readFile(opencodeConfig, 'utf8'))) !== JSON.stringify(oc)) throw new Error('install opencode is not idempotent');
  await mcpSmoke('mcp --harness opencode', process.execPath, [script, 'mcp', '--harness', 'opencode']);
  const ocHook = check('opencode session-start', process.execPath, [script, 'hook', 'deliver', '--harness', 'opencode'],
    { shell: false, input: JSON.stringify({ session_id: 'smoke-session', event: 'session-start' }) });
  if (ocHook !== '') throw new Error(`opencode hook printed ${ocHook}`);
  check('install opencode --uninstall', process.execPath, [script, 'install', 'opencode', '--uninstall'], { shell: false });
  await assertRestored(opencodeOriginals);

  // A real home: no XDG_STATE_HOME, and ~/.local and ~/.local/state are 0755 like on a normal
  // system. Only Khala's own state root (~/.local/state/khala) must be private.
  if (!windows) {
    const realHome = path.join(root, 'real-home');
    const stateHome = path.join(realHome, '.local', 'state');
    for (const dir of [realHome, path.join(realHome, '.local'), stateHome]) { await fs.mkdir(dir, { recursive: true }); await fs.chmod(dir, 0o755); }
    const realEnv = { ...env, HOME: realHome, USERPROFILE: realHome, XDG_CONFIG_HOME: path.join(realHome, '.config') };
    delete realEnv.XDG_STATE_HOME;
    check('install cursor (0755 ~/.local/state)', process.execPath, [script, 'install', 'cursor'], { shell: false, env: { ...realEnv, KHALA_INSTALL_SPEC: tarball } });
    const realMcp = JSON.parse(await fs.readFile(path.join(realHome, '.cursor', 'mcp.json'), 'utf8')).mcpServers?.khala;
    await mcpSmoke('cursor mcp.json server (0755 ~/.local/state)', realMcp.command, realMcp.args, true, realEnv);
    check('install opencode (0755 ~/.local/state)', process.execPath, [script, 'install', 'opencode'], { shell: false, env: { ...realEnv, KHALA_INSTALL_SPEC: tarball, KHALA_OPENCODE_PLUGIN_SPEC: `khala-opencode@${version}` } });
    for (const harness of ['cursor', 'opencode']) check(`install ${harness} --uninstall (0755 ~/.local/state)`, process.execPath, [script, 'install', harness, '--uninstall'], { shell: false, env: realEnv });
    const khalaRoot = path.join(stateHome, 'khala');
    if (((await fs.stat(khalaRoot)).mode & 0o777) !== 0o700) throw new Error(`${khalaRoot} is not 0700`);
    for (const dir of [path.join(realHome, '.local'), stateHome]) {
      if (((await fs.stat(dir)).mode & 0o777) !== 0o755) throw new Error(`${dir} was changed from 0755`);
    }
    console.log('ok khala state root private under 0755 ~/.local/state');
  }

  // npx needs a ./relative tarball path (an absolute one is taken for a command), and it resolves that path
  // against the nearest package.json ancestor, not cwd. Give the isolated npx directory its own package root.
  const npxDir = path.join(root, 'npx');
  await fs.mkdir(npxDir, { recursive: true });
  await fs.writeFile(path.join(npxDir, 'package.json'), JSON.stringify({ private: true }));
  await fs.copyFile(tarball, path.join(npxDir, path.basename(tarball)));
  const viaNpx = check('npx -y <tgz> --version', 'npx', ['-y', `./${path.basename(tarball)}`, '--version'], { cwd: npxDir }).trim();
  if (viaNpx !== version) throw new Error(`npx printed ${viaNpx}`);
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

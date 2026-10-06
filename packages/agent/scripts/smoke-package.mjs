// Smoke-tests a packed khala-cli tarball the way users get it, with no checkout on the path:
//   node packages/agent/scripts/smoke-package.mjs <khala-cli-x.y.z.tgz>
// Installs it globally into a temp prefix under a temp HOME, then checks `khala --version`,
// an MCP initialize + tools/list over stdio, a delivery hook, `install cursor` (MCP server
// started exactly as mcp.json says, a Cursor hook through the shell, uninstall) and
// `npx -y <tgz> --version`. Runs on Linux, macOS and native Windows.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

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
  HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(root, 'localappdata'),
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

/** Starts an MCP server, runs initialize + tools/list and stops it. */
async function mcpSmoke(label, command, args, callStatus = false) {
  const child = spawn(command, args, { env, cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
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
  check('install cursor', process.execPath, [script, 'install', 'cursor'], { shell: false, env: { ...env, KHALA_INSTALL_SPEC: tarball } });
  const cursorDir = path.join(home, '.cursor');
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
  for (const name of ['mcp.json', 'hooks.json']) {
    await assert.rejects(fs.readFile(path.join(cursorDir, name)), { code: 'ENOENT' });
  }

  // Force plugin mode so this smoke stays deterministic before plugin publication.
  const opencodeConfig = path.join(root, 'config', 'opencode', 'opencode.json');
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
  await assert.rejects(fs.readFile(opencodeConfig), { code: 'ENOENT' });

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

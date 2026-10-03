// Smoke-tests a packed khala-cli tarball the way users get it, with no checkout on the path:
//   node packages/agent/scripts/smoke-package.mjs <khala-cli-x.y.z.tgz>
// Installs it globally into a temp prefix under a temp HOME, then checks `khala --version`,
// an MCP initialize + tools/list over stdio, a delivery hook and `npx -y <tgz> --version`.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tarball = path.resolve(process.argv[2] ?? '');
const version = path.basename(tarball).match(/-(\d+\.\d+\.\d+(?:-[\w.]+)?)\.tgz$/)?.[1];
if (!version) throw new Error('usage: smoke-package.mjs <name-x.y.z.tgz>');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-smoke-'));
const prefix = path.join(root, 'prefix');
const env = {
  PATH: [path.join(prefix, 'bin'), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
  HOME: path.join(root, 'home'), XDG_STATE_HOME: path.join(root, 'state'), XDG_DATA_HOME: path.join(root, 'data'),
  npm_config_cache: path.join(root, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false',
};
await fs.mkdir(env.HOME, { recursive: true });

function check(label, command, args, options = {}) {
  const result = spawnSync(command, args, { env, cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}): ${result.stdout}${result.stderr}`);
  console.log(`ok ${label}`);
  return result.stdout;
}

try {
  check('npm install -g', 'npm', ['install', '--global', '--prefix', prefix, tarball]);
  const bin = path.join(prefix, 'bin', 'khala');
  const reported = check('khala --version', bin, ['--version']).trim();
  if (reported !== version) throw new Error(`khala --version printed ${reported}, expected ${version}`);
  check('hook deliver', bin, ['hook', 'deliver', '--harness', 'claude'], { input: '{}' });

  const child = spawn(bin, ['mcp', '--harness', 'claude'], { env, cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8').on('data', data => {
    buffer += data;
    for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) {
      const line = buffer.slice(0, i).trim();
      if (line) { const message = JSON.parse(line); replies.get(message.id)?.(message); }
    }
  });
  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 30000);
    replies.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const init = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    if (init.result?.serverInfo?.version !== version) throw new Error(`initialize: ${JSON.stringify(init)}`);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await request(2, 'tools/list', {});
    const names = (tools.result?.tools ?? []).map(tool => tool.name);
    if (!names.includes('khala_join')) throw new Error(`tools/list: ${JSON.stringify(tools)}`);
    console.log(`ok mcp initialize + tools/list (${names.join(', ')})`);
  } finally { child.kill(); }

  // npx needs a ./relative tarball path; an absolute one is taken for a command.
  const viaNpx = check('npx -y <tgz> --version', 'npx', ['-y', `./${path.basename(tarball)}`, '--version'], { cwd: path.dirname(tarball) }).trim();
  if (viaNpx !== version) throw new Error(`npx printed ${viaNpx}`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

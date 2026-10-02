import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const installedCli = process.argv[2];
const origin = process.env.KHALA_APP_ORIGIN;
const stateHome = process.env.XDG_STATE_HOME;
if (!installedCli || !origin || !/^https:\/\/127\.0\.0\.1:\d+$/u.test(origin) || !stateHome || !path.isAbsolute(stateHome)) {
  throw new Error('installed_connector_inputs_invalid');
}
const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
  name: 'khala_connect', arguments: { url: `${origin}/join/${randomBytes(16).toString('hex')}` },
  _meta: { threadId: randomUUID() },
} };
const child = spawn(process.execPath, [installedCli, 'mcp-serve'], {
  env: process.env, stdio: ['pipe', 'pipe', 'ignore'],
});
let output = '';
child.stdout.setEncoding('utf8').on('data', chunk => {
  output += chunk;
  if (output.length > 64 * 1024) child.kill('SIGTERM');
});
const timer = setTimeout(() => child.kill('SIGTERM'), 45_000);
child.stdin.end(`${JSON.stringify(request)}\n`);
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', resolve);
});
clearTimeout(timer);
if (code !== 0) throw new Error('installed_connector_process_failed');
let reply;
try { reply = JSON.parse(output.trim().split('\n').find(line => JSON.parse(line).id === 1)); }
catch { throw new Error('installed_connector_response_invalid'); }
const result = reply?.result?.structuredContent;
if (!result || result.error === 'not_connected' || result.error === 'invalid_link'
  || result.error === 'untrusted_origin') throw new Error('installed_connector_not_opened');
const hosted = await readdir(path.join(stateHome, 'khala', 'hosted'), { withFileTypes: true });
if (!hosted.some(entry => entry.isDirectory())) throw new Error('installed_connector_state_absent');

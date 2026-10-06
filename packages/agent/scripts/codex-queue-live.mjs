// Disposable daemon fixture only; never connects to an installed user's Codex home.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
const execute = promisify(execFile);
const { stdout: help } = await execute('codex', ['queue', '--help'], { timeout: 10_000 });
assert.match(help, /--thread\b/);
assert.match(help, /--message\b/);
console.log('queue help contract passed');
if (!process.argv.includes('--live')) process.exit(0);
assert.ok(process.env.OPENAI_API_KEY, 'Live step requires the dedicated low-cap OPENAI_API_KEY');
const root = await mkdtemp(path.join(tmpdir(), 'khala-codex-queue-'));
const home = path.join(root, 'codex');
await mkdir(home, { mode: 0o700 });
const env = { ...process.env, CODEX_HOME: home, XDG_RUNTIME_DIR: root };
const hooks = path.join(root, 'hooks.jsonl');
const recorder = path.join(root, 'record-hook.mjs');
await writeFile(recorder, `import fs from 'node:fs'; let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => { const p = JSON.parse(input); fs.appendFileSync(${JSON.stringify(hooks)}, JSON.stringify({ session_id: p.session_id, hook_event_name: p.hook_event_name, prompt: p.prompt })+'\\n'); console.log('{}'); });`);
await writeFile(path.join(home, 'hooks.json'), JSON.stringify({ hooks: {
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)}`, timeout: 10 }] }],
} }));
await writeFile(path.join(home, 'config.toml'), '[features]\nhooks = true\n');
let proxy;
try {
  await execute('codex', ['app-server', 'daemon', 'start'], { env, timeout: 30_000 });
  proxy = spawn('codex', ['app-server', 'proxy'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  const notifications = [];
  let buffer = '', sequence = 0, closed = false;
  proxy.on('error', () => { closed = true; });
  proxy.on('exit', () => { closed = true; });
  proxy.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
        if (message.error) reject(new Error(`RPC error: ${message.error.code}`)); else resolve(message.result);
      } else notifications.push(message);
    }
  });
  async function waitFor(check, failure) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (closed) throw new Error('Daemon proxy closed');
      const value = await check(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(failure);
  }
  async function rpc(method, params) {
    const id = ++sequence;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    proxy.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    const timeout = setTimeout(() => { pending.get(id)?.reject(new Error(`RPC timeout: ${method}`)); pending.delete(id); }, 30_000);
    try { return await result; } finally { clearTimeout(timeout); }
  }
  await rpc('initialize', { clientInfo: { name: 'khala_queue_live', version: '1' }, capabilities: { experimentalApi: true } });
  proxy.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  await rpc('account/login/start', { type: 'apiKey', apiKey: env.OPENAI_API_KEY });
  // Trust only the recorder we just wrote, using the same hooks.state contract as the TUI.
  const listed = await rpc('hooks/list', { cwds: [root] });
  const hook = listed.data.flatMap(entry => entry.hooks).find(hook =>
    hook.eventName === 'UserPromptSubmit' && hook.sourcePath === path.join(home, 'hooks.json') && hook.command === `${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)}`);
  assert.ok(hook?.enabled && hook.currentHash && hook.key, 'Fixture prompt hook was not discovered');
  await rpc('config/value/write', { keyPath: 'hooks.state', value: { [hook.key]: { trusted_hash: hook.currentHash } }, mergeStrategy: 'upsert' });
  const { thread } = await rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only',
    baseInstructions: 'This is a queue transport test. Reply READY to every input. Do not use tools.' });
  // Materialize a saved rollout and prove hook setup before testing the queue path.
  const { turn: initial } = await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Reply READY.', text_elements: [] }] });
  const seeded = await waitFor(() => notifications.find(n => n.method === 'turn/completed' && n.params?.threadId === thread.id && n.params?.turn?.id === initial.id), 'Fixture initial turn did not complete');
  assert.equal(seeded.params.turn.status, 'completed', 'Fixture initial turn failed');
  const seedHooks = (await readFile(hooks, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(row => JSON.parse(row));
  assert.ok(seedHooks.some(p => p.session_id === thread.id && p.hook_event_name === 'UserPromptSubmit' && p.prompt === 'Reply READY.'), 'Fixture initial prompt hook did not run; hook setup failure');
  const nonce = randomBytes(4).toString('hex');
  const line = `Khala: channel messages are waiting. Continue. (k-${nonce})`;
  await execute('codex', ['queue', '--thread', thread.id, '--message', line], { env, timeout: 10_000 });
  const queued = await waitFor(() => notifications.find(n => n.method === 'turn/completed' && n.params?.threadId === thread.id && n.params?.turn?.id !== initial.id), 'Queued message did not complete a turn');
  assert.equal(queued.params.turn.status, 'completed', 'Queued turn failed');
  const records = await readFile(hooks, 'utf8').catch(() => '');
  const matched = records.split('\n').filter(Boolean).map(row => JSON.parse(row)).some(p =>
    p.session_id === thread.id && p.hook_event_name === 'UserPromptSubmit' && p.prompt?.includes(`(k-${nonce})`));
  assert.ok(matched, 'STOP / ESCALATE: queued turn did not fire UserPromptSubmit with nonce in prompt; R2 verification cannot be accepted');
  console.log('Queued daemon turn and same-thread UserPromptSubmit nonce verified');
} finally {
  proxy?.stdin.end();
  proxy?.kill('SIGTERM');
  await execute('codex', ['app-server', 'daemon', 'stop'], { env, timeout: 10_000 }).catch(() => {});
  await rm(root, { recursive: true, force: true });
}

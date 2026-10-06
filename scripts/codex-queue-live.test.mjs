import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const script = fileURLToPath(new URL('../packages/agent/scripts/codex-queue-live.mjs', import.meta.url));
for (const missingHook of [false, true]) test(`live oracle rejects missing queued prompt hook=${missingHook}`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'khala-live-oracle-'));
  try {
    await writeFile(path.join(root, 'codex'), `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
const args = process.argv.slice(2), home = process.env.CODEX_HOME;
if (args[0] === 'queue' && args[1] === '--help') { console.log('--thread --message'); process.exit(0); }
if (args[0] === 'queue') { fs.writeFileSync(path.join(home, 'queued'), args[4]); process.exit(0); }
if (args[1] !== 'proxy') process.exit(0);
const hook = JSON.parse(fs.readFileSync(path.join(home, 'hooks.json'))).hooks.UserPromptSubmit[0].hooks[0];
function record(prompt) { execSync(hook.command, { input: JSON.stringify({ session_id: 'thread', hook_event_name: 'UserPromptSubmit', prompt }) }); }
function send(message) { console.log(JSON.stringify(message)); }
readline.createInterface({ input: process.stdin }).on('line', line => {
  const p = JSON.parse(line); if (!p.id) return;
  let result = {};
  if (p.method === 'hooks/list') result = { data: [{ hooks: [{ key: 'fixture', enabled: true, currentHash: 'hash', eventName: 'UserPromptSubmit', sourcePath: path.join(home, 'hooks.json'), command: hook.command }] }] };
  if (p.method === 'thread/start') result = { thread: { id: 'thread' } };
  if (p.method === 'turn/start') { result = { turn: { id: 'initial' } }; record('Reply READY.'); }
  send({ id: p.id, result });
  if (p.method === 'turn/start') send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'initial', status: 'completed' } } });
});
const timer = setInterval(() => {
  const file = path.join(home, 'queued'); if (!fs.existsSync(file)) return;
  const prompt = fs.readFileSync(file, 'utf8'); fs.unlinkSync(file);
  if (!${missingHook}) record(prompt);
  send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'queued', status: 'completed' } } });
  clearInterval(timer);
}, 20);
`, { mode: 0o700 });
    const env = { ...process.env, PATH: root + path.delimiter + process.env.PATH, OPENAI_API_KEY: 'fixture-key' };
    if (missingHook) await assert.rejects(execute(process.execPath, [script, '--live'], { env, timeout: 15_000 }), error => /STOP \/ ESCALATE/.test(error.stderr));
    else assert.match((await execute(process.execPath, [script, '--live'], { env, timeout: 15_000 })).stdout, /same-thread UserPromptSubmit nonce verified/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const server = fileURLToPath(new URL('../server.mjs', import.meta.url));

test('server delivers once and acknowledges through the exact token-only next call', { timeout: 5_000 }, async t => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'mcp-format-server.'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logPath = join(directory, 'events.jsonl');
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, KHALA_FORMAT_SCENARIO: 'ordered', KHALA_FORMAT_LOG: logPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = [];
  lines.on('line', line => pending.shift()?.(JSON.parse(line)));
  const request = message => new Promise((resolve, reject) => {
    pending.push(resolve);
    child.stdin.write(`${JSON.stringify(message)}\n`, error => { if (error) reject(error); });
  });

  await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const first = await request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'khala_read', arguments: {} } });
  assert.equal(first.result.content[0].text, 'Khala read completed.');
  const token = first.result.content[1].text.match(/^batchToken: (.+)$/m)?.[1];
  assert.equal(token, 'bt_ordered_opaque_7Qx');

  const acknowledged = await request({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'khala_read', arguments: { ackBatchToken: token } },
  });
  assert.equal(acknowledged.result.content[0].text, 'Batch acknowledged. No messages remain.');
  child.stdin.end();
  await new Promise((resolve, reject) => {
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`server exited ${code}`)));
  });

  const events = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.filter(event => event.kind === 'tool_call').map(event => event.arguments), [
    {},
    { ackBatchToken: token },
  ]);
  assert.deepEqual(events.filter(event => event.kind === 'acknowledged').map(event => event.ackBatchToken), [token]);
});

import { appendFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Restart trial driver. Waits until the product MCP server writes a tool result
// carrying a batch, then SIGKILLs that server's interactive Codex process and
// the server itself before Codex can make another Khala call.
//
//   kill-after-delivery.mjs <fixture-dir> [timeout-seconds]
const [dirArgument, seconds = '600'] = process.argv.slice(2);
if (!dirArgument) throw new Error('usage: kill-after-delivery.mjs <fixture-dir> [timeout-seconds]');
const logPath = join(resolve(dirArgument), 'events.jsonl');
const deadline = Date.now() + Number(seconds) * 1000;

async function events() {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

while (Date.now() < deadline) {
  const all = await events();
  const delivered = all.find(event => event.event === 'rpc_out'
    && JSON.stringify(event.message).includes('<khala-channel-batch-v1>'));
  if (delivered) {
    const start = all.find(event => event.event === 'serve_start' && event.serveId === delivered.serveId);
    const codex = start.ancestors.find(process => /^\/dev\/pts\//.test(process.stdin ?? ''));
    if (!codex) throw new Error('no interactive Codex ancestor recorded');
    for (const pid of [codex.pid, start.pid]) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await appendFile(logPath, `${JSON.stringify({
      at: new Date().toISOString(), event: 'killed', serveId: delivered.serveId, codexPid: codex.pid,
      servePid: start.pid, deliveredAt: delivered.at,
    })}\n`);
    console.log(JSON.stringify({ killed: [codex.pid, start.pid], deliveredAt: delivered.at }));
    process.exit(0);
  }
  await new Promise(done => setTimeout(done, 10));
}
throw new Error('timed out waiting for a delivered batch');

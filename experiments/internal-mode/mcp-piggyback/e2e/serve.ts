import { appendFileSync, readFileSync, existsSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { AgentClientPort, AgentStatus } from '../../../../packages/agent-cli/src/cli/types.ts';
import { runCli } from '../../../../packages/agent-cli/src/cli/app.ts';
import { openInbox } from '../../../../packages/agent-cli/src/cli/inbox.ts';
import { MAX_SEND_BYTES } from '../../../../packages/agent-cli/src/cli/send.ts';

// The MCP server Codex starts. It is the product `khala mcp-serve` command
// (runCli, real durable inbox, product result postprocessor and khala_read)
// with two fixture pieces only: a held binding read from the fixture directory
// in place of the not-yet-live connector, and a send port that records the
// deliberate outbound message instead of publishing it. Every JSON-RPC line in
// both directions is tapped into events.jsonl so the verifier can compare the
// server's view with Codex's own rollout.
const fixtureDir = resolve(process.env.KHALA_E2E_DIR ?? '');
if (!process.env.KHALA_E2E_DIR) throw new Error('KHALA_E2E_DIR is required');
const logPath = join(fixtureDir, 'events.jsonl');
const serveId = `${process.pid}-${Date.now()}`;

function log(event: Record<string, unknown>): void {
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), serveId, ...event })}\n`, { mode: 0o600 });
}

function ancestors(): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  let pid = process.ppid;
  for (let depth = 0; depth < 6 && pid > 1; depth += 1) {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      let stdin: string | null = null;
      try { stdin = readlinkSync(`/proc/${pid}/fd/0`); } catch { stdin = null; }
      chain.push({ pid, argv, stdin });
      pid = Number(fields[1]);
    } catch { break; }
  }
  return chain;
}

function currentStatus(): AgentStatus {
  const binding = JSON.parse(readFileSync(join(fixtureDir, 'binding.json'), 'utf8'));
  const connected = !existsSync(join(fixtureDir, 'revoked'));
  return { v: 1, connected, binding: connected ? binding : null, route: 'unknown', sourceCursor: null };
}

const client: AgentClientPort = {
  async connect() { return { kind: 'unavailable' }; },
  async status() { return currentStatus(); },
  async send(input) {
    const eventId = `event-sent-${Date.now()}`;
    log({ event: 'send', clientTxnId: input.clientTxnId, bindingId: input.bindingId, body: input.body, eventId });
    return { kind: 'accepted', clientTxnId: input.clientTxnId, eventId };
  },
};

function lines(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffered = '';
  return chunk => {
    buffered += chunk.toString('utf8');
    let index: number;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (line.trim()) onLine(line);
    }
  };
}

function parse(line: string): unknown {
  try { return JSON.parse(line); } catch { return { unparsed: line }; }
}

const input = new PassThrough();
process.stdin.on('data', lines(line => log({ event: 'rpc_in', message: parse(line) })));
process.stdin.pipe(input);
const tapOut = lines(line => log({ event: 'rpc_out', bytes: Buffer.byteLength(line, 'utf8') + 1, message: parse(line) }));
const output = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    tapOut(chunk);
    process.stdout.write(chunk, callback);
  },
});

const abort = new AbortController();
process.once('SIGTERM', () => abort.abort());
process.once('SIGINT', () => abort.abort());
log({ event: 'serve_start', pid: process.pid, ancestors: ancestors() });
const code = await runCli(['mcp-serve'], {
  client,
  inbox: (bindingId, generation) => openInbox({
    stateDirectory: join(fixtureDir, 'state'), bindingId, generation,
    maxPayloadBytes: MAX_SEND_BYTES, maxSelectionEvents: 32,
  }),
  stdin: input,
  stdout: output,
  stderr: process.stderr,
  signal: abort.signal,
});
log({ event: 'serve_exit', code });
process.exitCode = code;

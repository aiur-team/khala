import type { Readable, Writable } from 'node:stream';
import { CliError, cliErrorCode } from './errors.js';
import type { Inbox, InboxItem } from './inbox.js';
import { MAX_SEND_BYTES, SendService } from './send.js';
import type { AgentClientPort } from './types.js';
import { runMcpServer } from '../mcp/server.js';

export type CliDependencies = Readonly<{
  client: AgentClientPort;
  inbox: (bindingId: string, generation: number) => Promise<Inbox>;
  stdin: Readable; stdout: Writable; stderr: Writable; signal?: AbortSignal;
}>;

export async function runCli(argv: readonly string[], deps: CliDependencies): Promise<number> {
  try {
    const [command, ...args] = argv;
    switch (command) {
      case 'connect': return await connect(args, deps);
      case 'listen': return await listen(args, deps);
      case 'send': return await send(args, deps);
      case 'status': return await status(args, deps);
      case 'mcp-serve': return await mcp(args, deps);
      default: throw new CliError('invalid_arguments');
    }
  } catch (error) {
    await write(deps.stderr, JSON.stringify({ ok: false, error: cliErrorCode(error) }) + '\n');
    return 2;
  }
}

async function connect(args: readonly string[], deps: CliDependencies): Promise<number> {
  if (args.length !== 1 || !validLink(args[0])) throw new CliError('invalid_link');
  const result = await deps.client.connect(args[0]!);
  if (result.kind === 'unavailable') throw new CliError('transport_unavailable');
  if (result.kind === 'refused') { await write(deps.stdout, JSON.stringify({ ok: false, error: result.code }) + '\n'); return 3; }
  await write(deps.stdout, JSON.stringify({ ok: true, binding: result.binding, reused: result.reused }) + '\n');
  return 0;
}

async function send(args: readonly string[], deps: CliDependencies): Promise<number> {
  const bindingId = optionalBinding(args);
  const body = await readStdin(deps.stdin, MAX_SEND_BYTES);
  const result = await new SendService(deps.client).send(body, bindingId);
  await write(deps.stdout, JSON.stringify({ ok: result.kind === 'accepted', ...result }) + '\n');
  return result.kind === 'accepted' ? 0 : result.kind === 'refused' ? 3 : 4;
}

async function listen(args: readonly string[], deps: CliDependencies): Promise<number> {
  const requested = optionalBinding(args);
  const current = await deps.client.status();
  if (!current.binding || !current.connected) throw new CliError('not_connected');
  if (requested !== null && requested !== current.binding.bindingId) throw new CliError('binding_not_held');
  const inbox = await deps.inbox(current.binding.bindingId, current.binding.generation);
  const lock = await inbox.acquireListener();
  try {
    while (!deps.signal?.aborted) {
      const item = await inbox.readNext();
      if (item === null) { await waitForSignal(deps.signal, 50); continue; }
      await write(deps.stdout, renderInboxItem(item) + '\n');
      await inbox.acknowledge(item);
    }
  } finally { await lock.release(); }
  return 0;
}

async function status(args: readonly string[], deps: CliDependencies): Promise<number> {
  if (args.length !== 0) throw new CliError('invalid_arguments');
  const current = await deps.client.status();
  let inbox = null;
  if (current.binding) inbox = await (await deps.inbox(current.binding.bindingId, current.binding.generation)).status();
  await write(deps.stdout, JSON.stringify({ ...current, inbox }) + '\n');
  return 0;
}

async function mcp(args: readonly string[], deps: CliDependencies): Promise<number> {
  if (args.length !== 0) throw new CliError('invalid_arguments');
  await runMcpServer({ input: deps.stdin, output: deps.stdout, send: new SendService(deps.client), signal: deps.signal });
  return 0;
}

function optionalBinding(args: readonly string[]): string | null {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== '--binding' || !validIdentifier(args[1])) throw new CliError('invalid_arguments');
  return args[1]!;
}
function validIdentifier(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,512}$/.test(value);
}
function validLink(value: string | undefined): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.hash === '';
  } catch { return false; }
}
export async function readStdin(input: Readable, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.byteLength;
    if (size > limit) throw new CliError('invalid_input');
    chunks.push(bytes);
  }
  const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  if (body.length === 0 || body.includes('\u0000')) throw new CliError('invalid_input');
  return body;
}
function renderInboxItem(item: InboxItem): string {
  return JSON.stringify({ v: 1, releaseId: item.record.releaseId, bindingId: item.record.bindingId,
    generation: item.record.generation, events: item.record.events, payloadBase64: Buffer.from(item.payload).toString('base64') });
}
function write(stream: Writable, value: string): Promise<void> {
  return new Promise((resolve, reject) => stream.write(value, error => error ? reject(error) : resolve()));
}
function waitForSignal(signal: AbortSignal | undefined, milliseconds: number): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

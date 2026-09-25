import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeSessionBinding, type EventRef, type SessionBinding } from '@khala/contracts/delivery/index';
import { runCli } from './app.js';
import { openInbox, type BatchInbox, type InboxBatch, type InboxConsumer } from './inbox.js';
import { CliError } from './errors.js';
import type { AgentClientPort, InboxDelivery } from './types.js';

const decodedBinding = decodeSessionBinding({
  v: 1, bindingId: 'binding-1', ownerId: 'owner-1', agentParticipantId: 'agent-1', deviceId: 'device-1',
  harness: 'codex', sessionId: 'session-1', generation: 0,
});
if (!decodedBinding.ok) throw new Error('invalid binding fixture');
const BINDING = decodedBinding.value;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function streams(input: string | Buffer = '') {
  const stdin = new PassThrough(); stdin.end(input);
  const stdout = new PassThrough(); const stderr = new PassThrough(); let out = ''; let err = '';
  stdout.on('data', chunk => { out += String(chunk); }); stderr.on('data', chunk => { err += String(chunk); });
  return { stdin, stdout, stderr, output: () => out, error: () => err };
}
function client(overrides: Partial<AgentClientPort> = {}): AgentClientPort {
  return {
    async connect() { return { kind: 'connected', binding: BINDING, reused: false }; },
    async send(input) { return { kind: 'accepted', clientTxnId: input.clientTxnId, eventId: 'event-1' }; },
    async status() { return { v: 1, connected: true, binding: BINDING, route: 'unknown', sourceCursor: 'source-1' }; },
    ...overrides,
  };
}
function unusedInbox(): Promise<BatchInbox> { throw new Error('inbox should not be opened'); }

describe('runCli', () => {
  it('connects with a validated HTTPS link', async () => {
    const io = streams();
    expect(await runCli(['connect', 'https://chat.example/i/abc'], { client: client(), inbox: unusedInbox, ...io })).toBe(0);
    expect(JSON.parse(io.output())).toMatchObject({ ok: true, binding: { bindingId: 'binding-1' } });
  });
  it('rejects malformed links before invoking the client', async () => {
    let called = false; const io = streams();
    expect(await runCli(['connect', 'javascript:alert(1)'], { client: client({ async connect() { called = true; return { kind: 'unavailable' }; } }), inbox: unusedInbox, ...io })).toBe(2);
    expect(called).toBe(false); expect(io.error()).toContain('invalid_link');
  });
  it('reads send content from stdin and never echoes it', async () => {
    const secret = 'message-visible-only-on-stdin'; let observed = ''; const io = streams(secret);
    expect(await runCli(['send', '--binding', 'binding-1'], { client: client({ async send(input) { observed = input.body; return { kind: 'accepted', clientTxnId: input.clientTxnId, eventId: null }; } }), inbox: unusedInbox, ...io })).toBe(0);
    expect(observed).toBe(secret); expect(io.output()).not.toContain(secret); expect(io.error()).not.toContain(secret);
  });
  it('allowlists send output from an injected port', async () => {
    const io = streams('hello');
    const malicious = client({
      async send(input) {
        return { kind: 'accepted', clientTxnId: input.clientTxnId, eventId: null, secret: 'do-not-print' } as never;
      },
    });
    expect(await runCli(['send'], { client: malicious, inbox: unusedInbox, ...io })).toBe(0);
    expect(JSON.parse(io.output())).toMatchObject({ ok: true, kind: 'accepted', eventId: null });
    expect(io.output()).not.toContain('do-not-print');
  });
  it('rejects invalid UTF-8 as invalid input', async () => {
    const io = streams(Buffer.from([0xc3, 0x28]));
    expect(await runCli(['send'], { client: client(), inbox: unusedInbox, ...io })).toBe(2);
    expect(io.error()).toContain('invalid_input');
  });
  it('prints disconnected status without opening an inbox', async () => {
    const io = streams();
    expect(await runCli(['status'], { client: client({ async status() { return { v: 1, connected: false, binding: null, route: 'unavailable', sourceCursor: null }; } }), inbox: unusedInbox, ...io })).toBe(0);
    expect(JSON.parse(io.output())).toMatchObject({ v: 1, connected: false, inbox: null });
  });
  it('fails listen closed when disconnected without opening an inbox', async () => {
    let opened = false;
    const io = streams();
    const inbox = async () => { opened = true; return await unusedInbox(); };
    expect(await runCli(['listen'], {
      client: client({
        async status() { return { v: 1, connected: false, binding: null, route: 'unavailable', sourceCursor: null }; },
      }),
      inbox,
      ...io,
    })).toBe(2);
    expect(io.error()).toContain('not_connected');
    expect(opened).toBe(false);
  });
  it('fails listen closed for a binding not held without opening an inbox', async () => {
    let opened = false;
    const io = streams();
    const inbox = async () => { opened = true; return await unusedInbox(); };
    expect(await runCli(['listen', '--binding', 'binding-2'], { client: client(), inbox, ...io })).toBe(2);
    expect(io.error()).toContain('binding_not_held');
    expect(opened).toBe(false);
  });
  it('fails closed on an invalid status route without printing injected fields', async () => {
    const io = streams();
    const malicious = client({
      async status() {
        return { v: 1, connected: false, binding: null, route: 'secret-route', sourceCursor: null, secret: 'do-not-print' } as never;
      },
    });
    expect(await runCli(['status'], { client: malicious, inbox: unusedInbox, ...io })).toBe(2);
    expect(io.error()).toContain('transport_unavailable');
    expect(io.output() + io.error()).not.toContain('do-not-print');
  });
  it('reports unexpected failures as internal errors', async () => {
    const io = streams();
    expect(await runCli(['status'], {
      client: client({ async status() { throw new Error('unexpected'); } }),
      inbox: unusedInbox,
      ...io,
    })).toBe(2);
    expect(JSON.parse(io.error())).toEqual({ ok: false, error: 'internal_error' });
    expect(io.error()).not.toContain('unexpected');
  });
  it('prints and then acknowledges one released item', async () => {
    const io = streams(); const abort = new AbortController(); let acknowledged = false; io.stdout.once('data', () => abort.abort());
    const item = { record: { v: 1 as const, releaseId: 'release-1', bindingId: BINDING.bindingId, generation: 0,
      events: [], payloadDigest: `sha256:${'0'.repeat(64)}`, payloadBase64: 'cmVsZWFzZWQ=', receivedAt: '2026-09-19T12:00:00Z' },
      payload: new TextEncoder().encode('released'), nextOffset: 10 };
    let first = true;
    const inbox: BatchInbox = { async enqueue() { return 'appended' as const; }, async acquireListener() { return { async readBatch() { return null; }, async release() {} }; },
      async readNext() { if (first) { first = false; return item; } return null; },
      async acknowledge() { acknowledged = true; },
      async status() { return { bindingId: BINDING.bindingId, generation: 0, cursor: { v: 1 as const, offset: 0, releaseId: null } }; } };
    expect(await runCli(['listen'], { client: client(), inbox: async () => inbox, signal: abort.signal, ...io })).toBe(0);
    expect(acknowledged).toBe(true); expect(JSON.parse(io.output())).toMatchObject({ releaseId: 'release-1', payloadBase64: 'cmVsZWFzZWQ=' });
  });

  it('fails mcp-serve closed while disconnected before opening an inbox', async () => {
    let opened = false;
    const io = streams();

    expect(await runCli(['mcp-serve'], {
      client: client({
        async status() { return { v: 1, connected: false, binding: null, route: 'unavailable', sourceCursor: null }; },
      }),
      inbox: async () => { opened = true; return await unusedInbox(); },
      ...io,
    })).toBe(2);

    expect(opened).toBe(false);
    expect(JSON.parse(io.error())).toEqual({ ok: false, error: 'not_connected' });
  });

  it('opens the startup binding generation and acquires one consumer for the full MCP lifetime', async () => {
    const io = streams(mcpCalls(1, 2));
    const release = vi.fn(async () => undefined);
    const readBatch = vi.fn(async () => mcpBatch('batch-token', 'release-1', '["released"]'));
    const acquireListener = vi.fn(async (): Promise<InboxConsumer> => ({ readBatch, release }));
    const opened: Array<[string, number]> = [];
    let statusCalls = 0;

    expect(await runCli(['mcp-serve'], {
      client: client({ async status() { statusCalls += 1; return connectedStatus(BINDING); } }),
      inbox: async (bindingId, generation) => {
        opened.push([bindingId, generation]);
        return fakeBatchInbox(acquireListener);
      },
      ...io,
    })).toBe(0);

    expect(opened).toEqual([[BINDING.bindingId, BINDING.generation]]);
    expect(acquireListener).toHaveBeenCalledOnce();
    expect(readBatch).toHaveBeenCalledTimes(2);
    expect(statusCalls).toBe(5);
    expect(release).toHaveBeenCalledOnce();
    expect(mcpResponses(io.output()).map(response => response.result.content)).toEqual([
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('["released"]') })]),
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('["released"]') })]),
    ]);
  });

  it('reports listener contention and does not start the MCP server', async () => {
    const io = streams(mcpCalls(1));
    const acquireListener = vi.fn(async (): Promise<InboxConsumer> => { throw new CliError('listener_busy'); });

    expect(await runCli(['mcp-serve'], {
      client: client(), inbox: async () => fakeBatchInbox(acquireListener), ...io,
    })).toBe(2);

    expect(acquireListener).toHaveBeenCalledOnce();
    expect(io.output()).toBe('');
    expect(JSON.parse(io.error())).toEqual({ ok: false, error: 'listener_busy' });
  });

  it('releases the MCP listener and replays the durable batch when writing a response fails', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-mcp-app-'));
    temporaryDirectories.push(root);
    const inboxOptions = {
      stateDirectory: path.join(root, 'state'), bindingId: BINDING.bindingId, generation: BINDING.generation,
      maxPayloadBytes: 4096, maxSelectionEvents: 8,
    };
    const initial = await openInbox(inboxOptions);
    await initial.enqueue(delivery('release-1', '["released"]'));
    const stdin = Readable.from([mcpCalls(1)]);
    const stdout = new CapturingFailingWritable();
    const stderr = new PassThrough();
    let error = '';
    stderr.on('data', chunk => { error += String(chunk); });
    stdout.on('error', () => undefined);
    let released = false;

    expect(await runCli(['mcp-serve'], {
      client: client(),
      inbox: async () => {
        const durable = await openInbox(inboxOptions);
        return {
          enqueue: input => durable.enqueue(input),
          acquireListener: async () => {
            const consumer = await durable.acquireListener();
            return {
              readBatch: input => consumer.readBatch(input),
              release: async () => { released = true; await consumer.release(); },
            };
          },
          readNext: () => durable.readNext(),
          acknowledge: item => durable.acknowledge(item),
          status: () => durable.status(),
        };
      },
      stdin, stdout, stderr,
    })).toBe(2);

    expect(released).toBe(true);
    expect(JSON.parse(error)).toEqual({ ok: false, error: 'internal_error' });
    const attemptedBatch = batchText(mcpResponses(stdout.output())[0]);
    const attemptedToken = batchToken(attemptedBatch);

    const restarted = await runMcpSession(async () => openInbox(inboxOptions), [mcpCall(2)]);
    const replayedBatch = batchText(restarted[0]);
    expect(replayedBatch).toBe(attemptedBatch);
    expect(batchToken(replayedBatch)).toBe(attemptedToken);
  });

  it('releases the MCP listener when abort interrupts a blocked stdout write', async () => {
    const abort = new AbortController();
    const stdout = new BlockingWritable();
    const stderr = new PassThrough();
    const release = vi.fn(async () => undefined);
    const running = runCli(['mcp-serve'], {
      client: client(),
      inbox: async () => fakeBatchInbox(async () => ({ async readBatch() { return null; }, release })),
      stdin: Readable.from([mcpCalls(1, 2)]), stdout, stderr, signal: abort.signal,
    });
    await stdout.waitForWrite();

    abort.abort();
    await expect(running).resolves.toBe(0);
    expect(release).toHaveBeenCalledOnce();
    expect(stdout.writes).toBe(1);
    stdout.completeWrite();
  });

  it.each([
    ['revocation', { ...connectedStatus(BINDING), binding: null }],
    ['disconnect', { ...connectedStatus(BINDING), connected: false }],
    ['replacement binding', connectedStatus(replacementBinding())],
    ['generation drift', connectedStatus({ ...BINDING, generation: BINDING.generation + 1 })],
    ['invalid public status', { ...connectedStatus(BINDING), route: 'injected-route' }],
  ] as const)('keeps primary MCP results while %s suppresses future batches', async (_name, driftedStatus) => {
    const io = streams(mcpCalls(1, 2));
    let statusCalls = 0;
    const statuses: unknown[] = [
      connectedStatus(BINDING), connectedStatus(BINDING), connectedStatus(BINDING), driftedStatus,
    ];
    const readBatch = vi.fn(async () => mcpBatch('batch-token', 'release-1', '["released"]'));

    expect(await runCli(['mcp-serve'], {
      client: client({ async status() { return statuses[Math.min(statusCalls++, statuses.length - 1)] as never; } }),
      inbox: async () => fakeBatchInbox(async () => ({ readBatch, async release() {} })),
      ...io,
    })).toBe(0);

    const responses = mcpResponses(io.output());
    expect(responses).toHaveLength(2);
    expect(responses[0]?.result.content).toHaveLength(2);
    expect(responses[1]?.result.content).toHaveLength(1);
    expect(responses[1]?.result.structuredContent).toMatchObject({ kind: 'accepted' });
    expect(readBatch).toHaveBeenCalledOnce();
    expect(io.error()).toBe('');
  });

  it('replays an identical durable batch across restart, then advances one exact next-call token without host release tracking', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-mcp-app-'));
    temporaryDirectories.push(root);
    const inboxOptions = {
      stateDirectory: path.join(root, 'state'), bindingId: BINDING.bindingId, generation: BINDING.generation,
      maxPayloadBytes: 4096, maxSelectionEvents: 8,
    };
    const initial = await openInbox(inboxOptions);
    await initial.enqueue(delivery('release-1', '["first"]'));

    const first = await runMcpSession(async () => openInbox(inboxOptions), [mcpCall(1)]);
    const firstBatch = batchText(first[0]);
    const firstToken = batchToken(firstBatch);

    const reopened = await openInbox(inboxOptions);
    await reopened.enqueue(delivery('release-2', '["second"]'));
    const restarted = await runMcpSession(async () => openInbox(inboxOptions), [
      mcpCall(2),
      mcpCall(3, firstToken),
      mcpCall(4, firstToken),
    ]);

    expect(batchText(restarted[0])).toBe(firstBatch);
    const advanced = batchText(restarted[1]);
    expect(advanced).toContain('["second"]');
    expect(batchToken(advanced)).not.toBe(firstToken);
    expect(batchText(restarted[2])).toBe(advanced);
  });
});

type McpResponse = Readonly<{
  result: Readonly<{
    content: readonly Readonly<{ type: string; text: string }>[];
    structuredContent: Readonly<Record<string, unknown>>;
  }>;
}>;

class CapturingFailingWritable extends Writable {
  #output = '';
  output(): string { return this.#output; }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.#output += chunk.toString();
    callback(new Error('write failed'));
  }
}

class BlockingWritable extends Writable {
  readonly #callbacks: Array<(error?: Error | null) => void> = [];
  readonly #waiters: Array<() => void> = [];
  writes = 0;
  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes += 1;
    this.#callbacks.push(callback);
    this.#waiters.splice(0).forEach(resolve => resolve());
  }
  async waitForWrite(): Promise<void> {
    while (this.writes === 0) await new Promise<void>(resolve => this.#waiters.push(resolve));
  }
  completeWrite(): void { this.#callbacks.shift()?.(); }
}

function connectedStatus(binding: SessionBinding) {
  return { v: 1 as const, connected: true, binding, route: 'unknown' as const, sourceCursor: 'source-1' };
}

function replacementBinding(): SessionBinding {
  const decoded = decodeSessionBinding({ ...BINDING, bindingId: 'binding-2' });
  if (!decoded.ok) throw new Error('invalid replacement binding fixture');
  return decoded.value;
}

function fakeBatchInbox(acquireListener: BatchInbox['acquireListener']): BatchInbox {
  return {
    async enqueue() { return 'appended'; },
    acquireListener,
    async readNext() { return null; },
    async acknowledge() {},
    async status() {
      return { bindingId: BINDING.bindingId, generation: BINDING.generation,
        cursor: { v: 1, offset: 0, releaseId: null } };
    },
  };
}

function mcpCall(id: number, ackBatchToken?: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: {
    name: 'khala_send', arguments: { message: `message-${id}`, ...(ackBatchToken === undefined ? {} : { ackBatchToken }) },
  } };
}

function mcpCalls(...ids: number[]): string {
  return ids.map(id => JSON.stringify(mcpCall(id))).join('\n') + '\n';
}

function mcpResponses(output: string): McpResponse[] {
  return output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as McpResponse);
}

function mcpBatch(token: string, releaseId: string, canonical: string): InboxBatch {
  const released = delivery(releaseId, canonical);
  return { token, items: [{
    record: { ...released, payloadBase64: Buffer.from(released.payload).toString('base64') },
    payload: released.payload,
    nextOffset: 1,
  }] };
}

function delivery(releaseId: string, canonical: string): InboxDelivery {
  const payload = new TextEncoder().encode(canonical);
  const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const event: EventRef = {
    v: 1,
    roomId: 'room-1' as EventRef['roomId'],
    eventId: `event-${releaseId}` as EventRef['eventId'],
    authorParticipantId: 'participant-1' as EventRef['authorParticipantId'],
    authorDeviceId: 'device-1' as EventRef['authorDeviceId'],
    contentDigest: digest(new TextEncoder().encode(`source-${releaseId}`)),
  };
  return {
    v: 1, releaseId, bindingId: BINDING.bindingId, generation: BINDING.generation, events: [event],
    payloadDigest: digest(payload), payload, receivedAt: '2026-09-24T12:00:00Z',
  };
}

async function runMcpSession(
  inbox: () => Promise<BatchInbox>,
  calls: readonly Record<string, unknown>[],
): Promise<McpResponse[]> {
  const io = streams(calls.map(call => JSON.stringify(call)).join('\n') + '\n');
  expect(await runCli(['mcp-serve'], { client: client(), inbox, ...io })).toBe(0);
  expect(io.error()).toBe('');
  return mcpResponses(io.output());
}

function batchText(response: McpResponse | undefined): string {
  const text = response?.result.content.at(-1)?.text;
  if (typeof text !== 'string' || !text.startsWith('<khala-channel-batch-v1>')) throw new Error('missing batch text');
  return text;
}

function batchToken(batch: string): string {
  const token = batch.match(/batchToken: ([^\n]+)/)?.[1];
  if (token === undefined) throw new Error('missing batch token');
  return token;
}

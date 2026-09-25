import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { BindingId, EventRef } from '@khala/contracts/delivery/index';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openInbox, type InboxBatch, type InboxConsumer } from '../cli/inbox.js';
import { SendService } from '../cli/send.js';
import type { AgentClientPort, InboxDelivery } from '../cli/types.js';
import { postprocessMcpResult } from './result-postprocessor.js';
import { runMcpServer, type McpServerOptions } from './server.js';

type Request = Readonly<Record<string, unknown>>;
type Response = Readonly<{
  jsonrpc: '2.0';
  id: string | number | null;
  result?: Readonly<{
    protocolVersion?: string;
    tools?: readonly Readonly<{ name: string; description: string; inputSchema: Readonly<{ additionalProperties: boolean }> }>[];
    content?: readonly Readonly<{ type: string; text?: string }>[];
    structuredContent?: Readonly<Record<string, unknown>>;
    isError?: boolean;
  }>;
  error?: Readonly<{ code: number; message: string }>;
}>;

const roots: string[] = [];
const consumers: InboxConsumer[] = [];
const bindingId = 'binding-1' as BindingId;
const textEncoder = new TextEncoder();

afterEach(async () => {
  for (const consumer of consumers.splice(0).reverse()) await consumer.release().catch(() => undefined);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('MCP server', () => {
  it('initializes, lists exactly khala_send, pings and sends through SendService', async () => {
    const client = fakeClient();
    const responses = await exchange(client, [
      request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test' } }),
      request(2, 'ping', {}),
      request(3, 'tools/list', {}),
      request(4, 'tools/call', { name: 'khala_send', arguments: { message: 'hello', bindingId: 'binding-1' } }),
    ]);

    expect(responses[0]).toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26' } });
    expect(responses[1]).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    expect(responses[2]).toMatchObject({
      result: { tools: [{
        name: 'khala_send',
        description: expect.stringMatching(/Khala channel.*exact batchToken.*releaseId.*solely to acknowledge/),
        inputSchema: {
          additionalProperties: false,
          properties: {
            ackBatchToken: {
              type: 'string',
              description: expect.stringMatching(/Exact opaque batchToken.*independently intended Khala call/),
            },
          },
        },
      }] },
    });
    expect(client.sent).toEqual([{ bindingId: 'binding-1', body: 'hello' }]);
    expect(responses[3]).toMatchObject({ id: 4, result: { structuredContent: { kind: 'accepted', eventId: 'event-1' } } });
  });

  it('reports a held-binding refusal without echoing message content', async () => {
    const secret = 'do not repeat this secret';
    const client = fakeClient();
    client.onSend = async input => ({ kind: 'refused', code: 'binding_not_held', clientTxnId: input.clientTxnId });

    const [response] = await exchange(client, [
      request(1, 'tools/call', { name: 'khala_send', arguments: { message: secret, bindingId: 'other-binding' } }),
    ]);

    expect(response).toMatchObject({
      id: 1,
      result: { isError: true, structuredContent: { kind: 'refused', code: 'binding_not_held' } },
    });
    expect(JSON.stringify(response)).not.toContain(secret);
  });

  it('refuses unknown tools and unknown fields before calling the send port', async () => {
    const client = fakeClient();
    const responses = await exchange(client, [
      request(1, 'tools/call', { name: 'other_tool', arguments: { message: 'secret-a' } }),
      request(2, 'tools/call', { name: 'khala_send', arguments: { message: 'secret-b', extra: true } }),
      { ...request(3, 'tools/list', {}), extra: true },
    ]);

    expect(responses.map(response => response.error?.code)).toEqual([-32602, -32602, -32600]);
    expect(client.sent).toEqual([]);
    expect(JSON.stringify(responses)).not.toContain('secret-a');
    expect(JSON.stringify(responses)).not.toContain('secret-b');
  });

  it('returns invalid params for an empty message without stopping the server', async () => {
    const client = fakeClient();
    const responses = await exchange(client, [
      request(1, 'tools/call', { name: 'khala_send', arguments: { message: '' } }),
      request(2, 'ping', {}),
    ]);
    expect(responses).toMatchObject([{ id: 1, error: { code: -32602 } }, { id: 2, result: {} }]);
    expect(client.sent).toEqual([]);
  });

  it('does not answer notifications and never exposes thrown error messages', async () => {
    const secret = 'transport leaked the message';
    const client = fakeClient();
    client.onSend = async () => { throw new Error(secret); };
    const responses = await exchange(client, [
      { jsonrpc: '2.0', method: 'ping', params: {} },
      request(1, 'tools/call', { name: 'khala_send', arguments: { message: 'payload-secret' } }),
    ]);

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      id: 1,
      result: { isError: true, structuredContent: { kind: 'outcome_unknown', clientTxnId: expect.any(String) } },
    });
    expect(JSON.stringify(responses)).not.toContain(secret);
    expect(JSON.stringify(responses)).not.toContain('payload-secret');
  });

  it('uses the supported protocol version when a client requests another version', async () => {
    const [response] = await exchange(fakeClient(), [
      request(1, 'initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'test' } }),
    ]);
    expect(response).toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26' } });
  });

  it('decodes a multibyte message split across input chunks', async () => {
    const client = fakeClient();
    const encoded = Buffer.from(`${JSON.stringify(request(1, 'tools/call', {
      name: 'khala_send', arguments: { message: 'hello 🌍' },
    }))}\n`);
    const split = encoded.indexOf(Buffer.from('🌍')) + 1;
    const responses = await exchangeChunks(client, [encoded.subarray(0, split), encoded.subarray(split)]);
    expect(responses[0]).toMatchObject({ id: 1, result: { structuredContent: { kind: 'accepted' } } });
    expect(client.sent).toEqual([{ bindingId: null, body: 'hello 🌍' }]);
  });

  it('stops an idle server when aborted', async () => {
    const input = new Readable({ read() {} });
    const output = new WritableCapture();
    const abort = new AbortController();
    const running = runMcpServer({ input, output, send: new SendService(fakeClient()), signal: abort.signal });
    abort.abort();
    await expect(running).resolves.toBeUndefined();
  });

  it('bounds an unterminated frame and resumes at the next newline', async () => {
    const client = fakeClient();
    const oversized = `{"jsonrpc":"2.0","id":1,"method":"ping","pad":"${'x'.repeat(90_000)}`;
    const output = new WritableCapture();
    await runMcpServer({
      input: Readable.from([oversized, `\n${JSON.stringify(request(2, 'ping', {}))}\n`]),
      output,
      send: new SendService(client),
    });
    const responses = output.lines();
    expect(responses).toMatchObject([{ error: { code: -32600 } }, { id: 2, result: {} }]);
  });

  it('strips the shared acknowledgement, postprocesses every send outcome, and advances only an exact real-inbox token', async () => {
    const inbox = await testInbox();
    await inbox.enqueue(delivery('release-1', '["released-first"]'));
    const consumer = await inbox.acquireListener();
    consumers.push(consumer);
    const postprocessResult = vi.fn(async input => postprocessMcpResult({
      ...input,
      consumer,
      isCurrentBinding: async () => true,
    }));
    const client = fakeClient();
    const sentCanary = 'submitted-send-canary';

    const [accepted] = await exchangeWithOptions(client, [
      request(10, 'tools/call', {
        name: 'khala_send', arguments: { message: sentCanary, ackBatchToken: 'foreign-token' },
      }),
    ], { postprocessResult });
    const firstBatch = batchText(accepted);
    const token = firstBatch.match(/batchToken: ([^\n]+)/)?.[1];
    expect(token).toEqual(expect.any(String));
    expect(firstBatch).toContain('["released-first"]');
    expect(accepted?.result?.content).toHaveLength(2);
    expect(JSON.parse(accepted?.result?.content?.[0]?.text ?? '')).toEqual(accepted?.result?.structuredContent);
    expect(JSON.stringify(accepted)).not.toContain(sentCanary);
    expect(client.sent).toEqual([{ bindingId: null, body: sentCanary }]);

    client.onSend = async input => ({
      kind: 'refused' as const, code: 'binding_not_held' as const, clientTxnId: input.clientTxnId,
    });
    const [refused] = await exchangeWithOptions(client, [
      request(11, 'tools/call', {
        name: 'khala_send', arguments: { message: 'refused-send', ackBatchToken: `${token}-partial` },
      }),
    ], { postprocessResult });
    expect(refused).toMatchObject({ result: { isError: true, structuredContent: { kind: 'refused' } } });
    expect(refused?.result?.content).toHaveLength(2);
    expect(JSON.parse(refused?.result?.content?.[0]?.text ?? '')).toEqual(refused?.result?.structuredContent);
    expect(batchText(refused)).toBe(firstBatch);

    client.onSend = async () => { throw new Error('outcome-secret'); };
    const [unknown] = await exchangeWithOptions(client, [
      request(12, 'tools/call', {
        name: 'khala_send', arguments: { message: 'unknown-send', ackBatchToken: 'stale-token' },
      }),
    ], { postprocessResult });
    expect(unknown).toMatchObject({ result: { isError: true, structuredContent: { kind: 'outcome_unknown' } } });
    expect(unknown?.result?.content).toHaveLength(2);
    expect(JSON.parse(unknown?.result?.content?.[0]?.text ?? '')).toEqual(unknown?.result?.structuredContent);
    expect(batchText(unknown)).toBe(firstBatch);
    expect(JSON.stringify(unknown)).not.toContain('outcome-secret');

    await inbox.enqueue(delivery('release-2', '["pending-second-canary"]'));
    const [replay] = await exchangeWithOptions(client, [
      request(13, 'tools/call', { name: 'khala_send', arguments: { message: 'replay-send' } }),
    ], { postprocessResult });
    expect(batchText(replay)).toBe(firstBatch);
    expect(JSON.stringify(replay)).not.toContain('pending-second-canary');

    const [advanced] = await exchangeWithOptions(client, [
      request(14, 'tools/call', {
        name: 'khala_send', arguments: { message: 'advance-send', ackBatchToken: token },
      }),
    ], { postprocessResult });
    expect(batchText(advanced)).toContain('["pending-second-canary"]');
    expect(batchText(advanced)).not.toBe(firstBatch);
    expect(postprocessResult).toHaveBeenCalledTimes(5);
    expect(postprocessResult.mock.calls.map(([input]) => input.acknowledgeToken)).toEqual([
      'foreign-token', `${token}-partial`, 'stale-token', undefined, token,
    ]);
    expect(JSON.stringify([accepted, refused, unknown, replay, advanced])).not.toContain('refused-send');
    expect(JSON.stringify([accepted, refused, unknown, replay, advanced])).not.toContain('unknown-send');
  });

  it('rejects a non-string acknowledgement before send or postprocessing', async () => {
    const client = fakeClient();
    const postprocessResult = vi.fn();
    const [response] = await exchangeWithOptions(client, [
      request(20, 'tools/call', {
        name: 'khala_send', arguments: { message: 'never-sent', ackBatchToken: 7 },
      }),
    ], { postprocessResult });

    expect(response).toMatchObject({ id: 20, error: { code: -32602 } });
    expect(client.sent).toEqual([]);
    expect(postprocessResult).not.toHaveBeenCalled();
  });

  it('never postprocesses notifications or ineligible protocol paths', async () => {
    const client = fakeClient();
    const postprocessResult = vi.fn();
    const chunks = [
      '{bad json}\n',
      `${JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: {
        name: 'khala_send', arguments: { message: 'notification-send', ackBatchToken: 'opaque' },
      } })}\n`,
      ...[
        request(21, 'initialize', {}),
        request(22, 'ping', {}),
        request(23, 'tools/list', {}),
        request(24, 'tools/call', { name: 'unknown', arguments: {} }),
        request(25, 'tools/call', { name: 'khala_send', arguments: { message: 5 } }),
        { ...request(26, 'ping', {}), extra: true },
      ].map(item => `${JSON.stringify(item)}\n`),
    ];

    const responses = await exchangeChunksWithOptions(client, chunks, { postprocessResult });

    expect(responses).toHaveLength(7);
    expect(client.sent).toEqual([{ bindingId: null, body: 'notification-send' }]);
    expect(postprocessResult).not.toHaveBeenCalled();
  });

  it('allows an injected future preselected-batch composition exactly once', async () => {
    const selected = preselectedBatch('future-token', 'release-future', '["future-pull"]');
    const postprocessResult = vi.fn(async input => postprocessMcpResult({
      ...input,
      preselectedBatch: selected,
      isCurrentBinding: async () => true,
    }));

    const [response] = await exchangeWithOptions(fakeClient(), [
      request(30, 'tools/call', { name: 'khala_send', arguments: { message: 'hello' } }),
    ], { postprocessResult });

    expect(postprocessResult).toHaveBeenCalledOnce();
    expect(response?.result?.content).toHaveLength(2);
    expect(batchText(response).match(/batchToken: future-token/g)).toHaveLength(1);
    expect(batchText(response).match(/canonicalReleaseJson:\n\["future-pull"\]/g)).toHaveLength(1);
  });

  it('waits for a completed response write before processing a pipelined second call', async () => {
    const client = fakeClient();
    const output = new BlockingWritable();
    const postprocessResult = vi.fn(async input => input.primaryResult);
    const input = Readable.from([[
      request(40, 'tools/call', { name: 'khala_send', arguments: { message: 'first' } }),
      request(41, 'tools/call', { name: 'khala_send', arguments: { message: 'second' } }),
    ].map(item => JSON.stringify(item)).join('\n') + '\n']);

    const running = runMcpServer({ input, output, send: new SendService(client), postprocessResult });
    await output.waitForWrite();
    expect(client.sent.map(item => item.body)).toEqual(['first']);
    expect(postprocessResult).toHaveBeenCalledOnce();

    output.completeWrite();
    await output.waitForWrite(2);
    output.completeWrite();
    await running;
    expect(client.sent.map(item => item.body)).toEqual(['first', 'second']);
    expect(postprocessResult).toHaveBeenCalledTimes(2);
  });

  it('aborts a blocked response write without processing queued work or destroying caller-owned streams', async () => {
    const client = fakeClient();
    const output = new BlockingWritable();
    let supplied = false;
    const input = new Readable({
      read() {
        if (supplied) return;
        supplied = true;
        this.push([
          request(50, 'tools/call', { name: 'khala_send', arguments: { message: 'first' } }),
          request(51, 'tools/call', { name: 'khala_send', arguments: { message: 'must-not-run' } }),
        ].map(item => JSON.stringify(item)).join('\n') + '\n');
      },
    });
    const abort = new AbortController();
    const postprocessResult = vi.fn(async postprocessInput => postprocessInput.primaryResult);
    const running = runMcpServer({
      input, output, send: new SendService(client), signal: abort.signal, postprocessResult,
    });
    await output.waitForWrite();

    abort.abort();
    await expect(running).resolves.toBeUndefined();
    expect(client.sent.map(item => item.body)).toEqual(['first']);
    expect(postprocessResult).toHaveBeenCalledOnce();
    expect(input.destroyed).toBe(false);
    expect(output.destroyed).toBe(false);
    output.completeWrite();
  });
});

class WritableCapture extends Writable {
  value = '';
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.value += chunk.toString();
    callback();
  }
  lines(): Response[] { return this.value.trim().split('\n').map(line => JSON.parse(line) as Response); }
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
  async waitForWrite(count = 1): Promise<void> {
    while (this.writes < count) await new Promise<void>(resolve => this.#waiters.push(resolve));
  }
  completeWrite(): void { this.#callbacks.shift()?.(); }
}

function request(id: number, method: string, params?: unknown): Request {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

function fakeClient(): AgentClientPort & {
  sent: Array<{ bindingId: string | null; body: string }>;
  onSend: AgentClientPort['send'];
} {
  const client = {
    sent: [] as Array<{ bindingId: string | null; body: string }>,
    onSend: async (input: Parameters<AgentClientPort['send']>[0]) => ({
      kind: 'accepted' as const, clientTxnId: input.clientTxnId, eventId: 'event-1',
    }),
    async connect() { return { kind: 'unavailable' as const }; },
    async status() {
      return { v: 1 as const, connected: false, binding: null, route: 'unknown' as const, sourceCursor: null };
    },
    async send(input: Parameters<AgentClientPort['send']>[0]) {
      client.sent.push({ bindingId: input.bindingId, body: input.body });
      return client.onSend(input);
    },
  };
  return client;
}

async function exchange(client: AgentClientPort, requests: readonly Request[]): Promise<Response[]> {
  return exchangeChunks(client, requests.map(item => `${JSON.stringify(item)}\n`));
}

async function exchangeChunks(client: AgentClientPort, chunks: readonly (string | Buffer)[]): Promise<Response[]> {
  return exchangeChunksWithOptions(client, chunks, {});
}

async function exchangeWithOptions(
  client: AgentClientPort,
  requests: readonly Request[],
  options: Pick<McpServerOptions, 'postprocessResult'>,
): Promise<Response[]> {
  return exchangeChunksWithOptions(client, requests.map(item => `${JSON.stringify(item)}\n`), options);
}

async function exchangeChunksWithOptions(
  client: AgentClientPort,
  chunks: readonly (string | Buffer)[],
  options: Pick<McpServerOptions, 'postprocessResult'>,
): Promise<Response[]> {
  let stdout = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      stdout += chunk.toString();
      callback();
    },
  });
  await runMcpServer({
    input: Readable.from(chunks),
    output,
    send: new SendService(client),
    ...options,
  });
  return stdout.trim().length === 0
    ? []
    : stdout.trim().split('\n').map(line => JSON.parse(line) as Response);
}

async function testInbox() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-mcp-server-'));
  roots.push(root);
  return openInbox({
    stateDirectory: path.join(root, 'state'),
    bindingId,
    generation: 3,
    maxPayloadBytes: 4096,
    maxSelectionEvents: 8,
  });
}

function delivery(releaseId: string, canonical: string): InboxDelivery {
  const payload = textEncoder.encode(canonical);
  const event: EventRef = {
    v: 1,
    roomId: 'room-1' as EventRef['roomId'],
    eventId: `event-${releaseId}` as EventRef['eventId'],
    authorParticipantId: 'participant-1' as EventRef['authorParticipantId'],
    authorDeviceId: 'device-1' as EventRef['authorDeviceId'],
    contentDigest: digest(textEncoder.encode(`source-${releaseId}`)),
  };
  return {
    v: 1,
    releaseId,
    bindingId,
    generation: 3,
    events: [event],
    payloadDigest: digest(payload),
    payload,
    receivedAt: '2026-09-24T12:00:00Z',
  };
}

function preselectedBatch(token: string, releaseId: string, canonical: string): InboxBatch {
  const selected = delivery(releaseId, canonical);
  return {
    token,
    items: [{ record: {
      v: selected.v,
      releaseId: selected.releaseId,
      bindingId: selected.bindingId,
      generation: selected.generation,
      events: selected.events,
      payloadDigest: selected.payloadDigest,
      payloadBase64: Buffer.from(selected.payload).toString('base64'),
      receivedAt: selected.receivedAt,
    }, payload: selected.payload, nextOffset: 1 }],
  };
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function batchText(response: Response | undefined): string {
  const result = response?.result as { content?: readonly { type?: unknown; text?: unknown }[] } | undefined;
  const text = result?.content?.at(-1)?.text;
  if (typeof text !== 'string') throw new TypeError('missing batch text');
  return text;
}

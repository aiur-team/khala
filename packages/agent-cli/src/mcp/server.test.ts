import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { SendService } from '../cli/send.js';
import type { AgentClientPort } from '../cli/types.js';
import { runMcpServer } from './server.js';

type Request = Readonly<Record<string, unknown>>;
type Response = Readonly<{
  jsonrpc: '2.0';
  id: string | number | null;
  result?: Readonly<{
    protocolVersion?: string;
    tools?: readonly Readonly<{ name: string; inputSchema: Readonly<{ additionalProperties: boolean }> }>[];
    structuredContent?: Readonly<Record<string, unknown>>;
    isError?: boolean;
  }>;
  error?: Readonly<{ code: number; message: string }>;
}>;

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
      result: { tools: [{ name: 'khala_send', inputSchema: { additionalProperties: false } }] },
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
});

class WritableCapture extends Writable {
  value = '';
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.value += chunk.toString();
    callback();
  }
  lines(): Response[] { return this.value.trim().split('\n').map(line => JSON.parse(line) as Response); }
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
  });
  return stdout.trim().length === 0
    ? []
    : stdout.trim().split('\n').map(line => JSON.parse(line) as Response);
}

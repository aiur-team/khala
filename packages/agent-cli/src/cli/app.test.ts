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
import { renderReadOutput } from './read.js';
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
    async listChannels() { return { kind: 'unavailable' }; },
    async listAgents() { return { kind: 'unavailable' }; },
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
  it('reads a durable batch, replays without acknowledgement, then advances with the exact token', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-read-app-'));
    temporaryDirectories.push(root);
    const options = {
      stateDirectory: path.join(root, 'state'), bindingId: BINDING.bindingId, generation: BINDING.generation,
      maxPayloadBytes: 4096, maxSelectionEvents: 8,
    };
    const seeded = await openInbox(options);
    await seeded.enqueue(delivery('release-1', '["first"]'));

    const firstIo = streams();
    expect(await runCli(['read'], { client: client(), inbox: async () => openInbox(options), ...firstIo })).toBe(0);
    const first = firstIo.output().trim();
    const token = batchToken(first);
    expect(first).toContain('["first"]');

    const replayIo = streams();
    expect(await runCli(['read'], { client: client(), inbox: async () => openInbox(options), ...replayIo })).toBe(0);
    expect(replayIo.output().trim()).toBe(first);

    const partialIo = streams();
    expect(await runCli(['read', '--ack', `${token}-partial`], {
      client: client(), inbox: async () => openInbox(options), ...partialIo,
    })).toBe(0);
    expect(partialIo.output().trim()).toBe(first);

    const reopened = await openInbox(options);
    await reopened.enqueue(delivery('release-2', '["second"]'));
    const nextIo = streams();
    expect(await runCli(['read', '--ack', token], {
      client: client(), inbox: async () => openInbox(options), ...nextIo,
    })).toBe(0);
    expect(nextIo.output()).toContain('["second"]');
    const nextToken = batchToken(nextIo.output());
    expect(nextToken).not.toBe(token);

    const emptyIo = streams();
    expect(await runCli(['read', '--ack', nextToken], {
      client: client(), inbox: async () => openInbox(options), ...emptyIo,
    })).toBe(0);
    expect(JSON.parse(emptyIo.output())).toEqual({ ok: true, kind: 'empty' });
  });

  it('prints typed empty after exact acknowledgement and always releases the CLI consumer', async () => {
    const io = streams();
    const release = vi.fn(async () => undefined);
    const readBatch = vi.fn(async () => null);
    const acquireListener = vi.fn(async (): Promise<InboxConsumer> => ({ readBatch, release }));

    expect(await runCli(['read', '--binding', BINDING.bindingId, '--ack', 'prior-token'], {
      client: client(), inbox: async () => fakeBatchInbox(acquireListener), ...io,
    })).toBe(0);
    expect(JSON.parse(io.output())).toEqual({ ok: true, kind: 'empty' });
    expect(readBatch).toHaveBeenCalledWith({ maxBytes: 65_536, acknowledgeToken: 'prior-token', explicitRead: true });
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases the CLI consumer when writing the selected batch fails', async () => {
    const io = streams();
    const stdout = new CapturingFailingWritable();
    stdout.on('error', () => undefined);
    const release = vi.fn(async () => undefined);
    const readBatch = vi.fn(async () => mcpBatch('batch-token', 'release-1', '["selected"]'));

    expect(await runCli(['read'], {
      client: client(),
      inbox: async () => fakeBatchInbox(async () => ({ readBatch, release })),
      ...io,
      stdout,
    })).toBe(2);

    expect(readBatch).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(io.error()).toContain('internal_error');
  });

  it('refuses malformed or foreign read arguments before opening an inbox', async () => {
    for (const args of [['read', '--ack'], ['read', '--binding', 'binding-2']] as const) {
      let opened = false;
      const io = streams();
      expect(await runCli(args, {
        client: client(), inbox: async () => { opened = true; return await unusedInbox(); }, ...io,
      })).toBe(2);
      expect(opened).toBe(false);
      expect(io.output()).toBe('');
    }
  });

  it('fails read closed while disconnected and reports contention that outlasts the bounded wait', async () => {
    const disconnectedIo = streams();
    let opened = false;
    expect(await runCli(['read'], {
      client: client({
        async status() { return { v: 1, connected: false, binding: null, route: 'unavailable', sourceCursor: null }; },
      }),
      inbox: async () => { opened = true; return await unusedInbox(); },
      ...disconnectedIo,
    })).toBe(2);
    expect(opened).toBe(false);
    expect(disconnectedIo.error()).toContain('not_connected');

    const contentionIo = streams();
    expect(await runCli(['read'], {
      client: client(),
      inbox: async () => fakeBatchInbox(async () => { throw new CliError('listener_busy'); }),
      ...contentionIo,
    })).toBe(2);
    expect(contentionIo.output()).toBe('');
    expect(contentionIo.error()).toContain('listener_busy');
  }, 10_000);

  it('releases the CLI consumer and suppresses payload when the binding drifts after selection', async () => {
    const io = streams();
    const release = vi.fn(async () => undefined);
    const readBatch = vi.fn(async () => mcpBatch('batch-token', 'release-1', '["secret"]'));
    let statusCalls = 0;
    const statuses = [connectedStatus(BINDING), connectedStatus(BINDING), connectedStatus(replacementBinding())];

    expect(await runCli(['read'], {
      client: client({ async status() { return statuses[Math.min(statusCalls++, statuses.length - 1)]!; } }),
      inbox: async () => fakeBatchInbox(async () => ({ readBatch, release })),
      ...io,
    })).toBe(2);
    expect(readBatch).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(io.output() + io.error()).not.toContain('secret');
    expect(io.error()).toContain('binding_not_held');
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
    const inbox: BatchInbox = { async enqueue() { return 'appended' as const; }, async acquireListener() { return { async readBatch() { return null; }, async nextWake() {}, async release() {} }; },
      async notifyListener() { return 'unavailable' as const; },
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

  it('opens the startup binding generation and holds the listener only for each selection', async () => {
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
    expect(acquireListener).toHaveBeenCalledTimes(2);
    expect(readBatch).toHaveBeenCalledTimes(2);
    expect(statusCalls).toBe(5);
    expect(release).toHaveBeenCalledTimes(2);
    expect(mcpResponses(io.output()).map(response => response.result.content)).toEqual([
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('["released"]') })]),
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('["released"]') })]),
    ]);
  });

  it('uses one call-scoped consumer for khala_read and appends its selected batch once', async () => {
    const io = streams(`${JSON.stringify({
      jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'khala_read', arguments: {} },
    })}\n`);
    const release = vi.fn(async () => undefined);
    const selected = mcpBatch('read-token', 'release-read', '["read-body"]');
    const readBatch = vi.fn(async () => selected);

    expect(await runCli(['mcp-serve'], {
      client: client(),
      inbox: async () => fakeBatchInbox(async () => ({ readBatch, release })),
      ...io,
    })).toBe(0);

    const [response] = mcpResponses(io.output());
    expect(readBatch).toHaveBeenCalledOnce();
    expect(response?.result.structuredContent).toEqual({ kind: 'batch' });
    expect(response?.result.content).toHaveLength(2);
    expect(batchText(response).match(/batchToken: read-token/g)).toHaveLength(1);
    expect(batchText(response)).toBe(renderReadOutput({ kind: 'batch', batch: selected }));
    expect(release).toHaveBeenCalledOnce();
  });

  it('returns a typed refusal when the binding drifts after explicit-read selection but before composition', async () => {
    const io = streams([
      JSON.stringify(mcpReadCall(10)),
      JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping', params: {} }),
    ].join('\n') + '\n');
    const selected = mcpBatch('secret-token', 'release-secret', '["secret-body"]');
    const statuses = [
      connectedStatus(BINDING), connectedStatus(BINDING), connectedStatus(BINDING),
      connectedStatus(replacementBinding()),
    ];
    let statusCalls = 0;

    expect(await runCli(['mcp-serve'], {
      client: client({
        async status() { return statuses[Math.min(statusCalls++, statuses.length - 1)]!; },
      }),
      inbox: async () => fakeBatchInbox(async () => ({
        async readBatch() { return selected; }, async release() {},
      })),
      ...io,
    })).toBe(0);

    const responses = mcpResponses(io.output());
    expect(responses).toMatchObject([
      { result: { isError: true, structuredContent: { kind: 'refused', code: 'binding_not_held' } } },
      { result: {} },
    ]);
    expect(io.output()).not.toContain('secret-token');
    expect(io.output()).not.toContain('secret-body');
  });

  it('waits for a briefly busy listener, such as a native hook, instead of refusing the MCP call', async () => {
    const io = streams(`${JSON.stringify(mcpReadCall(1))}\n`);
    const readBatch = vi.fn(async () => mcpBatch('batch-token', 'release-1', '["released"]'));
    const release = vi.fn(async () => undefined);
    const acquireListener = vi.fn<() => Promise<InboxConsumer>>()
      .mockRejectedValueOnce(new CliError('listener_busy'))
      .mockResolvedValue({ readBatch, release });

    expect(await runCli(['mcp-serve'], {
      client: client(), inbox: async () => fakeBatchInbox(acquireListener), ...io,
    })).toBe(0);

    expect(acquireListener).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
    expect(mcpResponses(io.output())[0]?.result.structuredContent).toEqual({ kind: 'batch' });
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
    const stdin = Readable.from([`${JSON.stringify(mcpReadCall(1))}\n`]);
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
              nextWake: () => consumer.nextWake(),
              release: async () => { released = true; await consumer.release(); },
            };
          },
          notifyListener: reason => durable.notifyListener(reason),
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

    const restarted = await runMcpSession(async () => openInbox(inboxOptions), [mcpReadCall(2)]);
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
    ['owner drift', connectedStatus(replacementBinding({ bindingId: BINDING.bindingId, ownerId: 'owner-2' }))],
    ['agent drift', connectedStatus(replacementBinding({ bindingId: BINDING.bindingId, agentParticipantId: 'agent-2' }))],
    ['device drift', connectedStatus(replacementBinding({ bindingId: BINDING.bindingId, deviceId: 'device-2' }))],
    ['harness drift', connectedStatus(replacementBinding({ bindingId: BINDING.bindingId, harness: 'other-harness' }))],
    ['session drift', connectedStatus(replacementBinding({ bindingId: BINDING.bindingId, sessionId: 'session-2' }))],
    ['generation drift', connectedStatus({ ...BINDING, generation: BINDING.generation + 1 })],
    ['invalid public status', { ...connectedStatus(BINDING), route: 'injected-route' }],
  ] as const)('keeps primary MCP results while %s suppresses future batches', async (name, driftedStatus) => {
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
    const code = name === 'invalid public status' ? 'transport_unavailable' : 'binding_not_held';
    expect(io.error()).toBe(`${JSON.stringify({ ok: false, warning: 'batch_suppressed', stage: 'status', code })}\n`);
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

    const first = await runMcpSession(async () => openInbox(inboxOptions), [mcpReadCall(1)]);
    const firstBatch = batchText(first[0]);
    const firstToken = batchToken(firstBatch);

    const reopened = await openInbox(inboxOptions);
    await reopened.enqueue(delivery('release-2', '["second"]'));
    const restarted = await runMcpSession(async () => openInbox(inboxOptions), [
      mcpReadCall(2),
      mcpReadCall(3, firstToken),
      mcpReadCall(4, firstToken),
    ]);

    expect(batchText(restarted[0])).toBe(firstBatch);
    const advanced = batchText(restarted[1]);
    expect(advanced).toContain('["second"]');
    expect(batchToken(advanced)).not.toBe(firstToken);
    expect(batchText(restarted[2])).toBe(advanced);
  });

  it('shares read-token acknowledgement across khala_read and khala_send without selecting twice', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-mcp-read-app-'));
    temporaryDirectories.push(root);
    const inboxOptions = {
      stateDirectory: path.join(root, 'state'), bindingId: BINDING.bindingId, generation: BINDING.generation,
      maxPayloadBytes: 4096, maxSelectionEvents: 8,
    };
    const initial = await openInbox(inboxOptions);
    await initial.enqueue(delivery('release-1', '["first-read"]'));

    const [first] = await runMcpSession(async () => openInbox(inboxOptions), [mcpReadCall(70)]);
    const firstBatch = batchText(first);
    const firstToken = batchToken(firstBatch);

    const reopened = await openInbox(inboxOptions);
    await reopened.enqueue(delivery('release-2', '["second-read"]'));
    const responses = await runMcpSession(async () => openInbox(inboxOptions), [
      mcpReadCall(71),
      mcpReadCall(72, firstToken),
      mcpCall(73, firstToken),
    ]);

    expect(batchText(responses[0])).toBe(firstBatch);
    const secondBatch = batchText(responses[1]);
    expect(secondBatch).toContain('["second-read"]');
    expect(batchToken(secondBatch)).not.toBe(firstToken);
    expect(batchText(responses[2])).toBe(secondBatch);
    expect(responses[1]?.result.content).toHaveLength(2);
  });

  it('shares send-token acknowledgement with the next khala_read call', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-mcp-send-read-app-'));
    temporaryDirectories.push(root);
    const inboxOptions = {
      stateDirectory: path.join(root, 'state'), bindingId: BINDING.bindingId, generation: BINDING.generation,
      maxPayloadBytes: 4096, maxSelectionEvents: 8,
    };
    const initial = await openInbox(inboxOptions);
    await initial.enqueue(delivery('release-1', '["first-send"]'));

    const [first] = await runMcpSession(async () => openInbox(inboxOptions), [mcpCall(80)]);
    const firstBatch = batchText(first);
    const firstToken = batchToken(firstBatch);

    const reopened = await openInbox(inboxOptions);
    await reopened.enqueue(delivery('release-2', '["second-read"]'));
    const [advanced, replay] = await runMcpSession(async () => openInbox(inboxOptions), [
      mcpReadCall(81, firstToken),
      mcpReadCall(82, firstToken),
    ]);

    expect(batchText(advanced)).toContain('["second-read"]');
    expect(batchToken(batchText(advanced))).not.toBe(firstToken);
    expect(batchText(replay)).toBe(batchText(advanced));
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

function replacementBinding(overrides: Record<string, unknown> = { bindingId: 'binding-2' }): SessionBinding {
  const decoded = decodeSessionBinding({ ...BINDING, ...overrides });
  if (!decoded.ok) throw new Error('invalid replacement binding fixture');
  return decoded.value;
}

function fakeBatchInbox(acquireListener: () => Promise<InboxConsumer>): BatchInbox {
  return {
    async enqueue() { return 'appended'; },
    async acquireListener() { return { ...await acquireListener(), async nextWake() {} }; },
    async notifyListener() { return 'unavailable'; },
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

function mcpReadCall(id: number, ackBatchToken?: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: {
    name: 'khala_read', arguments: { ...(ackBatchToken === undefined ? {} : { ackBatchToken }) },
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

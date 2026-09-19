import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { decodeSessionBinding } from '@khala/contracts/delivery/index';
import { runCli } from './app.js';
import type { Inbox } from './inbox.js';
import type { AgentClientPort } from './types.js';

const decodedBinding = decodeSessionBinding({
  v: 1, bindingId: 'binding-1', ownerId: 'owner-1', agentParticipantId: 'agent-1', deviceId: 'device-1',
  harness: 'codex', sessionId: 'session-1', generation: 0,
});
if (!decodedBinding.ok) throw new Error('invalid binding fixture');
const BINDING = decodedBinding.value;
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
function unusedInbox(): Promise<Inbox> { throw new Error('inbox should not be opened'); }

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
    const inbox: Inbox = { async enqueue() { return 'appended' as const; }, async acquireListener() { return { async release() {} }; },
      async readNext() { if (first) { first = false; return item; } return null; },
      async acknowledge() { acknowledged = true; },
      async status() { return { bindingId: BINDING.bindingId, generation: 0, cursor: { v: 1 as const, offset: 0, releaseId: null } }; } };
    expect(await runCli(['listen'], { client: client(), inbox: async () => inbox, signal: abort.signal, ...io })).toBe(0);
    expect(acknowledged).toBe(true); expect(JSON.parse(io.output())).toMatchObject({ releaseId: 'release-1', payloadBase64: 'cmVsZWFzZWQ=' });
  });
});

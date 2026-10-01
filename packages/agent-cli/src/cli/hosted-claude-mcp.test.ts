import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { decodeSessionBinding, type EventRef } from '@khala/contracts/delivery/index';
import { runCli } from './app.js';
import { openInbox } from './inbox.js';
import type { CliDependencies } from './types.js';
import { createUnavailableClient } from '../composition/unavailable.js';
import type { ClaudeSessionClient } from '../composition/claude-session-http.js';
import { hasProductionBinding } from '@khala/connector-app/composition/production';
import { claudeProofKeyLabelInspection } from '../composition/hosted-session-inspection.js';
import { runHook } from '../../../claude-plugin/hooks/lib/runtime.mjs';
import { claudeHostedHookPaths } from '../composition/claude-hosted-hook-bridge.js';

const SESSION = 'native-claude-571';
const PROOF_SESSION = `agent_${'A'.repeat(43)}`;
const binding = (() => {
  const decoded = decodeSessionBinding({ v: 1, bindingId: 'binding-571', ownerId: 'owner-571',
    agentParticipantId: 'agent-571', deviceId: 'DEVICE571', harness: 'proof-key',
    sessionId: PROOF_SESSION, generation: 2 });
  if (!decoded.ok) throw new Error('invalid test binding');
  return decoded.value;
})();

function request(id: number, name: string, args: Record<string, unknown> = {}) {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`;
}

async function serve(factory: NonNullable<CliDependencies['hostedSession']>, calls: Iterable<string> | AsyncIterable<string>, sessionId = SESSION,
  prejoinRoot?: string, onStderr?: (chunk: string) => void, stateHome?: string,
  onOutput?: (output: string) => void) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  stdout.on('data', chunk => { output += String(chunk); onOutput?.(output); });
  stderr.on('data', chunk => { onStderr?.(String(chunk)); });
  const code = await runCli(['mcp-serve'], {
    client: createUnavailableClient(),
    inbox: async () => { throw new Error('unbound inbox'); },
    stdin: Readable.from(calls), stdout, stderr,
    env: { KHALA_MCP_HARNESS: 'claude', CLAUDE_CODE_SESSION_ID: sessionId,
      XDG_STATE_HOME: stateHome ?? path.join(os.tmpdir(), 'khala-test-empty-state') },
    hostedSession: factory,
    ...(prejoinRoot ? {
      hostedBindingPresent: session => hasProductionBinding(prejoinRoot, { ...session, workdir: process.cwd() }),
      claude: { status: async () => ({ kind: 'refused', code: 'session_not_bound' }) } as unknown as ClaudeSessionClient,
    } : {}),
  });
  expect(code).toBe(0);
  return output.trim().split('\n').map(line => JSON.parse(line) as {
    result: { structuredContent: Record<string, unknown>; isError?: boolean };
  });
}

describe('hosted native Claude MCP', () => {
  it('routes mode reads and writes through the saved hosted session', async () => {
    const read = vi.fn(async () => ({ ok: true as const, view: { requested: 'sync', effective: 'sync',
      effectiveReason: null, version: 4, support: Object.fromEntries(['steer', 'sync', 'async'].map(mode =>
        [mode, { status: mode === 'async' ? 'unknown' : 'proven', route: 'native', testedVersion: null,
          evidenceRef: null, evidenceRevision: null, reason: null }])) } }));
    const set = vi.fn(async (input: { commandId: string }) => ({ commandId: input.commandId,
      outcome: 'applied', requested: 'steer', effective: 'steer', reason: null, version: 5 }));
    const factory: NonNullable<CliDependencies['hostedSession']> = async () => ({
      client: { ...createUnavailableClient(), storedSessionId: () => PROOF_SESSION,
        async status() { return { v: 1, connected: true, binding, route: 'manual_mcp', sourceCursor: null }; },
        listeningModeControl: { read, set } as never },
      inbox: async () => { throw new Error('mode must not open inbox'); }, async close() {},
    });
    const result = await serve(factory, [request(1, 'khala_mode_get'),
      request(2, 'khala_mode_set', { requested: 'steer', expectedVersion: 4 })]);
    expect(result[0]?.result.structuredContent).toMatchObject({ kind: 'mode', version: 4,
      support: { steer: 'proven', sync: 'proven', async: 'unproven' } });
    expect(result[1]?.result.structuredContent).toMatchObject({ kind: 'applied', version: 5 });
    expect(read).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ requested: 'steer', expectedVersion: 4 }));
  });

  it('refuses hosted mode calls when the saved proof-key session differs', async () => {
    const read = vi.fn();
    const set = vi.fn();
    const factory: NonNullable<CliDependencies['hostedSession']> = async () => ({
      client: { ...createUnavailableClient(), storedSessionId: () => 'agent_other',
        async status() { return { v: 1, connected: true, binding, route: 'manual_mcp', sourceCursor: null }; },
        listeningModeControl: { read, set } as never },
      inbox: async () => { throw new Error('wrong session'); }, async close() {},
    });
    const result = await serve(factory, [request(1, 'khala_mode_get'),
      request(2, 'khala_mode_set', { requested: 'steer', expectedVersion: 0 })]);
    expect(result.map(reply => reply.result.structuredContent)).toEqual(Array(2).fill({ kind: 'refused', code: 'not_connected' }));
    expect(read).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it.each(['khala_mode_get', 'khala_mode_set'])('does not report %s across a generation change', async name => {
    let checks = 0;
    const read = vi.fn(async () => ({ ok: true as const, view: { requested: 'sync', effective: null,
      effectiveReason: 'support_unknown', version: 1, support: Object.fromEntries(['steer', 'sync', 'async'].map(mode =>
        [mode, { status: 'unknown', route: 'native', testedVersion: null,
          evidenceRef: null, evidenceRevision: null, reason: null }])) } }));
    const set = vi.fn(async (input: { commandId: string }) => ({ commandId: input.commandId,
      outcome: 'applied', requested: 'steer', effective: null, reason: 'support_unknown', version: 2 }));
    const factory: NonNullable<CliDependencies['hostedSession']> = async () => ({
      client: { ...createUnavailableClient(), storedSessionId: () => PROOF_SESSION,
        async status() { return { v: 1, connected: true,
          binding: checks++ === 0 ? binding : { ...binding, generation: binding.generation + 1 },
          route: 'manual_mcp', sourceCursor: null }; },
        listeningModeControl: { read, set } as never },
      inbox: async () => { throw new Error('mode must not read inbox'); }, async close() {},
    });
    const result = await serve(factory, [request(1, name,
      name === 'khala_mode_set' ? { requested: 'steer', expectedVersion: 1 } : {})]);
    expect(result[0]?.result.structuredContent).toEqual(name === 'khala_mode_set'
      ? { kind: 'outcome_unknown' } : { kind: 'refused', code: 'binding_not_held' });
  });

  it('reports an unknown mode-write outcome if the post-write binding check fails', async () => {
    let checks = 0;
    const set = vi.fn(async (input: { commandId: string }) => ({ commandId: input.commandId,
      outcome: 'applied', requested: 'steer', effective: null, reason: 'support_unknown', version: 2 }));
    const factory: NonNullable<CliDependencies['hostedSession']> = async () => ({
      client: { ...createUnavailableClient(), storedSessionId: () => PROOF_SESSION,
        async status() {
          if (checks++ > 0) throw new Error('private post-write status failure');
          return { v: 1, connected: true, binding, route: 'manual_mcp', sourceCursor: null };
        }, listeningModeControl: { read: vi.fn(), set } as never },
      inbox: async () => { throw new Error('mode must not read inbox'); }, async close() {},
    });
    const result = await serve(factory, [request(1, 'khala_mode_set', { requested: 'steer', expectedVersion: 1 })]);
    expect(result[0]?.result.structuredContent).toEqual({ kind: 'outcome_unknown' });
    expect(set).toHaveBeenCalledOnce();
  });

  it('reoffers a persisted hook batch after MCP restart and ACKs only from a later exact-generation call', async () => {
    const sessionId = randomUUID();
    const stateHome = process.env.TMPDIR ?? os.tmpdir();
    const inboxRoot = fs.mkdtempSync(path.join(stateHome, 'khala-717-inbox-'));
    const bytes = new TextEncoder().encode('{"body":"owner selected hosted release"}');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const recorded: string[][] = [];
    const open = () => openInbox({ stateDirectory: inboxRoot, bindingId: binding.bindingId,
      generation: binding.generation, maxPayloadBytes: 4096, maxSelectionEvents: 8,
      recordAcknowledgement: async value => { recorded.push([...value.releaseIds]); } });
    const inbox = await open();
    await inbox.enqueue({ v: 1, releaseId: 'release-717', bindingId: binding.bindingId,
      generation: binding.generation, events: [{ v: 1, roomId: 'room-717' as EventRef['roomId'],
        eventId: 'event-717' as EventRef['eventId'], authorParticipantId: 'sender-717' as EventRef['authorParticipantId'],
        authorDeviceId: 'device-717' as EventRef['authorDeviceId'], contentDigest: digest }],
      payloadDigest: digest, payload: bytes, receivedAt: '2026-10-01T00:00:00Z' });
    const second = new TextEncoder().encode('{"body":"second ordered release"}');
    const secondDigest = `sha256:${createHash('sha256').update(second).digest('hex')}`;
    await inbox.enqueue({ v: 1, releaseId: 'release-718', bindingId: binding.bindingId,
      generation: binding.generation, events: [{ v: 1, roomId: 'room-717' as EventRef['roomId'],
        eventId: 'event-718' as EventRef['eventId'], authorParticipantId: 'sender-717' as EventRef['authorParticipantId'],
        authorDeviceId: 'device-717' as EventRef['authorDeviceId'], contentDigest: secondDigest }],
      payloadDigest: secondDigest, payload: second, receivedAt: '2026-10-01T00:00:01Z' });
    let effective: 'steer' | 'sync' | null = 'steer';
    let connected = true;
    const factory: NonNullable<CliDependencies['hostedSession']> = async () => ({
      client: { ...createUnavailableClient(), storedSessionId: () => PROOF_SESSION,
        async status() { return connected
          ? { v: 1, connected: true, binding, route: 'manual_mcp', sourceCursor: null }
          : { v: 1, connected: false, binding: null, route: 'unavailable', sourceCursor: null }; },
        async listeningMode() { return { v: 1, bindingId: binding.bindingId, generation: binding.generation, effective }; } },
      inbox: async () => open(), async close() {},
    });
    let stdin = new PassThrough(); let stdout = new PassThrough(); let stderr = new PassThrough();
    let output = '';
    stdout.on('data', chunk => { output += String(chunk); });
    let serving = runCli(['mcp-serve'], {
      client: createUnavailableClient(), inbox: async () => { throw new Error('not local'); },
      stdin, stdout, stderr, env: { KHALA_MCP_HARNESS: 'claude', CLAUDE_CODE_SESSION_ID: sessionId,
        XDG_STATE_HOME: stateHome }, hostedSession: factory, hostedBindingPresent: async () => true,
    });
    const responses = async (count: number) => {
      const complete = () => output.split('\n').slice(0, -1).filter(Boolean);
      for (let i = 0; i < 200 && complete().length < count; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return complete().map(line => JSON.parse(line) as { result: { structuredContent: Record<string, unknown> } });
    };
    const hookDeps = { hostedRoot: path.join(stateHome, 'khala'), stateRoot: inboxRoot,
      terminalKeyPath: path.join(inboxRoot, 'no-key'), bound: async () => false,
      khala: async () => { throw new Error('internal route'); }, sleep: async () => {},
      now: () => Date.now(), nonce: () => 'unused', parentAlive: () => true };
    try {
      const descriptor = claudeHostedHookPaths(path.join(stateHome, 'khala'), sessionId).descriptor;
      for (let i = 0; i < 100 && !fs.existsSync(descriptor); i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(fs.existsSync(descriptor)).toBe(true);
      const hook = await runHook('post-tool-use', JSON.stringify({ hook_event_name: 'PostToolUse', session_id: sessionId }), hookDeps);
      expect(hook.stdout).toContain('owner selected hosted release');
      expect(hook.stdout.indexOf('owner selected hosted release')).toBeLessThan(hook.stdout.indexOf('second ordered release'));
      const receipt = /Khala hosted hook receipt: ([A-Za-z0-9_-]{32})/u.exec(hook.stdout)?.[1];
      expect(receipt).toBeDefined();
      expect(recorded).toEqual([]);
      stdin.write(request(2, 'khala_hook_receipt', { receipt: 'A'.repeat(32) }));
      expect((await responses(1))[0]?.result.structuredContent).toMatchObject({ kind: 'refused', code: 'stale_receipt' });
      expect(recorded).toEqual([]);
      stdin.write(request(3, 'khala_hook_receipt', { receipt }));
      expect((await responses(2))[1]?.result.structuredContent).toMatchObject({ kind: 'acknowledged',
        bindingId: binding.bindingId, generation: binding.generation, releaseIds: ['release-717', 'release-718'], boundary: 'post_tool_use' });
      expect(recorded).toEqual([['release-717', 'release-718']]);
      stdin.write(request(4, 'khala_hook_receipt', { receipt }));
      expect((await responses(3))[2]?.result.structuredContent).toMatchObject({ kind: 'refused', code: 'stale_receipt' });
      stdin.write(request(5, 'khala_status'));
      expect((await responses(4))[3]?.result.structuredContent).toEqual({ kind: 'status', connected: true });
      const syncBytes = new TextEncoder().encode('{"body":"owner selected sync release"}');
      const syncDigest = `sha256:${createHash('sha256').update(syncBytes).digest('hex')}`;
      await inbox.enqueue({ v: 1, releaseId: 'release-719', bindingId: binding.bindingId,
        generation: binding.generation, events: [{ v: 1, roomId: 'room-717' as EventRef['roomId'],
          eventId: 'event-719' as EventRef['eventId'], authorParticipantId: 'sender-717' as EventRef['authorParticipantId'],
          authorDeviceId: 'device-717' as EventRef['authorDeviceId'], contentDigest: syncDigest }],
        payloadDigest: syncDigest, payload: syncBytes, receivedAt: '2026-10-01T00:00:02Z' });
      effective = 'sync';
      const stopped = await runHook('stop', JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId }), hookDeps);
      const stopReason = JSON.parse(stopped.stdout) as { decision: string; reason: string };
      expect(stopReason.decision).toBe('block');
      expect(stopReason.reason).toContain('owner selected sync release');
      expect(recorded).toEqual([['release-717', 'release-718']]);
      const syncReceipt = /Khala hosted hook receipt: ([A-Za-z0-9_-]{32})/u.exec(stopReason.reason)?.[1];
      expect(syncReceipt).toBeDefined();
      const repeatedStop = await runHook('stop', JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId }), hookDeps);
      expect((JSON.parse(repeatedStop.stdout) as { reason: string }).reason).toBe(stopReason.reason);
      expect(recorded).toEqual([['release-717', 'release-718']]);
      // The real inbox persists its offered scope while the MCP process loses
      // the pending nonce. A fresh process must reoffer that same batch.
      stdin.end();
      await serving;
      expect(recorded).toEqual([['release-717', 'release-718']]);
      stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
      output = '';
      stdout.on('data', chunk => { output += String(chunk); });
      serving = runCli(['mcp-serve'], {
        client: createUnavailableClient(), inbox: async () => { throw new Error('not local'); },
        stdin, stdout, stderr, env: { KHALA_MCP_HARNESS: 'claude', CLAUDE_CODE_SESSION_ID: sessionId,
          XDG_STATE_HOME: stateHome }, hostedSession: factory, hostedBindingPresent: async () => true,
      });
      for (let i = 0; i < 100 && !fs.existsSync(descriptor); i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(fs.existsSync(descriptor)).toBe(true);
      stdin.write(request(6, 'khala_hook_receipt', { receipt: syncReceipt }));
      expect((await responses(1))[0]?.result.structuredContent).toMatchObject({ kind: 'refused', code: 'stale_receipt' });
      expect(recorded).toEqual([['release-717', 'release-718']]);
      const resumedStop = await runHook('stop', JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId }), hookDeps);
      const resumedReason = (JSON.parse(resumedStop.stdout) as { reason: string }).reason;
      expect(resumedReason).toContain('owner selected sync release');
      const resumedReceipt = /Khala hosted hook receipt: ([A-Za-z0-9_-]{32})/u.exec(resumedReason)?.[1];
      expect(resumedReceipt).toBeDefined();
      expect(resumedReceipt).not.toBe(syncReceipt);
      expect(recorded).toEqual([['release-717', 'release-718']]);
      effective = null; // Owner pauses Sync before the model can return this nonce.
      stdin.write(request(7, 'khala_hook_receipt', { receipt: resumedReceipt }));
      expect((await responses(2))[1]?.result.structuredContent).toMatchObject({ kind: 'refused', code: 'stale_receipt' });
      expect((await runHook('stop', JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId }), hookDeps)).stdout).toBe('');
      expect(recorded).toEqual([['release-717', 'release-718']]);
      effective = 'sync';
      const afterPause = await runHook('stop', JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId }), hookDeps);
      const pauseReceipt = /Khala hosted hook receipt: ([A-Za-z0-9_-]{32})/u.exec(afterPause.stdout)?.[1];
      expect(pauseReceipt).toBeDefined();
      connected = false; // Revoked binding cannot commit even with its old nonce.
      stdin.write(request(8, 'khala_hook_receipt', { receipt: pauseReceipt }));
      expect((await responses(3))[2]?.result.structuredContent).toMatchObject({ kind: 'refused', code: 'stale_receipt' });
      expect((await runHook('stop', JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId }), hookDeps)).stdout).toBe('');
      expect(recorded).toEqual([['release-717', 'release-718']]);
      connected = true;
      const finalStop = await runHook('stop', JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId }), hookDeps);
      const finalReceipt = /Khala hosted hook receipt: ([A-Za-z0-9_-]{32})/u.exec(finalStop.stdout)?.[1];
      expect(finalReceipt).toBeDefined();
      expect(finalReceipt).not.toBe(pauseReceipt);
      expect(recorded).toEqual([['release-717', 'release-718']]);
      stdin.write(request(9, 'khala_hook_receipt', { receipt: finalReceipt }));
      expect((await responses(4))[3]?.result.structuredContent).toMatchObject({ kind: 'acknowledged',
        bindingId: binding.bindingId, generation: binding.generation, releaseIds: ['release-719'], boundary: 'stop' });
      expect(recorded).toEqual([['release-717', 'release-718'], ['release-719']]);
      stdin.write(request(10, 'khala_hook_receipt', { receipt: finalReceipt }));
      expect((await responses(5))[4]?.result.structuredContent).toMatchObject({ kind: 'refused', code: 'stale_receipt' });
      expect(recorded).toEqual([['release-717', 'release-718'], ['release-719']]);
      effective = null;
      expect((await runHook('post-tool-use', JSON.stringify({ hook_event_name: 'PostToolUse', session_id: sessionId }), hookDeps)).stdout).toBe('');
    } finally {
      stdin.end();
      await serving;
      fs.rmSync(inboxRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it('keeps PATH-only Claude versions unsupported without dropping the session label', async () => {
    const claim = { harness: 'claude', sessionId: SESSION, workdir: process.cwd() };
    const inspected = await claudeProofKeyLabelInspection({ session: claim, workdir: claim.workdir,
      readVersion: async () => null }).inspect(claim);
    expect(inspected).toMatchObject({ kind: 'verified', session: { sessionId: SESSION },
      capabilities: { support: 'unsupported', acknowledgement: 'unknown' } });
    const current = await claudeProofKeyLabelInspection({ session: claim, workdir: claim.workdir,
      readVersion: async () => '2.1.286' }).inspect(claim);
    expect(current).toMatchObject({ kind: 'verified', session: { sessionId: SESSION },
      capabilities: { version: 'unknown', support: 'unsupported', acknowledgement: 'unknown' } });
  });

  it('keeps the public refusal generic while reporting a fixed local readiness code', async () => {
    const diagnostics: string[] = [];
    const factory: NonNullable<CliDependencies['hostedSession']> = async () => ({
      client: { ...createUnavailableClient(), storedSessionId: () => PROOF_SESSION,
        async status() { return { v: 1, connected: false, binding: null, route: 'unavailable', sourceCursor: null,
          readiness: { phase: 'degraded', errorCode: 'subscription_offline', prerequisites: {
            storage: 'ready', device: 'ready', bootstrap: 'ready', subscription: 'offline',
            controls: 'blocked', harness: 'unknown', dispatch: 'blocked', review: 'blocked', recovery: 'unknown',
          } } } as const; } },
      inbox: async () => { throw new Error('unbound'); }, async close() {},
    });
    const results = await serve(factory, [request(1, 'khala_status')], SESSION, undefined,
      chunk => diagnostics.push(chunk));
    expect(results[0]?.result.structuredContent).toEqual({ kind: 'refused', code: 'not_connected' });
    expect(diagnostics.join('')).toBe('{"component":"hosted_session","stage":"connector_unready",'
      + '"result":"unavailable","errorCode":"subscription_offline"}\n');
  });

  it('reports a fixed session mismatch without exposing either session identifier', async () => {
    const diagnostics: string[] = [];
    const factory: NonNullable<CliDependencies['hostedSession']> = async () => ({
      client: { ...createUnavailableClient(), storedSessionId: () => 'private-current-session',
        async status() { return { v: 1, connected: true, binding,
          route: 'manual_mcp', sourceCursor: null }; } },
      inbox: async () => { throw new Error('unbound'); }, async close() {},
    });
    const results = await serve(factory, [request(1, 'khala_status')], SESSION, undefined,
      chunk => diagnostics.push(chunk));
    expect(results[0]?.result.structuredContent).toEqual({ kind: 'refused', code: 'not_connected' });
    expect(diagnostics.join('')).toBe('{"component":"hosted_session","stage":"session_mismatch",'
      + '"result":"unavailable"}\n');
  });

  it('reports a hosted session open failure without logging private exception details', async () => {
    const diagnostics: string[] = [];
    const factory: NonNullable<CliDependencies['hostedSession']> = async () => {
      throw new Error('private session label and credential');
    };
    const result = await serve(factory, [request(1, 'khala_request_channel_access', {
      target: 'https://khala.aiur.team/join/inviteRef123', operationId: 'same-operation',
    })], SESSION, undefined, chunk => diagnostics.push(chunk));
    expect(result[0]?.result.structuredContent).toMatchObject({ ok: false, error: 'unavailable',
      operationId: 'same-operation', next: 'reuse_operation_id' });
    expect(diagnostics.join('')).toBe('{"component":"hosted_session","stage":"open","result":"unavailable"}\n');
  });

  it('uses hosted discovery and access before a binding file exists', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-prejoin-'));
    try {
      expect(await hasProductionBinding(root, { harness: 'claude', sessionId: SESSION,
        workdir: process.cwd() })).toBe(false);
      const requestAccess = vi.fn(async (input: { operationId: string }) => ({ kind: 'status' as const,
        status: { v: 1, operationId: input.operationId, outcome: 'pending_owner' } }));
      const accessStatus = vi.fn(async (input: { operationId: string }) => ({ kind: 'status' as const,
        status: { v: 1, operationId: input.operationId, outcome: 'pending_owner' } }));
      const listChannels = vi.fn(async () => ({ kind: 'unavailable' as const }));
      const factory: NonNullable<CliDependencies['hostedSession']> = async () => ({
        client: { ...createUnavailableClient(), requestChannelAccess: requestAccess,
          channelAccessStatus: accessStatus, listChannels },
        inbox: async () => { throw new Error('prejoin must not open an inbox'); }, async close() {},
      });
      const result = await serve(factory, [
        request(1, 'khala_request_channel_access', { target: 'https://khala.aiur.team/channels/room-571' }),
        request(2, 'khala_channel_access_status', { operationId: 'operation-571' }),
        request(3, 'khala_list_channels'), request(4, 'khala_status'), request(5, 'khala_read'),
      ], SESSION, root);
      expect(result[0]?.result.structuredContent).toMatchObject({ ok: true, outcome: 'pending_owner' });
      expect(requestAccess).toHaveBeenCalledOnce();
      expect(result[1]?.result.structuredContent).toMatchObject({ ok: true, outcome: 'pending_owner' });
      expect(accessStatus).toHaveBeenCalledOnce();
      expect(listChannels).toHaveBeenCalledOnce();
      expect(result[3]?.result.structuredContent).toEqual({ kind: 'refused', code: 'not_connected' });
      expect(result[4]?.result.structuredContent).toEqual({ kind: 'refused', code: 'not_connected' });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('scopes default hosted access operations to each Claude session', async () => {
    const operations: string[] = [];
    const factory: NonNullable<CliDependencies['hostedSession']> = async () => ({
      client: { ...createUnavailableClient(), async requestChannelAccess(input) {
        operations.push(input.operationId);
        return { kind: 'status', status: { v: 1, operationId: input.operationId, outcome: 'pending_owner' } };
      } },
      inbox: async () => { throw new Error('unbound'); }, async close() {},
    });
    const call = request(1, 'khala_request_channel_access', { target: 'https://khala.aiur.team/channels/room-571' });
    await serve(factory, [call], SESSION);
    await serve(factory, [call], 'other-claude-571');
    expect(operations).toHaveLength(2);
    expect(operations[0]).not.toBe(operations[1]);
  });

  it('reads and sends only after approval through the held proof-key binding, including after restart', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-claude-hosted-'));
    try {
      const receipts: string[][] = [];
      const bytes = new TextEncoder().encode('{"body":"encrypted release 571"}');
      const digest = (value: Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
      const inbox = await openInbox({ stateDirectory: root, bindingId: binding.bindingId,
        generation: binding.generation, maxPayloadBytes: 4096, maxSelectionEvents: 1,
        recordAcknowledgement: async value => { receipts.push([...value.releaseIds]); } });
      await inbox.enqueue({ v: 1, releaseId: 'release-571', bindingId: binding.bindingId,
        generation: binding.generation, events: [{ v: 1, roomId: 'room-571' as EventRef['roomId'],
          eventId: 'event-571' as EventRef['eventId'], authorParticipantId: 'sender-571' as EventRef['authorParticipantId'],
          authorDeviceId: 'device-571' as EventRef['authorDeviceId'], contentDigest: digest(bytes) }],
        payloadDigest: digest(bytes), payload: bytes, receivedAt: '2026-09-29T12:00:00Z' });
      let approved = false;
      const send = vi.fn(async (input: { bindingId: string | null; clientTxnId: string }) => ({
        kind: 'accepted' as const, clientTxnId: input.clientTxnId, eventId: 'event-sent-571',
      }));
      const requestChannelAccess = vi.fn();
      const factory = vi.fn(async () => ({
        client: { ...createUnavailableClient(), storedSessionId: () => PROOF_SESSION,
          async status() { return { v: 1 as const, connected: approved, binding: approved ? binding : null,
            route: approved ? 'manual_mcp' as const : 'unavailable' as const, sourceCursor: null,
            ...(approved ? { readiness: { phase: 'ready' as const, errorCode: null,
              prerequisites: { storage: 'ready' as const, device: 'ready' as const,
                bootstrap: 'ready' as const, subscription: 'ready' as const, controls: 'ready' as const,
                harness: 'unknown' as const, dispatch: 'blocked' as const, review: 'blocked' as const,
                recovery: 'unknown' as const } } } : {}) }; }, send,
          requestChannelAccess: requestChannelAccess as never },
        inbox: async () => openInbox({ stateDirectory: root, bindingId: binding.bindingId,
          generation: binding.generation, maxPayloadBytes: 4096, maxSelectionEvents: 1,
          recordAcknowledgement: async value => { receipts.push([...value.releaseIds]); } }),
        async close() {},
      }));
      const pending = await serve(factory, [request(1, 'khala_status'), request(2, 'khala_read'),
        request(3, 'khala_send', { message: 'before approval' })]);
      expect(pending.map(reply => reply.result.structuredContent)).toEqual(Array(3).fill({ kind: 'refused', code: 'not_connected' }));
      expect(send).not.toHaveBeenCalled();
      approved = true;
      let readDelivered!: () => void;
      const readWritten = new Promise<void>(resolve => { readDelivered = resolve; });
      const admitted = await serve(factory, (async function* () {
        yield request(1, 'khala_status');
        yield request(2, 'khala_read');
        await readWritten;
        const nextBytes = new TextEncoder().encode('{"body":"next hook release"}');
        await inbox.enqueue({ v: 1, releaseId: 'release-572', bindingId: binding.bindingId,
          generation: binding.generation, events: [{ v: 1, roomId: 'room-571' as EventRef['roomId'],
            eventId: 'event-572' as EventRef['eventId'], authorParticipantId: 'sender-571' as EventRef['authorParticipantId'],
            authorDeviceId: 'device-571' as EventRef['authorDeviceId'], contentDigest: digest(nextBytes) }],
          payloadDigest: digest(nextBytes), payload: nextBytes, receivedAt: '2026-09-29T12:00:01Z' });
        yield request(3, 'khala_send', { message: 'one encrypted send' });
      })(), SESSION, undefined, undefined, root, output => {
        if (output.includes('encrypted release 571')) readDelivered();
      });
      expect(admitted[0]?.result.structuredContent).toEqual({ kind: 'status', connected: true });
      expect(admitted[1]?.result.structuredContent).toMatchObject({ kind: 'batch', batch: expect.stringContaining('encrypted release 571') });
      expect(JSON.stringify(admitted)).not.toContain('batchToken');
      expect(admitted[2]?.result.structuredContent).toMatchObject({ kind: 'accepted', eventId: 'event-sent-571' });
      expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ bindingId: binding.bindingId,
        body: 'one encrypted send' }), undefined);
      expect(receipts).toEqual([['release-571']]);
      const hookConsumer = await inbox.acquireCallConsumer!();
      try {
        expect((await hookConsumer.readBatch({ maxBytes: 65_536, offerScope: 'hook-after-send' }))?.items
          .map(item => item.record.releaseId)).toEqual(['release-572']);
      } finally { await hookConsumer.release(); }
      // A resumed model turn starts a new MCP process. Its first status and
      // explicit read must select the approved generation without joining again.
      const restarted = await serve(factory, [request(4, 'khala_status'), request(5, 'khala_read')],
        SESSION, undefined, undefined, root);
      expect(restarted[0]?.result.structuredContent).toEqual({ kind: 'status', connected: true });
      expect(restarted[1]?.result.structuredContent).toMatchObject({ kind: 'batch',
        batch: expect.stringContaining('next hook release') });
      expect(receipts).toEqual([['release-571']]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenCalledWith({ harness: 'claude', sessionId: SESSION });
      expect(requestChannelAccess).not.toHaveBeenCalled();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('replays an unacknowledged read after process exit and fences a changed generation', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-claude-replay-'));
    const session = randomUUID();
    const receipts: string[][] = [];
    let currentBinding = binding;
    try {
      const bytes = new TextEncoder().encode('{"body":"restart canary"}');
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const inbox = () => openInbox({ stateDirectory: root, bindingId: binding.bindingId,
        generation: binding.generation, maxPayloadBytes: 4096, maxSelectionEvents: 8,
        recordAcknowledgement: async value => { receipts.push([...value.releaseIds]); } });
      await (await inbox()).enqueue({ v: 1, releaseId: 'restart-release', bindingId: binding.bindingId,
        generation: binding.generation, events: [{ v: 1, roomId: 'room-571' as EventRef['roomId'],
          eventId: 'restart-event' as EventRef['eventId'], authorParticipantId: 'sender-571' as EventRef['authorParticipantId'],
          authorDeviceId: 'device-571' as EventRef['authorDeviceId'], contentDigest: digest }],
        payloadDigest: digest, payload: bytes, receivedAt: '2026-10-01T00:00:00Z' });
      const send = vi.fn(async () => ({ kind: 'accepted' as const, clientTxnId: 'txn', eventId: 'sent' }));
      const factory: NonNullable<CliDependencies['hostedSession']> = async () => ({
        client: { ...createUnavailableClient(), storedSessionId: () => PROOF_SESSION,
          async status() { return { v: 1, connected: true, binding: currentBinding,
            route: 'manual_mcp', sourceCursor: null }; }, send },
        inbox: async () => inbox(), async close() {},
      });
      const call = (calls: string[]) => serve(factory, calls, session, undefined, undefined, root);
      expect((await call([request(1, 'khala_read')]))[0]?.result.structuredContent)
        .toMatchObject({ kind: 'batch', batch: expect.stringContaining('restart canary') });
      expect(receipts).toEqual([]);
      expect((await serve(factory, [request(5, 'khala_status')], randomUUID(), undefined, undefined, root))
        [0]?.result.structuredContent).toEqual({ kind: 'status', connected: true });
      expect(receipts).toEqual([]);
      currentBinding = { ...binding, generation: binding.generation + 1 };
      expect((await call([request(2, 'khala_status')]))[0]?.result.structuredContent)
        .toEqual({ kind: 'status', connected: true });
      expect(send).not.toHaveBeenCalled();
      expect(receipts).toEqual([]);
      currentBinding = binding;
      expect((await call([request(6, 'khala_status')]))[0]?.result.structuredContent)
        .toEqual({ kind: 'status', connected: true });
      expect(receipts).toEqual([]);
      const replay = await call([request(3, 'khala_read'), request(4, 'khala_read')]);
      expect(replay[0]?.result.structuredContent).toMatchObject({ kind: 'batch',
        batch: expect.stringContaining('restart canary') });
      expect(replay[1]?.result.structuredContent).toEqual({ kind: 'empty' });
      expect(receipts).toEqual([['restart-release']]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('waits for the approved binding intake to start before a resumed status and read', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-claude-resume-'));
    let clock = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      let processNumber = 0;
      const opens = vi.fn();
      const factory: NonNullable<CliDependencies['hostedSession']> = async () => {
        const process = ++processNumber;
        if (process === 2) clock = 10_000; // Slow lazy open must not consume the readiness grace period.
        let checks = 0;
        opens();
        return {
          client: { ...createUnavailableClient(), storedSessionId: () => PROOF_SESSION,
            async status() {
              checks += 1;
              return process === 2 && checks === 1
                ? { v: 1 as const, connected: false, binding: null, route: 'unavailable' as const,
                  sourceCursor: null, readiness: { phase: 'degraded' as const, errorCode: 'subscription_starting' as const,
                    prerequisites: { storage: 'ready' as const, device: 'ready' as const, bootstrap: 'ready' as const,
                      subscription: 'unknown' as const, controls: 'blocked' as const, harness: 'unknown' as const,
                      dispatch: 'blocked' as const, review: 'blocked' as const, recovery: 'unknown' as const } } }
                : { v: 1 as const, connected: true, binding, route: 'manual_mcp' as const, sourceCursor: null };
            } },
          inbox: async () => openInbox({ stateDirectory: root, bindingId: binding.bindingId,
            generation: binding.generation, maxPayloadBytes: 4096, maxSelectionEvents: 8 }),
          async close() {},
        };
      };
      const first = await serve(factory, [request(1, 'khala_status')]);
      expect(first[0]?.result.structuredContent).toEqual({ kind: 'status', connected: true });
      const resumed = await serve(factory, [request(2, 'khala_status'), request(3, 'khala_read')]);
      expect(resumed.map(reply => reply.result.structuredContent)).toEqual([
        { kind: 'status', connected: true }, { kind: 'empty' },
      ]);
      expect(opens).toHaveBeenCalledTimes(2);
    } finally { now.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('reports a typed retry state when an approved binding is still starting', async () => {
    const factory: NonNullable<CliDependencies['hostedSession']> = async () => ({
      client: { ...createUnavailableClient(), storedSessionId: () => PROOF_SESSION,
        async status() { return { v: 1, connected: false, binding: null, route: 'unavailable', sourceCursor: null,
          readiness: { phase: 'degraded', errorCode: 'subscription_starting', prerequisites: {
            storage: 'ready', device: 'ready', bootstrap: 'ready', subscription: 'unknown',
            controls: 'blocked', harness: 'unknown', dispatch: 'blocked', review: 'blocked', recovery: 'unknown',
          } } } as const; } },
      inbox: async () => { throw new Error('starting route must not read'); }, async close() {},
    });
    const results = await serve(factory, [request(1, 'khala_status'), request(2, 'khala_read')]);
    expect(results.map(reply => reply.result.structuredContent)).toEqual(Array(2).fill({
      kind: 'refused', code: 'connector_starting', next: 'retry_status_then_read',
    }));
  }, 12_000);

  it.each(['wrong-session', 'wrong-device'])('refuses a %s binding during delivery', async mismatch => {
    const wrong = mismatch === 'wrong-session' ? { ...binding, sessionId: 'agent_other' }
      : { ...binding, deviceId: 'OTHERDEVICE' as typeof binding.deviceId };
    const send = vi.fn();
    let checks = 0;
    const factory: NonNullable<CliDependencies['hostedSession']> = async () => ({
      client: { ...createUnavailableClient(), storedSessionId: () => PROOF_SESSION,
        async status() { return { v: 1, connected: true, binding: checks++ === 0 ? binding : wrong,
          route: 'native_cli_queue', sourceCursor: null }; }, send },
      inbox: async () => ({ acquireCallConsumer: async () => ({ readBatch: async () => null, release: async () => {} }) }) as never,
      async close() {},
    });
    const results = await serve(factory, [request(1, 'khala_read'), request(2, 'khala_send', { message: 'x' })]);
    expect(results[0]?.result.structuredContent).toEqual({ kind: 'refused', code: 'binding_not_held' });
    expect(results[1]?.result.structuredContent).toEqual({ kind: 'refused', code: 'not_connected' });
    expect(send).not.toHaveBeenCalled();
  });
});

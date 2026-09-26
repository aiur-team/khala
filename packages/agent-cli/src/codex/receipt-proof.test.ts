// Derives `CodexReceiptObservation` from the real `khala codex-hook`, the shared inbox and
// the next Khala call's token echo. Only Codex itself is faked: the test plays the agent.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeSessionBinding, type EventRef, type SessionBinding,
} from '@khala/contracts/delivery/index';
import {
  type CodexReceiptObservation, CODEX_RECEIPT_ROUTES, assessCodexReceiptConformance,
} from '../../../harnesses/src/codex/receipt-conformance';
import { runCli } from '../cli/app.js';
import { callScopedConsumer } from '../cli/call-consumer.js';
import { openInbox, type BatchInbox } from '../cli/inbox.js';
import type { AgentClientPort, InboxDelivery } from '../cli/types.js';
import { ReadOperation } from '../composition/read.js';

const decoded = decodeSessionBinding({
  v: 1, bindingId: 'binding-1', ownerId: 'owner-1', agentParticipantId: 'agent-1', deviceId: 'device-1',
  harness: 'codex', sessionId: 'codex-session-1', generation: 2,
});
if (!decoded.ok) throw new Error('invalid binding fixture');
const BINDING: SessionBinding = decoded.value;
const VERSION = '0.156.1';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function newState(): string {
  const parent = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-codex-proof-'));
  roots.push(parent);
  return path.join(parent, 'state');
}

const open = (state: string): Promise<BatchInbox> => openInbox({
  stateDirectory: state, bindingId: BINDING.bindingId, generation: BINDING.generation,
  maxPayloadBytes: 512 * 1024, maxSelectionEvents: 8,
});

function client(): AgentClientPort {
  return {
    async connect() { return { kind: 'unavailable' }; },
    async send(input) { return { kind: 'refused', code: 'transport_unavailable', clientTxnId: input.clientTxnId }; },
    async status() {
      return { v: 1, connected: true, binding: BINDING, route: 'native_hooks', sourceCursor: null };
    },
    async listChannels() { return { kind: 'unavailable' }; },
    async listAgents() { return { kind: 'unavailable' }; },
    async listeningMode() {
      return { v: 1, bindingId: BINDING.bindingId, generation: BINDING.generation, effective: 'steer' };
    },
  };
}

/** Runs the installed hook exactly as Codex would and returns the batch token it surfaced. */
async function hookToken(state: string, turn: string): Promise<string | null> {
  const stdin = new PassThrough();
  stdin.end(JSON.stringify({
    hook_event_name: 'PreToolUse', session_id: BINDING.sessionId, turn_id: turn,
    tool_name: 'Bash', tool_input: { command: 'ls' },
  }));
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', chunk => { out += String(chunk); });
  await runCli(['codex-hook'], {
    client: client(), inbox: async () => open(state), stdin, stdout, stderr: new PassThrough(),
  });
  if (out === '') return null;
  const json = JSON.parse(out) as { reason?: string; hookSpecificOutput?: { additionalContext: string } };
  return /batchToken: (\S+)/.exec(json.reason ?? json.hookSpecificOutput?.additionalContext ?? '')?.[1] ?? null;
}

/** The agent's next Khala call, authenticated as `held`, echoing `ackBatchToken` when given. */
async function nextCall(state: string, held: SessionBinding, ack: string | undefined) {
  const read = new ReadOperation({
    heldBinding: held,
    consumer: callScopedConsumer(await open(state), { explicitRead: true }),
    currentBinding: async () => BINDING,
  });
  return read.read({ bindingId: held.bindingId, maxBytes: 4096, ...(ack === undefined ? {} : { acknowledgeToken: ack }) });
}

type Scenario = Readonly<{
  /** What the agent passes as `ackBatchToken` on its next call, given the issued token. */
  echo?: (token: string) => string | undefined;
  held?: SessionBinding;
  /** The reader looks at a different inbox than the one the hook served. */
  otherInbox?: boolean;
}>;

type Effects = { cursorRelease: string | null; reoffered: boolean };

async function observe(scenario: Scenario = {}, effects?: Effects): Promise<CodexReceiptObservation> {
  const state = newState();
  await (await open(state)).enqueue(delivery('release-1'));
  const issued = await hookToken(state, 'turn-1');

  // Shared inbox: a raw reader of the journal sees the very batch the hook surfaced.
  const raw = await callScopedConsumer(await open(scenario.otherInbox === true ? newState() : state))
    .readBatch({ maxBytes: 4096 });
  const sharedInbox = issued !== null && raw?.token === issued;

  let authenticatedBinding = false;
  if (issued !== null) {
    const echoed = (scenario.echo ?? (token => token))(issued);
    try {
      await nextCall(state, scenario.held ?? BINDING, echoed);
      authenticatedBinding = true;
    } catch {
      authenticatedBinding = false;
    }
  }

  // Outcomes come only from what the inbox did: a returned token is one that advanced the cursor,
  // and the receipt is correlated only when the hook then stops re-offering the batch.
  const cursor = (await (await open(state)).status()).cursor;
  const tokenReturned = authenticatedBinding && cursor.releaseId === 'release-1';
  const pending = await callScopedConsumer(await open(state), { explicitRead: true }).readBatch({ maxBytes: 4096 });
  const reoffered = issued !== null && pending?.token === issued;
  const receiptCorrelated = tokenReturned && !reoffered && await hookToken(state, 'turn-2') === null;
  if (effects !== undefined) Object.assign(effects, { cursorRelease: cursor.releaseId, reoffered });

  return {
    subject: 'user_cli', route: 'hook', version: VERSION, sharedInbox, batchDelivered: issued !== null,
    authenticatedBinding, tokenReturned, receiptCorrelated, contentionSafe: await contentionSafe(),
  };
}

/** The hook and an MCP-style call race for one inbox: both see the same batch, and one ack clears it. */
async function contentionSafe(): Promise<boolean> {
  const state = newState();
  await (await open(state)).enqueue(delivery('release-c'));
  const [hook, mcp] = await Promise.all([
    hookToken(state, 'turn-c'),
    callScopedConsumer(await open(state), { explicitRead: true, waitMs: 5_000 }).readBatch({ maxBytes: 4096 }),
  ]);
  if (mcp === null || (hook !== null && hook !== mcp.token)) return false;
  await nextCall(state, BINDING, mcp.token);
  return (await (await open(state)).status()).cursor.releaseId === 'release-c';
}

describe('Codex hook route receipt proof, derived from real code', () => {
  const expected = { version: VERSION, route: 'hook' } as const;

  it('proves the hook route when the token comes back on the next call', async () => {
    const observation = await observe();
    expect(observation).toMatchObject({
      sharedInbox: true, batchDelivered: true, authenticatedBinding: true, tokenReturned: true,
      receiptCorrelated: true, contentionSafe: true,
    });
    expect(assessCodexReceiptConformance(observation, expected)).toMatchObject({ proven: true, route: 'hook' });
  });

  it('is not proven when the next call omits the token', async () => {
    const effects = {} as Effects;
    const observation = await observe({ echo: () => undefined }, effects);
    expect(effects).toEqual({ cursorRelease: null, reoffered: true });
    expect(observation).toMatchObject({ tokenReturned: false, receiptCorrelated: false });
    expect(assessCodexReceiptConformance(observation, expected)).toMatchObject({
      proven: false, gaps: expect.arrayContaining(['token_not_returned', 'receipt_not_correlated']),
    });
  });

  it('is not proven when the agent returns a different (stale) token', async () => {
    const effects = {} as Effects;
    const observation = await observe({ echo: () => 'stale-token' }, effects);
    expect(effects).toEqual({ cursorRelease: null, reoffered: true });
    expect(observation.tokenReturned).toBe(false);
    expect(observation.receiptCorrelated).toBe(false);
    expect(assessCodexReceiptConformance(observation, expected).proven).toBe(false);
  });

  it('is not proven when the next call is authenticated as another binding', async () => {
    const other = decodeSessionBinding({ ...BINDING, bindingId: 'binding-other', sessionId: 'other' });
    if (!other.ok) throw new Error('invalid binding fixture');
    const observation = await observe({ held: other.value });
    expect(observation.authenticatedBinding).toBe(false);
    expect(assessCodexReceiptConformance(observation, expected)).toMatchObject({
      proven: false, gaps: expect.arrayContaining(['binding_unauthenticated']),
    });
  });

  it('is not proven when the reader is not on the same inbox as the hook', async () => {
    const observation = await observe({ otherInbox: true });
    expect(observation.sharedInbox).toBe(false);
    expect(assessCodexReceiptConformance(observation, expected)).toMatchObject({
      proven: false, gaps: ['no_shared_inbox'],
    });
  });

  it('two callers competing for one inbox see one batch and a single ack clears it', async () => {
    expect(await contentionSafe()).toBe(true);
  });

  it('replaying an already acknowledged token never acknowledges the next batch', async () => {
    const state = newState();
    await (await open(state)).enqueue(delivery('release-1'));
    const first = await hookToken(state, 'turn-1');
    if (first === null) throw new Error('expected a batch');
    await nextCall(state, BINDING, first);
    await (await open(state)).enqueue(delivery('release-2'));

    // The duplicate carries the old token: it must not consume release-2.
    const replay = await nextCall(state, BINDING, first);
    expect(replay.kind).toBe('batch');
    const pending = await callScopedConsumer(await open(state)).readBatch({ maxBytes: 4096 });
    expect(pending?.items.map(item => item.record.releaseId)).toEqual(['release-2']);
    expect((await (await open(state)).status()).cursor.releaseId).toBe('release-1');
  });

  it.each(CODEX_RECEIPT_ROUTES)('proves only the exact %s route', async route => {
    const observation = { ...(await observe()), route } satisfies CodexReceiptObservation;
    for (const asked of CODEX_RECEIPT_ROUTES) {
      expect(assessCodexReceiptConformance(observation, { version: VERSION, route: asked }).proven)
        .toBe(asked === route);
    }
  });
});

function delivery(releaseId: string): InboxDelivery {
  const payload = new TextEncoder().encode(JSON.stringify({ body: `peer says ${releaseId}` }));
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
    payloadDigest: digest(payload), payload, receivedAt: '2026-09-25T00:00:00Z',
  };
}

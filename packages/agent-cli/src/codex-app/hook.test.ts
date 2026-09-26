import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AppHarnessRecord, type EventRef, type ListeningMode, type ModeSupport, type SessionBinding,
  decodeAppHarnessRecord, decodeSessionBinding, unknownModeSupport,
} from '@khala/contracts/delivery/index';
import { openInbox, type BatchInbox } from '../cli/inbox.js';
import type { InboxDelivery } from '../cli/types.js';
import {
  type CodexAppHookEvent, codexAppHookDelivery, decodeCodexAppHookInput, runCodexAppHook,
} from './hook.js';

const decoded = decodeSessionBinding({
  v: 1, bindingId: 'binding-1', ownerId: 'owner-1', agentParticipantId: 'agent-1', deviceId: 'device-1',
  harness: 'codex', sessionId: 'codex-app-session-1', generation: 2,
});
if (!decoded.ok) throw new Error('invalid binding fixture');
const BINDING: SessionBinding = decoded.value;
const MARKER = 'khala-app-marker-51c2';
const VERSION = '26.1.0';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const proven = (mode: ListeningMode): ModeSupport => ({
  status: 'proven', route: `codex-app-local_chat-${mode}`, testedVersion: VERSION, evidenceRef: 'trial.jsonl',
  evidenceRevision: 'rev-1', reason: null,
});

/** A record for one desktop tuple; `modes` lists the cells a synthetic proof covers. */
function record(modes: readonly ListeningMode[]): AppHarnessRecord {
  const support = (mode: ListeningMode) => modes.includes(mode)
    ? proven(mode) : unknownModeSupport(`codex-app-local_chat-${mode}`, 'Blocked.', VERSION);
  const value = {
    v: 1, app: 'codex', shape: 'local_chat', appVersion: VERSION, accountTier: 'plus', administratorPolicyScope: 'personal',
    boundaries: { steer: 'PostToolUse', sync: 'Stop', async: 'khala_read' },
    capabilities: {
      v: 3, harness: 'codex', version: VERSION, adapterVersion: 'codex-app-1',
      support: modes.length > 0 ? 'tested' : 'unsupported', existingSession: 'unknown', immediateNotification: 'unknown',
      busy: 'unknown', receiptEvidence: [], reconcileByReleaseId: 'unknown',
      limits: { maxSelectionEvents: 8, maxPayloadBytes: 4096 }, evidenceRef: 'cells.json',
      modes: { steer: support('steer'), sync: support('sync'), async: support('async') },
      acknowledgement: modes.length > 0 ? 'batch_token_next_call' : 'unknown',
    },
  };
  const result = decodeAppHarnessRecord(value);
  if (!result.ok) throw new Error(`invalid record fixture: ${result.field}`);
  return result.value;
}

type World = {
  stateDirectory: string;
  mode: ListeningMode | null;
  record: AppHarnessRecord | null;
  runs: string[];
  inboxOpened: number;
};

function world(mode: ListeningMode | null, provenModes: readonly ListeningMode[] | null): World {
  const parent = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-codex-app-hook-'));
  roots.push(parent);
  return {
    stateDirectory: path.join(parent, 'state'), mode, record: provenModes === null ? null : record(provenModes),
    runs: [], inboxOpened: 0,
  };
}

function open(w: World): Promise<BatchInbox> {
  return openInbox({
    stateDirectory: w.stateDirectory, bindingId: BINDING.bindingId, generation: BINDING.generation,
    maxPayloadBytes: 512 * 1024, maxSelectionEvents: 8,
  });
}

async function hook(
  w: World,
  event: CodexAppHookEvent | 'PreToolUse',
  options: Readonly<{ stopHookActive?: boolean }> = {},
) {
  const stdin = new PassThrough();
  stdin.end(JSON.stringify({
    hook_event_name: event, session_id: BINDING.sessionId, turn_id: 'turn-1', stop_hook_active: options.stopHookActive ?? false,
  }));
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', chunk => { out += String(chunk); });
  stderr.on('data', chunk => { err += String(chunk); });
  await runCodexAppHook({
    stdin, stdout, stderr,
    currentBinding: async () => BINDING,
    listeningMode: async () => ({ v: 1, bindingId: BINDING.bindingId, generation: BINDING.generation, effective: w.mode }),
    inbox: async () => { w.inboxOpened += 1; return open(w); },
    recordHookRun: async (sessionId, boundary) => { w.runs.push(`${sessionId}:${boundary}`); },
    inspect: async () => w.record,
  });
  return { out, err, json: out === '' ? null : JSON.parse(out) as Record<string, unknown> };
}

async function enqueue(w: World, releaseId: string): Promise<void> {
  await (await open(w)).enqueue(delivery(releaseId, `peer says ${MARKER}`));
}

describe('codex app hook boundaries', () => {
  const input = (event: CodexAppHookEvent, stopHookActive = false) =>
    decodeCodexAppHookInput({ hook_event_name: event, session_id: 's', turn_id: 't', stop_hook_active: stopHookActive })!;

  it('never accepts PreToolUse or UserPromptSubmit: no app route blocks a tool before it runs', () => {
    expect(decodeCodexAppHookInput({ hook_event_name: 'PreToolUse', session_id: 's', turn_id: 't' })).toBeNull();
    expect(decodeCodexAppHookInput({ hook_event_name: 'UserPromptSubmit', session_id: 's', turn_id: 't' })).toBeNull();
  });

  it('delivers only at a boundary whose cell is proven', () => {
    const all = record(['steer', 'sync', 'async']);
    expect(codexAppHookDelivery('steer', input('PostToolUse'), all)).toBe('context');
    expect(codexAppHookDelivery('sync', input('PostToolUse'), all)).toBeNull();
    expect(codexAppHookDelivery('sync', input('Stop'), all)).toBe('block');
    expect(codexAppHookDelivery('async', input('Stop'), all)).toBeNull();
    expect(codexAppHookDelivery('steer', input('PostToolUse'), record(['sync', 'async']))).toBeNull();
    expect(codexAppHookDelivery('sync', input('Stop'), record(['steer', 'async']))).toBeNull();
    expect(codexAppHookDelivery('steer', input('PostToolUse'), null)).toBeNull();
  });

  it('bounds Stop to one continuation per turn', () => {
    expect(codexAppHookDelivery('sync', input('Stop', true), record(['sync']))).toBeNull();
  });
});

describe('runCodexAppHook', () => {
  it('stays silent while no cell is proven, even with a batch waiting, and records the run', async () => {
    const w = world('steer', []);
    await enqueue(w, 'release-1');
    for (const event of ['PostToolUse', 'Stop'] as const) {
      expect((await hook(w, event)).out).toBe('');
    }
    expect(w.inboxOpened).toBe(0);
    expect(w.runs).toEqual([`${BINDING.sessionId}:PostToolUse`, `${BINDING.sessionId}:Stop`]);
  });

  it('fails closed when inspection returns no record', async () => {
    const w = world('sync', null);
    await enqueue(w, 'release-1');
    expect((await hook(w, 'Stop')).out).toBe('');
  });

  it('delivers one batch at a proven Stop, then hands control back on the continuation', async () => {
    const w = world('sync', ['sync']);
    await enqueue(w, 'release-1');
    const first = await hook(w, 'Stop');
    expect(first.json).toMatchObject({ decision: 'block' });
    expect(first.json!.reason).toContain(MARKER);
    expect(first.json!.reason).toContain('batchToken: ');
    expect((await hook(w, 'Stop', { stopHookActive: true })).out).toBe('');
  });

  it('returns control with no output when a proven Stop has no batch', async () => {
    const w = world('sync', ['sync']);
    expect((await hook(w, 'Stop')).out).toBe('');
  });

  it('delivers at a proven PostToolUse as context, never as a block', async () => {
    const w = world('steer', ['steer']);
    await enqueue(w, 'release-1');
    const result = await hook(w, 'PostToolUse');
    expect(result.json).toMatchObject({ hookSpecificOutput: { hookEventName: 'PostToolUse' } });
    expect(JSON.stringify(result.json)).toContain(MARKER);
  });

  it('ignores PreToolUse even with every cell proven', async () => {
    const w = world('steer', ['steer', 'sync', 'async']);
    await enqueue(w, 'release-1');
    expect((await hook(w, 'PreToolUse')).out).toBe('');
    expect(w.runs).toEqual([]);
  });
});

function delivery(releaseId: string, body: string): InboxDelivery {
  const payload = new TextEncoder().encode(JSON.stringify({ body }));
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

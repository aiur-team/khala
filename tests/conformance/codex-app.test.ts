// The Codex app adapter graded end to end: the harness inspection feeds the app hook
// runtime, so a route counts only when an exact proof tuple and the live session agree.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  type EventRef, type ListeningMode, type SessionBinding, decodeAppHarnessRecord, decodeSessionBinding,
} from '@khala/contracts/delivery/index';
import { afterEach, describe, expect, it } from 'vitest';
import proofRecord from '../../experiments/interactive-cli/codex-app/evidence/cells.json';
import { openInbox } from '../../packages/agent-cli/src/cli/inbox';
import { type CodexAppHookEvent, runCodexAppHook } from '../../packages/agent-cli/src/codex-app/hook';
import {
  type CodexAppEnvironment, type CodexAppHookBoundary, type CodexAppProvenCell, codexAppIdentity, inspectCodexApp,
} from '../../packages/harnesses/src/codex-app/index';
import { fixtureLimits } from './subjects';

const decoded = decodeSessionBinding({
  v: 1, bindingId: 'binding-app', ownerId: 'owner-1', agentParticipantId: 'agent-1', deviceId: 'device-1',
  harness: 'codex', sessionId: 'codex-app-session', generation: 0,
});
if (!decoded.ok) throw new Error('invalid binding fixture');
const BINDING: SessionBinding = decoded.value;
const MARKER = 'khala-conformance-app-9d41';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A user-started desktop session whose local hooks are configured; hook runs are recorded live. */
function session(overrides: Partial<CodexAppEnvironment> = {}): CodexAppEnvironment {
  return {
    shape: 'local_chat', appVersion: '26.1.0', accountTier: 'plus', administratorPolicyScope: 'personal',
    sessionStartedBy: 'user', toolExecution: 'hook_host', hookDeployment: 'local_config', hookRuns: [], mcpActive: true,
    ...overrides,
  };
}

function proof(env: CodexAppEnvironment, modes: readonly ListeningMode[] = ['steer', 'sync', 'async']): CodexAppProvenCell[] {
  const identity = codexAppIdentity(env, env.shape!) as CodexAppProvenCell['identity'];
  return modes.map(mode => ({ identity, mode, evidenceRef: 'trial.jsonl', evidenceRevision: 'rev-1' }));
}

/** Runs one hook invocation against a queued batch; returns what reached the model. */
async function boundary(
  env: CodexAppEnvironment,
  cells: readonly CodexAppProvenCell[],
  mode: ListeningMode,
  event: CodexAppHookEvent,
  handlerRuns = env.hookDeployment !== 'web_plugin',
): Promise<string> {
  const parent = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-codex-app-conformance-'));
  roots.push(parent);
  const open = () => openInbox({
    stateDirectory: path.join(parent, 'state'), bindingId: BINDING.bindingId, generation: BINDING.generation,
    maxPayloadBytes: 64 * 1024, maxSelectionEvents: 8,
  });
  await (await open()).enqueue(delivery('release-1'));
  const runs: CodexAppHookBoundary[] = [...env.hookRuns];
  const stdin = new PassThrough();
  stdin.end(JSON.stringify({ hook_event_name: event, session_id: BINDING.sessionId, turn_id: 'turn-1', stop_hook_active: false }));
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', chunk => { out += String(chunk); });
  await runCodexAppHook({
    stdin, stdout, stderr: new PassThrough(),
    currentBinding: async () => BINDING,
    listeningMode: async () => ({ v: 1, bindingId: BINDING.bindingId, generation: BINDING.generation, effective: mode }),
    inbox: async () => open(),
    // A run is recorded only when the handler itself executes in this session.
    recordHookRun: async (_session, ran) => { if (handlerRuns) runs.push(ran); },
    inspect: async () => inspectCodexApp({ ...env, hookRuns: runs }, fixtureLimits, cells).record,
  });
  return out;
}

describe('codex app conformance: the committed proof record', () => {
  it('reports every recorded cell unknown and delivers nothing through either hook', async () => {
    expect(proofRecord.cells).toHaveLength(6);
    for (const cell of proofRecord.cells) {
      const shape = cell.shape as 'local_chat' | 'cloud_task';
      const env = session({ shape, hookDeployment: shape === 'local_chat' ? 'local_config' : 'task_environment' });
      const { record } = inspectCodexApp(env, fixtureLimits);
      expect(decodeAppHarnessRecord(record).ok).toBe(true);
      expect(record!.capabilities.modes[cell.mode as ListeningMode]).toMatchObject({ status: 'unknown', evidenceRef: null });
      expect(record!.capabilities.acknowledgement).toBe('unknown');
    }
    expect(await boundary(session(), [], 'steer', 'PostToolUse')).toBe('');
    expect(await boundary(session(), [], 'sync', 'Stop')).toBe('');
  });
});

describe('codex app conformance: wrong implementations', () => {
  it('a proven tuple whose local hook really ran delivers (the gate is reachable)', async () => {
    const env = session();
    expect(await boundary(env, proof(env), 'steer', 'PostToolUse')).toContain(MARKER);
    expect(await boundary(env, proof(env), 'sync', 'Stop')).toContain(MARKER);
  });

  it('installing a web plugin does not imply the local hook scripts ran', async () => {
    const env = session({ hookDeployment: 'web_plugin' });
    expect(await boundary(env, proof(env), 'steer', 'PostToolUse')).toBe('');
    expect(await boundary(env, proof(env), 'sync', 'Stop')).toBe('');
  });

  it('a web plugin install stays closed even when a handler run is recorded', async () => {
    const env = session({ hookDeployment: 'web_plugin' });
    expect(await boundary(env, proof(env), 'steer', 'PostToolUse', true)).toBe('');
    expect(await boundary(env, proof(env), 'sync', 'Stop', true)).toBe('');
  });

  it('a locally configured hook that never ran in this session delivers nothing', async () => {
    const env = session();
    expect(await boundary(env, proof(env), 'steer', 'PostToolUse', false)).toBe('');
    expect(await boundary(env, proof(env), 'sync', 'Stop', false)).toBe('');
  });

  it('a Codex task Khala launched cannot satisfy same-session delivery', async () => {
    const env = session({ shape: 'cloud_task', hookDeployment: 'task_environment', sessionStartedBy: 'khala' });
    expect(inspectCodexApp(env, fixtureLimits, proof(env)).capabilities.support).toBe('unsupported');
    expect(await boundary(env, proof(env), 'sync', 'Stop')).toBe('');
  });

  it('a cloud-task proof cannot enable a desktop session', async () => {
    const cloud = session({ shape: 'cloud_task', hookDeployment: 'task_environment' });
    expect(await boundary(session(), proof(cloud), 'steer', 'PostToolUse')).toBe('');
    expect(await boundary(session(), proof(cloud), 'sync', 'Stop')).toBe('');
  });

  it('hosted tools that bypass the PostToolUse hook fail steer closed', async () => {
    const env = session({ toolExecution: 'hosted' });
    expect(await boundary(env, proof(env), 'steer', 'PostToolUse')).toBe('');
  });
});

function delivery(releaseId: string) {
  const payload = new TextEncoder().encode(JSON.stringify({ body: `peer says ${MARKER}` }));
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
    v: 1 as const, releaseId, bindingId: BINDING.bindingId, generation: BINDING.generation, events: [event],
    payloadDigest: digest(payload), payload, receivedAt: '2026-09-25T00:00:00Z',
  };
}

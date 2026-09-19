import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeSessionBinding,
  type EventRef,
} from '@khala/contracts/delivery/index';
import { runCli } from '../../../agent-cli/src/cli/app.js';
import { openInbox } from '../../../agent-cli/src/cli/inbox.js';
import type { AgentClientPort, InboxDelivery } from '../../../agent-cli/src/cli/types.js';
import { createListenerSupervisor, type ListenerProcessPort } from './supervisor.js';

const roots: string[] = [];
const decodedBinding = decodeSessionBinding({
  v: 1,
  bindingId: 'binding-1',
  ownerId: 'owner-1',
  agentParticipantId: 'agent-1',
  deviceId: 'device-1',
  harness: 'other-agent',
  sessionId: 'session-1',
  generation: 0,
});
if (!decodedBinding.ok) throw new Error('invalid binding fixture');
const binding = decodedBinding.value;
const event: EventRef = {
  v: 1,
  roomId: 'room-1' as EventRef['roomId'],
  eventId: 'event-1' as EventRef['eventId'],
  authorParticipantId: 'participant-1' as EventRef['authorParticipantId'],
  authorDeviceId: 'device-1' as EventRef['authorDeviceId'],
  contentDigest: `sha256:${'1'.repeat(64)}`,
};

function stateDirectory(): string {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-skill-'));
  roots.push(root);
  return path.join(root, 'state');
}

function delivery(releaseId: string, body: string): InboxDelivery {
  const payload = new TextEncoder().encode(body);
  return {
    v: 1,
    releaseId,
    bindingId: binding.bindingId,
    generation: binding.generation,
    events: [event],
    payload,
    payloadDigest: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
    receivedAt: '2026-09-19T12:00:00Z',
  };
}

function client(): AgentClientPort {
  return {
    async connect() { return { kind: 'connected', binding, reused: true }; },
    async send(input) { return { kind: 'accepted', clientTxnId: input.clientTxnId, eventId: null }; },
    async status() {
      return { v: 1, connected: true, binding, route: 'agent_installed_listener', sourceCursor: 'source-1' };
    },
  };
}

function cliProcess(directory: string): ListenerProcessPort {
  return {
    async run(input) {
      const stdin = new PassThrough();
      stdin.end();
      const code = await runCli(input.args, {
        client: client(),
        inbox: (bindingId, generation) => openInbox({
          stateDirectory: directory,
          bindingId,
          generation,
          maxPayloadBytes: 1024,
          maxSelectionEvents: 32,
        }),
        stdin,
        stdout: input.stdout,
        stderr: input.stderr,
        signal: input.signal,
      });
      return { code, signal: input.signal.aborted ? 'SIGTERM' : null, errorCode: null };
    },
  };
}

async function listenOnce(supervisor: ReturnType<typeof createListenerSupervisor>): Promise<string> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const abort = new AbortController();
  let output = '';
  let error = '';
  stderr.on('data', chunk => { error += String(chunk); });
  stdout.on('data', chunk => {
    output += String(chunk);
    if (output.includes('\n')) abort.abort();
  });
  const handle = supervisor.start({ bindingId: binding.bindingId, stdout, stderr, signal: abort.signal });
  await handle.completion;
  expect(error).toBe('');
  return output;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('fallback listener with the durable CLI', () => {
  it('delivers backlog across restarts with no duplicate, no gap, and no pending content', async () => {
    const directory = stateDirectory();
    const inbox = await openInbox({
      stateDirectory: directory,
      bindingId: binding.bindingId,
      generation: binding.generation,
      maxPayloadBytes: 1024,
      maxSelectionEvents: 32,
    });
    await expect(inbox.enqueue(delivery('release-1', 'released-one'))).resolves.toBe('appended');
    const supervisor = createListenerSupervisor({ process: cliProcess(directory) });

    const first = await listenOnce(supervisor);
    await expect(inbox.enqueue(delivery('release-1', 'released-one'))).resolves.toBe('duplicate');
    await expect(inbox.enqueue(delivery('release-2', 'released-two'))).resolves.toBe('appended');
    const second = await listenOnce(supervisor);

    expect([JSON.parse(first), JSON.parse(second)].map(item => item.releaseId)).toEqual(['release-1', 'release-2']);
    expect(first + second).not.toContain('pending-secret');
    expect((await openInbox({
      stateDirectory: directory,
      bindingId: binding.bindingId,
      generation: binding.generation,
      maxPayloadBytes: 1024,
      maxSelectionEvents: 32,
    }).then(current => current.status())).cursor.releaseId).toBe('release-2');
  });
});

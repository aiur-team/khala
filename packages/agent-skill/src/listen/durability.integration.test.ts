import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeSessionBinding, type EventRef } from '@khala/contracts/delivery/index';
import { openInbox } from '@aiur/khala/cli/inbox';
import type { InboxDelivery } from '@aiur/khala/cli/types';
import { nodeListenerProcess } from './node-process.js';

const roots: string[] = [];
const listenerFixture = fileURLToPath(new URL('./fixtures/listener-child.ts', import.meta.url));
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

function childArguments(directory: string): string[] {
  return ['--conditions=khala-source', '--import', 'tsx', listenerFixture, directory, binding.bindingId];
}

function capture() {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', chunk => { text += String(chunk); });
  return { stream, text: () => text };
}

async function listenOnce(directory: string): Promise<string> {
  const stdout = capture();
  const stderr = capture();
  const abort = new AbortController();
  stdout.stream.on('data', () => abort.abort());
  const args = childArguments(directory);
  expect(JSON.stringify(args)).not.toContain('released-');
  const exit = await nodeListenerProcess.run({
    command: process.execPath,
    args,
    stdout: stdout.stream,
    stderr: stderr.stream,
    signal: abort.signal,
  });
  expect(exit).toMatchObject({ errorCode: null });
  expect(stderr.text()).toBe('');
  return stdout.text();
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('fallback listener with the durable CLI', () => {
  it('delivers released backlog across child-process restarts with no duplicate or gap', async () => {
    const directory = stateDirectory();
    const released = [
      { releaseId: 'release-1', body: 'released-one' },
      { releaseId: 'release-2', body: 'released-two' },
    ] as const;

    const inbox = await openInbox({
      stateDirectory: directory,
      bindingId: binding.bindingId,
      generation: binding.generation,
      maxPayloadBytes: 1024,
      maxSelectionEvents: 32,
    });
    const [firstRelease, secondRelease] = released;
    await expect(inbox.enqueue(delivery(firstRelease.releaseId, firstRelease.body))).resolves.toBe('appended');

    const first = await listenOnce(directory);
    await expect(inbox.enqueue(delivery(firstRelease.releaseId, firstRelease.body))).resolves.toBe('duplicate');
    await expect(inbox.enqueue(delivery(secondRelease.releaseId, secondRelease.body))).resolves.toBe('appended');
    const second = await listenOnce(directory);

    expect([JSON.parse(first), JSON.parse(second)].map(item => item.releaseId)).toEqual(['release-1', 'release-2']);
    expect((await openInbox({
      stateDirectory: directory,
      bindingId: binding.bindingId,
      generation: binding.generation,
      maxPayloadBytes: 1024,
      maxSelectionEvents: 32,
    }).then(current => current.status())).cursor.releaseId).toBe('release-2');
  });

  it('surfaces the real CLI cross-process listener lock as structured listener_busy', async () => {
    const directory = stateDirectory();
    const inbox = await openInbox({
      stateDirectory: directory,
      bindingId: binding.bindingId,
      generation: binding.generation,
      maxPayloadBytes: 1024,
      maxSelectionEvents: 32,
    });
    await inbox.enqueue(delivery('release-lock', 'released-lock'));

    const firstOutput = capture();
    const firstError = capture();
    const firstAbort = new AbortController();
    const first = nodeListenerProcess.run({
      command: process.execPath,
      args: childArguments(directory),
      stdout: firstOutput.stream,
      stderr: firstError.stream,
      signal: firstAbort.signal,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('listener fixture did not start')), 5_000);
        firstOutput.stream.once('data', () => { clearTimeout(timer); resolve(); });
      });
      const secondError = capture();
      const second = await nodeListenerProcess.run({
        command: process.execPath,
        args: childArguments(directory),
        stdout: new PassThrough(),
        stderr: secondError.stream,
        signal: new AbortController().signal,
      });
      expect(second).toEqual({ code: 2, signal: null, errorCode: 'listener_busy' });
      expect(secondError.text()).toBe('{"ok":false,"error":"listener_busy"}\n');
    } finally {
      firstAbort.abort();
      await expect(first).resolves.toMatchObject({ errorCode: null });
    }
    expect(firstError.text()).toBe('');
  });
});

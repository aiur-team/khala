import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeDeliveryLimits, type SessionBinding } from '@khala/contracts/delivery/index';
import { interactiveCodexCapabilities } from '@khala/harnesses/codex/interactive';
import { CODEX_IDLE_WAKE_NOTICE } from '@khala/harnesses/codex/idle-wake';
import { createCodexIdleActivity } from '@aiur/khala/composition/codex-idle-activity';
import { internalSessionDigest } from '@aiur/khala/composition/internal-session';
import type { SqliteListeningModeRepository } from '../../listening-mode-store/sqlite';
import type { ChannelStore } from '../../store/channel-store';
import type { BindingPauseStore } from '../../store/pause-store';
import { composeCodexIdleWake } from './codex-idle-wake';

const native = 'native-thread-one';
const binding = {
  v: 1, bindingId: 'binding-one', ownerId: 'owner-one', agentParticipantId: 'agent-one',
  deviceId: 'device-one', harness: 'codex', sessionId: internalSessionDigest('codex', native), generation: 3,
} as SessionBinding;
const limits = decodeDeliveryLimits({ maxPayloadBytes: 4096, maxSelectionEvents: 8 });
if (!limits.ok) throw new Error('limits');
const capabilities = interactiveCodexCapabilities('0.154.0', limits.value, { state: 'trusted' });
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));

function subject(outcomes: ('queued' | 'not_started')[] = []) {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-server-wake-'));
  directories.push(stateDirectory);
  let live = true;
  let paused = false;
  let requested: 'steer' | 'sync' | 'async' = 'sync';
  const runs: string[][] = [];
  const wake = composeCodexIdleWake({ stateDirectory,
    store: { sessionBinding: () => ({ kind: 'done', binding: live ? binding : null }) } as unknown as ChannelStore,
    modes: { read: () => ({ kind: 'record', control: { bindingId: binding.bindingId,
      generation: binding.generation, requested, version: 1, experimentalGrants: [], hardCancelGrants: [],
      lastChangedBy: { kind: 'agent', bindingId: binding.bindingId, generation: binding.generation } } }) } as unknown as SqliteListeningModeRepository,
    pause: { read: () => paused } as unknown as BindingPauseStore,
    harnesses: { capabilities: () => capabilities, observe() {} },
    port: { run: async argv => { runs.push([...argv]); return { status: outcomes.shift() ?? 'queued' }; } },
  });
  return { stateDirectory, wake, runs, stop: () => { live = false; }, pause: () => { paused = true; },
    mode: (value: typeof requested) => { requested = value; } };
}

describe('owner-composed native idle wake', () => {
  it('queues one constant notice per idle interval for the exact held native thread', async () => {
    const s = subject();
    const activity = createCodexIdleActivity(s.stateDirectory);
    await s.wake(binding, native, () => true);
    await activity.mark(binding, true, native);
    await Promise.all([s.wake(binding, native, () => true), s.wake(binding, native, () => true)]);
    expect(s.runs).toEqual([['queue', '--thread', native, '--message', CODEX_IDLE_WAKE_NOTICE]]);
    await activity.mark(binding, false, native);
    await activity.mark(binding, true, native);
    await s.wake(binding, native, () => true);
    expect(s.runs).toHaveLength(2);
  });

  it('holds async, paused, stale and Stop-revoked bindings', async () => {
    const s = subject();
    await createCodexIdleActivity(s.stateDirectory).mark(binding, true, native);
    s.mode('async');
    await s.wake(binding, native, () => true);
    s.mode('sync');
    s.pause();
    await s.wake(binding, native, () => true);
    await s.wake(binding, 'foreign-thread', () => true);
    s.stop();
    await s.wake(binding, native, () => true);
    expect(s.runs).toEqual([]);
  });

  it('retries a failed queue on later accepted work in the same idle interval', async () => {
    const s = subject(['not_started', 'queued']);
    await createCodexIdleActivity(s.stateDirectory).mark(binding, true, native);
    await s.wake(binding, native, () => true);
    await s.wake(binding, native, () => true);
    expect(s.runs).toHaveLength(2);
  });
});

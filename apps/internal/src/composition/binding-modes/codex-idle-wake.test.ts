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
import { createChannelStore, type ChannelStore } from '../../store/channel-store';
import type { BindingPauseStore } from '../../store/pause-store';
import { openChannelStore, type InternalStoreHandle } from '../../store/open';
import { composeCodexIdleWake } from './codex-idle-wake';
import { composeBindingModes } from './index';

const native = 'native-thread-one';
const binding = {
  v: 1, bindingId: 'binding-one', ownerId: 'owner-one', agentParticipantId: 'agent-one',
  deviceId: 'device-one', harness: 'codex', sessionId: internalSessionDigest('codex', native), generation: 3,
} as SessionBinding;
const limits = decodeDeliveryLimits({ maxPayloadBytes: 4096, maxSelectionEvents: 8 });
if (!limits.ok) throw new Error('limits');
const capabilities = interactiveCodexCapabilities('0.154.0', limits.value, { state: 'trusted' });
const directories: string[] = [];
const handles: InternalStoreHandle[] = [];
afterEach(() => {
  handles.splice(0).forEach(handle => { try { handle.close(); } catch { /* already closed */ } });
  directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true }));
});

function subject(outcomes: ('queued' | 'not_started')[] = []) {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-server-wake-'));
  directories.push(stateDirectory);
  let live = true;
  let liveGeneration = binding.generation;
  let paused = false;
  let requested: 'steer' | 'sync' | 'async' = 'sync';
  let duringInspection: () => void = () => {};
  let inspections = 0;
  const runs: string[][] = [];
  const wake = composeCodexIdleWake({ stateDirectory,
    store: { sessionBinding: () => ({ kind: 'done', binding: live ? { ...binding, generation: liveGeneration } : null }) } as unknown as ChannelStore,
    modes: { read: () => ({ kind: 'record', control: { bindingId: binding.bindingId,
      generation: binding.generation, requested, version: 1, experimentalGrants: [], hardCancelGrants: [],
      lastChangedBy: { kind: 'agent', bindingId: binding.bindingId, generation: binding.generation } } }) } as unknown as SqliteListeningModeRepository,
    pause: { read: () => paused } as unknown as BindingPauseStore,
    harnesses: { capabilities: () => capabilities, observe() {}, revalidateCodex: async () => {
      inspections += 1;
      duringInspection();
      return true;
    } },
    port: { run: async argv => { runs.push([...argv]); return { status: outcomes.shift() ?? 'queued' }; } },
  });
  return { stateDirectory, wake, runs, stop: () => { live = false; }, pause: () => { paused = true; },
    stale: () => { liveGeneration += 1; }, inspections: () => inspections,
    duringInspection: (change: () => void) => { duringInspection = change; },
    mode: (value: typeof requested) => { requested = value; } };
}

describe('owner-composed native idle wake', () => {
  it('restores only revalidated exact-binding capability across an owner restart', async () => {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-server-wake-restart-'));
    directories.push(stateDirectory);
    const databaseDirectory = path.join(stateDirectory, 'store');
    let handle = openChannelStore({ directory: databaseDirectory, mode: 'create' });
    handles.push(handle);
    const channels = createChannelStore(handle);
    expect(channels.registerParticipant({ participantId: binding.agentParticipantId,
      ownerId: binding.ownerId, kind: 'agent', displayName: 'Wake agent' })).toMatchObject({ kind: 'done' });
    expect(channels.registerDevice({ deviceId: binding.deviceId,
      participantId: binding.agentParticipantId })).toMatchObject({ kind: 'done' });
    expect(channels.registerBinding(binding)).toMatchObject({ kind: 'done' });
    const observed = { version: '0.154.0', hookReview: 'trusted' as const };
    let current: { version: string; hookReview: 'trusted' | 'awaiting_hook_review' } = observed;
    let live = true;
    const runs: string[][] = [];
    const store = { sessionBinding: () => ({ kind: 'done', binding: live ? binding : null }) } as unknown as ChannelStore;
    const port = { run: async (argv: readonly string[]) => { runs.push([...argv]); return { status: 'queued' as const }; } };
    const compose = (opened: InternalStoreHandle) => composeBindingModes({
      handle: opened, store, stateDirectory,
      codexWake: { inspect: async () => current, port },
    });
    const first = compose(handle);
    expect(first.listeningModes.initialize({ bindingId: binding.bindingId, generation: binding.generation,
      requested: 'sync', version: 1, experimentalGrants: [], hardCancelGrants: [],
      lastChangedBy: { kind: 'unknown' } })).toBe(true);
    first.control.observe(binding, observed);
    const activity = createCodexIdleActivity(stateDirectory);
    await activity.mark(binding, true, native);
    await first.control.idleWake!(binding, native, () => true);
    expect(runs).toHaveLength(1);

    handle.close();
    handle = openChannelStore({ directory: databaseDirectory, mode: 'existing' });
    handles.push(handle);
    const restarted = compose(handle);
    expect(restarted.control.capabilities(binding)).toBeNull();
    await activity.mark(binding, false, native);
    await activity.mark(binding, true, native);
    await restarted.control.idleWake!(binding, native, () => true);
    expect(runs).toHaveLength(2);
    expect(restarted.control.capabilities(binding)?.support).toBe('tested');

    current = { version: '0.155.0', hookReview: 'trusted' };
    await activity.mark(binding, false, native);
    await activity.mark(binding, true, native);
    await restarted.control.idleWake!(binding, native, () => true);
    expect(runs).toHaveLength(2);
    expect(restarted.control.capabilities(binding)).toBeNull();
    current = { version: '0.154.0', hookReview: 'awaiting_hook_review' };
    await restarted.control.idleWake!(binding, native, () => true);
    expect(runs).toHaveLength(2);

    current = observed;
    const nextGeneration = { ...binding, generation: binding.generation + 1 };
    expect(restarted.control.capabilities(nextGeneration)).toBeNull();
    await activity.mark(nextGeneration, true, native);
    await restarted.control.idleWake!(nextGeneration, native, () => true);
    expect(runs).toHaveLength(2);
    restarted.control.observe(binding, observed);
    expect(restarted.control.capabilities({ ...binding, sessionId: 'different-session' })).toBeNull();
    expect(restarted.control.capabilities({ ...binding, ownerId: 'different-owner' as SessionBinding['ownerId'] })).toBeNull();
    await restarted.control.idleWake!({ ...binding, sessionId: 'different-session' }, native, () => true);
    expect(runs).toHaveLength(2);
    await restarted.control.idleWake!(binding, native, () => false);
    expect(runs).toHaveLength(2);
    live = false;
    await restarted.control.idleWake!(binding, native, () => true);
    expect(runs).toHaveLength(2);
  });

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

  it('holds an unpaused stopped binding before inspecting the installation', async () => {
    const s = subject();
    await createCodexIdleActivity(s.stateDirectory).mark(binding, true, native);
    s.stop();
    await s.wake(binding, native, () => true);
    expect(s.inspections()).toBe(0);
    expect(s.runs).toEqual([]);
  });

  it('holds an unpaused stale generation before inspecting the installation', async () => {
    const s = subject();
    await createCodexIdleActivity(s.stateDirectory).mark(binding, true, native);
    s.stale();
    await s.wake(binding, native, () => true);
    expect(s.inspections()).toBe(0);
    expect(s.runs).toEqual([]);
  });

  it('rechecks an unpaused Stop after installation inspection', async () => {
    const s = subject();
    await createCodexIdleActivity(s.stateDirectory).mark(binding, true, native);
    s.duringInspection(() => s.stop());
    await s.wake(binding, native, () => true);
    expect(s.inspections()).toBe(1);
    expect(s.runs).toEqual([]);
  });

  it('rechecks an unpaused stale generation after installation inspection', async () => {
    const s = subject();
    await createCodexIdleActivity(s.stateDirectory).mark(binding, true, native);
    s.duringInspection(() => s.stale());
    await s.wake(binding, native, () => true);
    expect(s.inspections()).toBe(1);
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

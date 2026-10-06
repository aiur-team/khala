import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createKhalaAgentClient } from '../client-impl';
import { ensureStateDir, removeStateFile, sessionFiles } from '../state';
import type { createCodexWaker } from '../wake/codex';
import { createWakeLadder } from '../wake/ladder';
import { adapterFor } from '../harness';
import { readWakeState } from '../wake/shared';
import { monitorArmed } from '../watch';
import type { ClientFactory } from './main';

export function createRealClientFactory(env: NodeJS.ProcessEnv, deps: {
  createClient?: typeof createKhalaAgentClient;
  createWaker?: typeof createCodexWaker;
} = {}): ClientFactory {
  return ({ harness, sessionId, rejoinable }) => {
    const files = sessionFiles(harness, sessionId, env);
    const adapter = adapterFor(harness);
    const drivers = adapter?.wakeLadder;
    const waker = drivers?.length ? deps.createWaker
      ? deps.createWaker({ files, threadId: sessionId })
      : createWakeLadder({ files, harness, sessionId, drivers, env,
        warningPrefix: adapter?.wakeWarningName ?? 'wake' }) : undefined;
    const client = (deps.createClient ?? createKhalaAgentClient)({ harness, sessionId, ...(rejoinable !== undefined ? { rejoinable } : {}), env,
      ...(waker ? { onInboxAppend: () => waker.notify() } : {}) });
    // Restore authorization before the first tool call. Clear the previous process's join before
    // delegating any operation, so an expired join cannot reject a fresh one.
    let initialization: Promise<void> | undefined;
    const initialize = () => initialization ??= (async () => {
      await ensureStateDir(files.dir);
      await removeStateFile(files.dir, 'join.json');
      const joinsDir = path.join(files.dir, 'joins');
      await ensureStateDir(joinsDir);
      await fs.rm(joinsDir, { recursive: true, force: true });
      await client.resume?.();
    })();
    void initialize().catch(() => {});
    return {
      async join(link, label) { await initialize(); return client.join(link, label); },
      async status(channel) {
        await initialize();
        const status = await (channel === undefined ? client.status() : client.status(channel));
        let wakeDrivers: Awaited<ReturnType<typeof client.status>>['wakeDrivers'];
        if (drivers?.length) {
          try {
            const states = await readWakeState(files.dir);
            wakeDrivers = await Promise.all(drivers.map(async driver => {
              const ctx = { files, harness, sessionId, env, now: Date.now(), signal: new AbortController().signal };
              const available = !states[driver.id]?.disabled && await driver.available(ctx);
              const reason = states[driver.id]?.disabled ? states[driver.id]?.reason : available ? undefined : await driver.unavailableReason?.(ctx);
              return { id: driver.id, available, ...(reason ? { reason } : {}) };
            }));
          } catch {
            // Diagnostics must not hide the channel's connection state.
            wakeDrivers = drivers.map(driver => ({ id: driver.id, available: false, reason: 'wake_status_unavailable' }));
          }
        }
        const withWake = wakeDrivers ? { ...status, wakeDrivers } : status;
        return adapter?.watcherStatus && ['connected', 'send_failed'].includes(status.state)
          ? { ...withWake, watcherArmed: await monitorArmed(files) } : withWake;
      },
      async read(limit, before, channel) { await initialize(); return channel === undefined ? client.read(limit, before) : client.read(limit, before, channel); },
      async send(text, channel) { await initialize(); return channel === undefined ? client.send(text) : client.send(text, channel); },
      async sendChannelEvent(content, channel) { await initialize(); return channel === undefined ? client.sendChannelEvent(content) : client.sendChannelEvent(content, channel); },
      async leave(channel) { await initialize(); return client.leave(channel); },
      async close() {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (async () => { await initialize(); await client.close(); })(),
            new Promise<never>((_resolve, reject) => {
              // Reserve a second of the CLI deadline for waker child cleanup.
              timer = setTimeout(() => reject(new Error('cleanup_timeout')), 4000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          await waker?.stop();
        }
      },
    };
  };
}

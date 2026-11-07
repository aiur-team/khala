import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createKhalaAgentClient } from '../client-impl';
import { ensureStateDir, readJson, removeStateFile, sessionFiles, stateRoot } from '../state';
import type { createCodexWaker } from '../wake/codex';
import { createWakeLadder } from '../wake/ladder';
import { adapterFor } from '../harness';
import { wakeStatus, selectedWakeStatus, wakeDisableNotice, wakeStatusText } from '../wake/status';
import { qwenInboundAllowed } from '../wake/qwen-socket';
import { readWakeSettings } from '../wake/shared';
import { claudeWatchCommand, monitorArmed } from '../watch';
import type { ClientFactory } from './main';
import { KhalaClientError } from '../client';
import { claimAgent, markReleased, supersededHere } from '../folder-agent';

export function createRealClientFactory(env: NodeJS.ProcessEnv, deps: {
  platform?: NodeJS.Platform;
  createClient?: typeof createKhalaAgentClient;
  createWaker?: typeof createCodexWaker;
  supersedePollMs?: number;
} = {}): ClientFactory {
  return ({ harness, sessionId, rejoinable }) => {
    const files = sessionFiles(harness, sessionId, env);
    const adapter = adapterFor(harness);
    const drivers = adapter?.wakeLadder;
    const watcherStatus = harness === 'qwen' ? (deps.platform ?? process.platform) === 'win32' : adapter?.watcherStatus;
    const waker = drivers?.length ? deps.createWaker
      ? deps.createWaker({ files, threadId: sessionId })
      : createWakeLadder({ files, harness, sessionId, drivers, env,
        warningPrefix: adapter?.wakeWarningName ?? 'wake' }) : undefined;
    const watcherHint = async () => {
      if (harness === 'claude') return await monitorArmed(files) ? undefined
        : `Start a background Monitor on ${claudeWatchCommand(sessionId, env)} with timeout_ms 1800000; re-arm it when the Monitor deadline ends.`;
      if (harness !== 'qwen' || (deps.platform ?? process.platform) !== 'win32') return undefined;
      const settings = await readWakeSettings(stateRoot(env));
      if (!await qwenInboundAllowed(env) || settings.off['qwen/socket']) return undefined;
      const rows = await wakeStatus(harness, { env, files, sessionId });
      if (rows.some(row => row.state === 'held' || row.state === 'disabled')) return undefined;
      const installed = await readJson<{ command?: string }>(path.join(stateRoot(env), 'qwen', 'watch-command.json'));
      if (!installed?.command || await monitorArmed(files)) return undefined;
      return `Arm run_shell_command with ${JSON.stringify({ command: installed.command + ' --session ' + sessionId, is_background: true })}. When it completes, call the Khala read tool, then re-arm the same one-shot watcher.`;
    };
    const client = (deps.createClient ?? createKhalaAgentClient)({ harness, sessionId, ...(rejoinable !== undefined ? { rejoinable } : {}), env,
      ...(waker ? { onInboxAppend: () => waker.notify() } : {}) });
    // Restore authorization before the first tool call. Clear the previous process's join before
    // delegating any operation, so an expired join cannot reject a fresh one.
    // A Claude agent is its folder: the newest session there takes it over and an older one stands down.
    let superseded = false;
    let supersedeTimer: ReturnType<typeof setInterval> | undefined;
    let standingDown: Promise<void> | undefined;
    const standDown = () => standingDown ??= (async () => {
      superseded = true;
      clearInterval(supersedeTimer);
      await client.close().catch(() => {});
      await waker?.stop();
      await markReleased(files.dir);
    })();
    let preparation: Promise<void> | undefined;
    const prepare = () => preparation ??= (async () => {
      await ensureStateDir(files.dir);
      if (harness === 'claude') {
        await claimAgent(files.dir);
        supersedeTimer = setInterval(() => {
          void supersededHere(files.dir).then(other => other ? standDown() : undefined).catch(() => {});
        }, deps.supersedePollMs ?? 1_000);
        supersedeTimer.unref();
      }
      await removeStateFile(files.dir, 'join.json');
      const joinsDir = path.join(files.dir, 'joins');
      await ensureStateDir(joinsDir);
      await fs.rm(joinsDir, { recursive: true, force: true });
    })();
    let initialization: Promise<void> | undefined;
    const initialize = () => initialization ??= (async () => {
      await prepare();
      await client.resume?.();
    })();
    void initialize().catch(() => {});
    const live = async () => {
      await initialize();
      if (superseded) throw new KhalaClientError('not_connected', 'superseded', { reason: 'superseded' });
    };
    return {
      async join(link, label) { await live(); const joined = await client.join(link, label); return { ...joined, ...(joined.state === 'connected' ? { watcherHint: await watcherHint() } : {}) }; },
      async status(channel) {
        await live();
        const status = await (channel === undefined ? client.status() : client.status(channel));
        let idleWake;
        try { idleWake = selectedWakeStatus(await wakeStatus(harness, { env, files, sessionId })); }
        catch { idleWake = wakeStatusText(drivers?.[0]?.id ?? 'watcher', 'unavailable', 'wake_status_unavailable'); }
        const withWake = { ...status, idleWake };
        const hint = await watcherHint();
        return watcherStatus && ['connected', 'send_failed'].includes(withWake.state)
          ? { ...withWake, watcherArmed: await monitorArmed(files), ...(hint ? { watcherHint: hint } : {}) } : withWake;
      },
      async read(limit, before, channel, filter) {
        await live();
        const result = await (filter ? client.read(limit, before, channel, filter) : channel === undefined ? client.read(limit, before) : client.read(limit, before, channel));
        const wakeNotice = await wakeDisableNotice(files.dir);
        return { ...result, ...(wakeNotice ? { wakeNotice } : {}) };
      },
      async send(text, channel) { await live(); return channel === undefined ? client.send(text) : client.send(text, channel); },
      async sendImage(file, caption, channel) { await live(); return client.sendImage(file, caption, channel); },
      async downloadImage(eventId, channel) { await live(); return client.downloadImage(eventId, channel); },
      async sendChannelEvent(content, channel) { await live(); return channel === undefined ? client.sendChannelEvent(content) : client.sendChannelEvent(content, channel); },
      async leave(channel, reason) { await live(); return reason === undefined ? client.leave(channel) : client.leave(channel, reason); },
      async setMode(mode, input, channel) { await live(); return client.setMode(mode, input, channel); },
      async close() {
        clearInterval(supersedeTimer);
        // A superseded client already closed; its status files now belong to the new owner.
        if (standingDown) return standingDown;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (async () => {
              await prepare();
              // Closing aborts pending restores; do not wait for them before cancellation.
              await client.close();
              await initialization?.catch(() => {});
            })(),
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

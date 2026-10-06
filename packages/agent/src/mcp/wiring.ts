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
import { monitorArmed } from '../watch';
import type { ClientFactory } from './main';

export function createRealClientFactory(env: NodeJS.ProcessEnv, deps: {
  platform?: NodeJS.Platform;
  createClient?: typeof createKhalaAgentClient;
  createWaker?: typeof createCodexWaker;
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
      if (harness !== 'qwen' || (deps.platform ?? process.platform) !== 'win32') return undefined;
      const settings = await readWakeSettings(stateRoot(env));
      if (!await qwenInboundAllowed(env) || settings.off['qwen/socket']) return undefined;
      const rows = await wakeStatus(harness, { env, files, sessionId });
      if (rows.some(row => row.state === 'held' || row.state === 'disabled')) return undefined;
      const installed = await readJson<{ command?: string }>(path.join(stateRoot(env), 'qwen', 'watch-command.json'));
      if (!installed?.command || await monitorArmed(files)) return undefined;
      return `Arm run_shell_command with ${JSON.stringify({ command: installed.command + ' --session ' + sessionId, is_background: true })}. When it completes, call khala_read, then re-arm the same one-shot watcher.`;
    };
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
      async join(link, label) { await initialize(); const joined = await client.join(link, label); return { ...joined, ...(joined.state === 'connected' ? { watcherHint: await watcherHint() } : {}) }; },
      async status(channel) {
        await initialize();
        const status = await (channel === undefined ? client.status() : client.status(channel));
        let idleWake;
        try { idleWake = selectedWakeStatus(await wakeStatus(harness, { env, files, sessionId })); }
        catch { idleWake = wakeStatusText(drivers?.[0]?.id ?? 'watcher', 'unavailable', 'wake_status_unavailable'); }
        const withWake = { ...status, idleWake };
        const hint = await watcherHint();
        return watcherStatus && ['connected', 'send_failed'].includes(withWake.state)
          ? { ...withWake, watcherArmed: await monitorArmed(files), ...(hint ? { watcherHint: hint } : {}) } : withWake;
      },
      async read(limit, before, channel) {
        await initialize();
        const result = await (channel === undefined ? client.read(limit, before) : client.read(limit, before, channel));
        const wakeNotice = await wakeDisableNotice(files.dir);
        return { ...result, ...(wakeNotice ? { wakeNotice } : {}) };
      },
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

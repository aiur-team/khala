import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createKhalaAgentClient } from '../client-impl';
import { ensureStateDir, removeStateFile, sessionFiles } from '../state';
import { createCodexWaker } from '../wake/codex';
import { monitorArmed } from '../watch';
import type { ClientFactory } from './main';

export function createRealClientFactory(env: NodeJS.ProcessEnv, deps: {
  createClient?: typeof createKhalaAgentClient;
  createWaker?: typeof createCodexWaker;
} = {}): ClientFactory {
  return ({ harness, sessionId }) => {
    const files = sessionFiles(harness, sessionId, env);
    const waker = harness === 'codex'
      ? (deps.createWaker ?? createCodexWaker)({ files, threadId: sessionId }) : undefined;
    const client = (deps.createClient ?? createKhalaAgentClient)({ harness, sessionId, env,
      ...(waker ? { onInboxAppend: () => waker.notify() } : {}) });
    // The client initializes lazily. Clear the previous process's join before
    // delegating any operation, so an expired join cannot reject a fresh one.
    let initialization: Promise<void> | undefined;
    const initialize = () => initialization ??= (async () => {
      await ensureStateDir(files.dir);
      await removeStateFile(files.dir, 'join.json');
      const joinsDir = path.join(files.dir, 'joins');
      await ensureStateDir(joinsDir);
      await fs.rm(joinsDir, { recursive: true, force: true });
    })();
    return {
      async join(link, label) { await initialize(); return client.join(link, label); },
      async status(channel) {
        await initialize();
        const status = await (channel === undefined ? client.status() : client.status(channel));
        return harness === 'claude' && ['connected', 'send_failed'].includes(status.state)
          ? { ...status, watcherArmed: await monitorArmed(files) } : status;
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

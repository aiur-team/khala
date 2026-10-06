import path from 'node:path';
import { stateRoot, writeJsonAtomic } from '../state';
import { claudeStyleCodec } from './codecs/claude-style';
import { readWakeSettings } from '../wake/shared';
import type { WakeDriver } from '../wake/driver';
import type { HarnessAdapter } from './adapter';
import { hookMapSource } from './session-sources';
import { createQwenSocketDriver, qwenInboundAllowed, qwenSession } from '../wake/qwen-socket';
import { verifyQwenTranscript } from '../wake/qwen-transcript';

/** Qwen background subagents share the parent session id; do not consume its inbox. */
export const qwenCodec = {
  ...claudeStyleCodec,
  parse(stdin: string) {
    try { if (JSON.parse(stdin)?.agent_id !== undefined) return null; } catch { return null; }
    return claudeStyleCodec.parse(stdin);
  },
};

export function createQwenBackgroundDriver(platform: NodeJS.Platform = process.platform): WakeDriver {
  return {
    id: 'background-shell', rung: 2, optIn: false, minIdleMs: 0, deadlineMs: 30_000, verification: 'none',
    async available(ctx) {
      const settings = await readWakeSettings(stateRoot(ctx.env));
      return platform === 'win32' && !settings.off['qwen/socket'] && !settings.off['qwen/background-shell']
        && await qwenInboundAllowed(ctx.env)
        && await (await import('../watch')).monitorArmed(ctx.files);
    },
    async unavailableReason(ctx) {
      if (!await qwenInboundAllowed(ctx.env)) return 'qwen_held';
      return platform === 'win32' ? 'qwen_watcher_missing' : 'driver_missing';
    },
    // Qwen itself owns the background tool. Khala never launches or injects input.
    wake: () => 'skipped',
  };
}

export const qwen: HarnessAdapter = {
  id: 'qwen', codec: qwenCodec, restoreAtStartup: true,
  sessionSources: [{ kind: 'meta', resolve: meta => meta?.khala_session, rejoinable: () => true }, { kind: 'env', resolve: (_meta, env) => qwenSession(env), rejoinable: () => true }, hookMapSource],
  install: async (flags, deps) => (await import('../install/main')).runQwenInstall(flags, deps),
  uninstall: async (flags, deps) => (await import('../install/main')).runQwenInstall([...flags, '--uninstall'], deps),
  wakeLadder: [createQwenSocketDriver(), createQwenBackgroundDriver()],
  async verifyWake(stdin, files, now) {
    const input = JSON.parse(stdin);
    if (typeof input.transcript_path !== 'string') return;
    // Retain the Qwen-provided transcript path so the waker can observe native
    // delivery while a long turn is still running. Stop remains the hook verifier.
    await writeJsonAtomic(path.join(files.dir, 'qwen-transcript.json'), { path: input.transcript_path });
    if (input.hook_event_name === 'Stop') await verifyQwenTranscript(files.dir, input.transcript_path, now);
  },
};

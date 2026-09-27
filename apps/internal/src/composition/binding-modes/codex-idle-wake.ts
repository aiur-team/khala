import type { SessionBinding } from '@khala/contracts/delivery/index';
import { listeningModeView } from '@khala/policy/listening-mode/store';
import { createCodexIdleActivity } from '@aiur/khala/composition/codex-idle-activity';
import { internalSessionDigest } from '@aiur/khala/composition/internal-session';
import { setupEnvironment } from '@aiur/khala/setup/environment';
import { createCodexIdleWake, type CodexIdleWakePort } from '@khala/harnesses/codex/idle-wake';
import { createCodexQueueProcessPort } from '@khala/harnesses/codex/idle-wake-process';
import type { SqliteListeningModeRepository } from '../../listening-mode-store/sqlite';
import type { ChannelStore } from '../../store/channel-store';
import type { BindingPauseStore } from '../../store/pause-store';
import type { ServerHarnessCapabilities } from './capabilities';

/** The long-lived owner server performs the native effect inside Stop's revocation barrier. */
export function composeCodexIdleWake(input: Readonly<{
  store: ChannelStore;
  modes: SqliteListeningModeRepository;
  pause: BindingPauseStore;
  harnesses: ServerHarnessCapabilities;
  stateDirectory: string;
  env?: NodeJS.ProcessEnv;
  port?: CodexIdleWakePort;
  revocationPollMs?: number;
}>): (binding: SessionBinding, sessionId: string, notBarred: () => boolean) => Promise<void> {
  const env = input.env ?? process.env;
  const activity = createCodexIdleActivity(input.stateDirectory);
  const executable = input.port ? Promise.resolve(null) : setupEnvironment(env).probe.resolveExecutable('codex').catch(() => null);
  const wakes = new Map<string, Readonly<{ wake: ReturnType<typeof createCodexIdleWake>; setEpoch: (epoch: string) => void }>>();
  const noticed = new Map<string, string>();
  const key = (binding: SessionBinding) => JSON.stringify([binding.bindingId, binding.generation]);
  const allowed = (binding: SessionBinding, sessionId: string): 'steer' | 'sync' | null => {
    if (binding.harness !== 'codex' || binding.sessionId !== internalSessionDigest('codex', sessionId)) return null;
    const live = input.store.sessionBinding({ bindingId: binding.bindingId, harness: 'codex', sessionId: binding.sessionId });
    if (live.kind !== 'done' || live.binding?.generation !== binding.generation || input.pause.read(binding) !== false) return null;
    const record = input.modes.read(binding);
    const capabilities = input.harnesses.capabilities(binding);
    if (record.kind !== 'record' || capabilities?.support !== 'tested') return null;
    const view = listeningModeView(record.control, capabilities);
    return view.requested === view.effective && (view.effective === 'steer' || view.effective === 'sync')
      ? view.effective : null;
  };
  return async (binding, sessionId, notBarred) => {
    if (!notBarred()) return;
    const mode = allowed(binding, sessionId);
    if (mode === null) return;
    const epoch = await activity.idleEpoch(binding);
    if (epoch === null || noticed.get(key(binding)) === epoch) return;
    let composed = wakes.get(key(binding));
    if (composed === undefined) {
      const command = await executable;
      if (!input.port && command === null) return;
      let targetEpoch = epoch;
      const wake = createCodexIdleWake({
        port: input.port ?? createCodexQueueProcessPort({ command: command!, env }),
        isCurrent: async native => notBarred() && allowed(binding, native.sessionId) !== null,
        isIdle: async () => (await activity.idleEpoch(binding)) === targetEpoch,
        ...(input.revocationPollMs === undefined ? {} : { revocationPollMs: input.revocationPollMs }),
      });
      composed = { wake, setEpoch: value => { targetEpoch = value; } };
      wakes.set(key(binding), composed);
    }
    composed.setEpoch(epoch);
    noticed.set(key(binding), epoch);
    const outcome = await composed.wake.wake({ ...binding, sessionId }, mode, input.harnesses.capabilities(binding)!.version);
    if (outcome === 'queue_failed' && noticed.get(key(binding)) === epoch) noticed.delete(key(binding));
  };
}

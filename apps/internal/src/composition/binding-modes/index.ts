import { createHash } from 'node:crypto';
import type { HarnessCapabilities, SessionBinding } from '@khala/contracts/delivery/index';
import type { RoomId } from '@khala/contracts/messaging/index';
import type { CodexIdleWakePort } from '@khala/harnesses/codex/idle-wake';
import { createListeningModeService, listeningModeView } from '@khala/policy/listening-mode/store';
import { LOCAL_AUTOMATION_LIMITS } from '@khala/policy/listening-mode/limits';
import { type SqliteListeningModeRepository, createSqliteListeningModeRepository } from '../../listening-mode-store/sqlite';
import type { BindingModeOptions } from '../../server/binding-mode';
import type { AgentReleaseFeed } from '../../server/channel-server';
import type { ChannelStore } from '../../store/channel-store';
import type { InternalStoreHandle } from '../../store/open';
import { type BindingPauseStore, createBindingPauseStore } from '../../store/pause-store';
import { createInternalReleaseFeed } from '../internal-delivery/release-feed';
import { createLocalListeningModeStore } from '../local-transport/listening-mode-store';
import { createCodexIdleActivity } from '@aiur/khala/composition/codex-idle-activity';
import { internalSessionDigest } from '@aiur/khala/composition/internal-session';
import { readOpenCodeTerminalId } from '@aiur/khala/composition/internal-turn-end';
import { createServerHarnessCapabilities } from './capabilities';
import { composeCodexIdleWake } from './codex-idle-wake';
import { createLocalAutomationProvider } from '../local-automation/provider';
import { createLocalAutomationLedger } from '../local-automation/ledger';
import type { HarnessObservation } from '../../server/binding-mode';

// Listening modes and pause for one internal channel store. The release feed, the
// owner's control and the agent's control all read and write the same SQLite mode
// record and the same pause record, so a change from either side takes effect on
// the next pull without any cache to invalidate.

export type BindingModesComposition = Readonly<{
  listeningModes: SqliteListeningModeRepository;
  pause: BindingPauseStore;
  /** A granted binding pulls its releases into its own inbox; nothing is pushed. A pause holds the feed before any claim. */
  releases: AgentReleaseFeed;
  /** Owner and agent mode control, plus the owner's pause. */
  control: BindingModeOptions;
}>;

function terminalEpoch(terminalId: string): string {
  const hash = createHash('sha256').update('khala-local-terminal-v1\0').update(terminalId).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export function composeBindingModes(input: Readonly<{
  handle: InternalStoreHandle;
  store: ChannelStore;
  stateDirectory: string;
  /** The launch's Claude route claim; absent, Claude is unproven. */
  claude?: HarnessCapabilities;
  /** Injected external inspection and queue effects for composition tests. */
  codexWake?: Readonly<{
    inspect: (binding: SessionBinding) => Promise<HarnessObservation | null>;
    port: CodexIdleWakePort;
  }>;
}>): BindingModesComposition {
  const listeningModes = createSqliteListeningModeRepository(input.handle);
  const pause = createBindingPauseStore(input.handle);
  const harnesses = createServerHarnessCapabilities(input.claude, {
    handle: input.handle, ...(input.codexWake ? { inspectCodex: input.codexWake.inspect } : {}),
  });
  const automation = createLocalAutomationLedger(input.handle, createLocalAutomationProvider(LOCAL_AUTOMATION_LIMITS));
  const codexActivity = createCodexIdleActivity(input.stateDirectory);
  const modeView = (binding: SessionBinding) => {
    const control = listeningModes.read(binding);
    return control.kind === 'record' ? listeningModeView(control.control, harnesses.capabilities(binding)) : null;
  };
  const claimedTerminalEpoch = (binding: SessionBinding): string | null => {
    if (binding.harness === 'codex') return codexActivity.idleEpochSync(binding);
    if (binding.harness === 'opencode') {
      const id = readOpenCodeTerminalId(input.stateDirectory, binding);
      return id === null ? null : terminalEpoch(id);
    }
    return null;
  };
  const reservePeer = (binding: SessionBinding, event: Parameters<NonNullable<BindingModeOptions['peerWake']>>[1]) => {
    const result = automation.reserve({ recipient: binding, event, mode: modeView(binding),
      claimedIdleEpoch: claimedTerminalEpoch(binding) });
    return result.kind === 'held' ? result.reason : result.state === 'reserved';
  };
  const pendingPeer = (binding: SessionBinding, channelId: string) => {
    if (binding.harness === 'codex' && codexActivity.idleEpochSync(binding) === null) return false;
    const result = automation.nextPending({ recipient: binding, channelId, mode: modeView(binding),
      claimedIdleEpoch: claimedTerminalEpoch(binding) });
    return result !== null && result.kind !== 'held' && result.state === 'reserved';
  };
  const idleWake = composeCodexIdleWake({ store: input.store, modes: listeningModes, pause,
    harnesses, stateDirectory: input.stateDirectory,
    ...(input.codexWake ? { port: input.codexWake.port } : {}) });
  return {
    listeningModes,
    pause,
    releases: createInternalReleaseFeed({ store: input.store, listeningModes, paused: binding => pause.read(binding),
      peerAutomation: { reserve(binding, event) {
        const result = reservePeer(binding, event);
        return result === true ? 'wake' : result === 'busy' ? 'busy' : 'held';
      } },
    }),
    control: {
      modes: createListeningModeService(createLocalListeningModeStore(listeningModes)),
      pause,
      capabilities: harnesses.capabilities,
      observe: harnesses.observe,
      idleWake,
      idleSession: async binding => (await codexActivity.idleSession(binding))?.sessionId ?? null,
      turnEnd: async (binding, sessionId, channelId, terminalId, notBarred) => {
        if (binding.harness === 'opencode') {
          if (!terminalId || binding.sessionId !== internalSessionDigest('opencode', sessionId)
            || !notBarred() || readOpenCodeTerminalId(input.stateDirectory, binding) !== terminalId) return false;
          const live = input.store.sessionBinding({ bindingId: binding.bindingId, harness: binding.harness,
            sessionId: binding.sessionId });
          if (live.kind !== 'done' || live.binding?.generation !== binding.generation
            || input.store.channel({ channelId: channelId as RoomId,
              participantId: binding.agentParticipantId }).kind !== 'done' || !notBarred()) return false;
          automation.finishEnded({ recipient: binding, channelId, epoch: terminalEpoch(terminalId) });
          pendingPeer(binding, channelId);
          return true;
        }
        const idle = await codexActivity.idleSession(binding);
        if (binding.harness !== 'codex' || binding.sessionId !== internalSessionDigest('codex', sessionId)
          || terminalId !== null || !notBarred() || idle?.sessionId !== sessionId
          || !await harnesses.revalidateCodex(binding) || !notBarred()) return false;
        const live = input.store.sessionBinding({ bindingId: binding.bindingId, harness: binding.harness,
          sessionId: binding.sessionId });
        if (live.kind !== 'done' || live.binding?.generation !== binding.generation
          || input.store.channel({ channelId: channelId as RoomId,
            participantId: binding.agentParticipantId }).kind !== 'done') return false;
        automation.finishEnded({ recipient: binding, channelId, epoch: idle.epoch });
        if (notBarred() && pendingPeer(binding, channelId)) await idleWake(binding, sessionId, notBarred);
        return true;
      },
      peerWake: (binding, event) => binding.harness === 'codex' && codexActivity.idleEpochSync(binding) !== null
        && reservePeer(binding, event) === true,
      peerPending: pendingPeer,
    },
  };
}

import type { ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import { isCurrentGeneration } from '@khala/contracts/messaging/outcomes';
import type { AgentPresence, AgentPresenceSnapshot, ChannelUiPort } from './ports';

export type ChannelAgentView = AgentPresence & Readonly<{
  installCommand: string | null;
  installCommandError: boolean;
}>;

/** @deprecated Use `ChannelAgentView`. Kept through the first tagged release containing #163. */
export type RoomAgentView = ChannelAgentView;

export type ChannelView = Readonly<{
  phase: 'loading' | 'ready' | 'unavailable';
  agents: readonly ChannelAgentView[];
}>;

/** @deprecated Use `ChannelView`. Kept through the first tagged release containing #163. */
export type RoomView = ChannelView;

export interface ChannelController {
  /** Cached, `useSyncExternalStore`-safe snapshot. */
  getSnapshot(): ChannelView;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/** @deprecated Use `ChannelController`. Kept through the first tagged release containing #163. */
export type RoomController = ChannelController;

export type ChannelControllerConfig = Readonly<{
  roomId: RoomId;
  generation: number;
}>;

/** @deprecated Use `ChannelControllerConfig`. Kept through the first tagged release containing #163. */
export type RoomControllerConfig = ChannelControllerConfig;

type InstallState = Readonly<{ command: string | null; error: boolean }>;

const EMPTY_INSTALL: InstallState = { command: null, error: false };

export function createChannelController(port: ChannelUiPort, config: ChannelControllerConfig): ChannelController {
  let view: ChannelView = { phase: 'loading', agents: [] };
  let disposed = false;
  let liveSnapshotSeen = false;
  const abortController = new AbortController();
  const listeners = new Set<() => void>();
  const installByParticipant = new Map<ParticipantId, InstallState>();
  const loadingInstall = new Set<ParticipantId>();

  function notify(): void {
    if (disposed) return;
    for (const listener of listeners) listener();
  }

  function projectAgents(agents: readonly AgentPresence[]): readonly ChannelAgentView[] {
    return agents.map(agent => {
      const install = installByParticipant.get(agent.participantId) ?? EMPTY_INSTALL;
      return {
        ...agent,
        installCommand: agent.connection === 'connected' ? null : install.command,
        installCommandError: agent.connection === 'connected' ? false : install.error,
      };
    });
  }

  function updateInstall(participantId: ParticipantId, install: InstallState): void {
    installByParticipant.set(participantId, install);
    const current = view.agents.find(agent => agent.participantId === participantId);
    if (!current || current.connection === 'connected' || disposed) return;
    view = {
      ...view,
      agents: view.agents.map(agent => agent.participantId === participantId
        ? { ...agent, installCommand: install.command, installCommandError: install.error }
        : agent),
    };
    notify();
  }

  function loadInstallCommands(agents: readonly AgentPresence[]): void {
    for (const agent of agents) {
      if (agent.connection === 'connected' || installByParticipant.has(agent.participantId) || loadingInstall.has(agent.participantId)) continue;
      loadingInstall.add(agent.participantId);
      void port.installCommand(agent.participantId, abortController.signal).then(
        command => {
          loadingInstall.delete(agent.participantId);
          updateInstall(agent.participantId, { command, error: false });
        },
        () => {
          loadingInstall.delete(agent.participantId);
          if (!abortController.signal.aborted) updateInstall(agent.participantId, { command: null, error: true });
        },
      );
    }
  }

  function applySnapshot(snapshot: AgentPresenceSnapshot): boolean {
    if (disposed || !isCurrentGeneration(config.generation, snapshot)) return false;
    for (const agent of snapshot.agents) {
      if (installByParticipant.get(agent.participantId)?.error) {
        installByParticipant.delete(agent.participantId);
      }
    }
    view = { phase: 'ready', agents: projectAgents(snapshot.agents) };
    notify();
    loadInstallCommands(snapshot.agents);
    return true;
  }

  // Subscribe before the initial read. A live snapshot received during that
  // read owns the state, so the older read result cannot roll presence back.
  const unsubscribe = port.subscribeAgents(config.roomId, snapshot => {
    if (applySnapshot(snapshot)) liveSnapshotSeen = true;
  });

  void port.agents(config.roomId, abortController.signal).then(
    snapshot => {
      if (disposed || liveSnapshotSeen) return;
      if (!applySnapshot(snapshot)) {
        view = { phase: 'unavailable', agents: [] };
        notify();
      }
    },
    () => {
      if (disposed || liveSnapshotSeen) return;
      view = { phase: 'unavailable', agents: [] };
      notify();
    },
  );

  function getSnapshot(): ChannelView {
    return view;
  }

  function subscribe(listener: () => void): () => void {
    if (disposed) return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    abortController.abort();
    unsubscribe();
    listeners.clear();
  }

  return { getSnapshot, subscribe, dispose };
}

/** @deprecated Use `createChannelController`. Kept through the first tagged release containing #163. */
export const createRoomController = createChannelController;

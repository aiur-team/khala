import type { ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import { isCurrentGeneration } from '@khala/contracts/messaging/outcomes';
import type { AgentPresence, AgentPresenceSnapshot, RoomUiPort } from './ports';

export type RoomAgentView = AgentPresence & Readonly<{
  installCommand: string | null;
  installCommandError: boolean;
}>;

export type RoomView = Readonly<{
  phase: 'loading' | 'ready' | 'unavailable';
  agents: readonly RoomAgentView[];
}>;

export interface RoomController {
  /** Cached, `useSyncExternalStore`-safe snapshot. */
  getSnapshot(): RoomView;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export type RoomControllerConfig = Readonly<{
  roomId: RoomId;
  generation: number;
}>;

type InstallState = Readonly<{ command: string | null; error: boolean }>;

const EMPTY_INSTALL: InstallState = { command: null, error: false };

export function createRoomController(port: RoomUiPort, config: RoomControllerConfig): RoomController {
  let view: RoomView = { phase: 'loading', agents: [] };
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

  function projectAgents(agents: readonly AgentPresence[]): readonly RoomAgentView[] {
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

  function getSnapshot(): RoomView {
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

// Disposable native proof only: pin the Codex app-server processes that own one
// already-bound TUI session. A shell tool is spawned by the daemon, not the TUI.
export type NativeProcessSnapshot = Readonly<{
  pid: number;
  parentPid: number;
  startTime: string;
  executable: string;
  cgroup: string;
  environment: readonly string[];
}>;

export type PinnedNativeDaemon = Pick<NativeProcessSnapshot, 'pid' | 'startTime' | 'executable' | 'cgroup'>;

export type NativeOriginScope = Readonly<{
  sessionId: string;
  cgroup: string;
  codexHome: string;
  fixtureRoot: string;
  daemons: readonly PinnedNativeDaemon[];
}>;

/** Returns the exact pinned daemon ancestor, or refuses a foreign/reused process. */
export function pinnedNativeAncestor(
  chain: readonly NativeProcessSnapshot[], scope: NativeOriginScope, sessionId: string,
): number | null {
  if (sessionId !== scope.sessionId || chain.length === 0 || chain[0]?.cgroup !== scope.cgroup) return null;
  for (const process of chain) {
    if (process.cgroup !== scope.cgroup) return null;
    const pinned = scope.daemons.find(item => item.pid === process.pid);
    if (pinned && pinned.startTime === process.startTime && pinned.executable === process.executable
      && pinned.cgroup === process.cgroup
      && process.environment.includes(`CODEX_HOME=${scope.codexHome}`)
      && process.environment.includes(`KHALA_42_SYNC_ROOT=${scope.fixtureRoot}`)) return process.pid;
  }
  return null;
}

/** Codex 0.157 may run shell tools in an isolated PID namespace (PID 2, parent 1). */
export function isolatedNativeModelCall(
  chain: readonly NativeProcessSnapshot[], scope: NativeOriginScope, sessionId: string,
  ackDigest: string, modelAckDigests: ReadonlySet<string>, currentBatchAckDigest: string,
): boolean {
  const worker = chain[0];
  return sessionId === scope.sessionId && chain.length === 1 && worker !== undefined
    && worker.parentPid === 1 && worker.cgroup === scope.cgroup
    && worker.environment.includes(`CODEX_HOME=${scope.codexHome}`)
    && worker.environment.includes(`KHALA_42_SYNC_ROOT=${scope.fixtureRoot}`)
    && ackDigest === currentBatchAckDigest && modelAckDigests.has(ackDigest);
}

import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { readJson, writeJsonAtomic, type SessionFiles } from '../../state';
import { nearestNonShellAncestor, readProcess, type ProcessReader } from '../../harness/proc';

export type PaneCapture = {
  kind: 'tmux' | 'wezterm';
  paneId: string;
  socket?: string;
  agentPid: number;
  capturedAt: string;
  agentStartTime?: string;
};

function validPane(value: unknown): value is PaneCapture {
  if (!value || typeof value !== 'object') return false;
  const pane = value as PaneCapture;
  return typeof pane.paneId === 'string' && (pane.kind === 'tmux' ? /^%\d+$/.test(pane.paneId) : pane.kind === 'wezterm' && /^\d+$/.test(pane.paneId))
    && Number.isSafeInteger(pane.agentPid) && pane.agentPid > 0
    && typeof pane.capturedAt === 'string' && Number.isFinite(Date.parse(pane.capturedAt))
    && (pane.socket === undefined || (pane.kind === 'tmux' && typeof pane.socket === 'string' && pane.socket.startsWith('/') && !pane.socket.includes('\0')))
    && (pane.agentStartTime === undefined || (typeof pane.agentStartTime === 'string' && pane.agentStartTime.length > 0));
}

export async function readPane(files: SessionFiles): Promise<PaneCapture | null> {
  const pane = await readJson<unknown>(path.join(files.dir, 'pane.json'));
  return validPane(pane) ? pane : null;
}

/** Call only from a session-start or prompt hook, never from the MCP process. */
export async function capturePane(files: SessionFiles, env: NodeJS.ProcessEnv,
  options: { pid?: number; readProcess?: ProcessReader; now?: () => Date; platform?: NodeJS.Platform } = {}): Promise<PaneCapture | null> {
  const file = path.join(files.dir, 'pane.json');
  const clear = async (): Promise<null> => {
    // A hook outside the captured host invalidates its previous target immediately.
    await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return null;
  };
  if ((options.platform ?? process.platform) === 'win32') return clear();
  let target: Pick<PaneCapture, 'kind' | 'paneId' | 'socket'>;
  if (env.TMUX) {
    const socket = env.TMUX.match(/^(.*),\d+,\d+$/)?.[1];
    if (!socket?.startsWith('/') || socket.includes('\0') || !/^%\d+$/.test(env.TMUX_PANE ?? '')) return clear();
    target = { kind: 'tmux', paneId: env.TMUX_PANE!, socket };
  } else if (/^\d+$/.test(env.WEZTERM_PANE ?? '')) target = { kind: 'wezterm', paneId: env.WEZTERM_PANE! };
  else return clear();
  const agent = await nearestNonShellAncestor(options.pid ?? process.pid, options.readProcess ?? readProcess);
  if (!agent) return clear();
  const pane: PaneCapture = { ...target, agentPid: agent.pid, agentStartTime: agent.startTime, capturedAt: (options.now ?? (() => new Date()))().toISOString() };
  if (!validPane(pane)) return clear();
  await writeJsonAtomic(file, pane);
  return pane;
}

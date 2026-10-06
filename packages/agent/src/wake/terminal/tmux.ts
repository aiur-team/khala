import type { PaneCapture } from './capture';
import type { CommandRunner } from './process';
import { ancestors, type ProcessReader } from '../../harness/proc';

export type PaneView = { tty: string; cursorX: number; cursorY: number; line: string };
export function tmuxArgv(pane: PaneCapture, argv: readonly string[]): string[] {
  return [...(pane.socket ? ['-S', pane.socket] : []), ...argv];
}
export async function inspectTmux(pane: PaneCapture, run: CommandRunner, env: NodeJS.ProcessEnv,
  signal: AbortSignal, readProcess: ProcessReader): Promise<PaneView | null> {
  const query = await run('tmux', tmuxArgv(pane, ['display-message', '-p', '-t', pane.paneId,
    '#{pane_pid}|#{pane_in_mode}|#{pane_input_off}|#{cursor_x}|#{cursor_y}|#{pane_tty}|#{pane_synchronized}']), env, signal);
  // tmux sanitizes control characters in format strings; printable separators
  // survive its real CLI. pane_synchronized also resolves inherited defaults.
  const fields = query.trim().split('|');
  if (fields.length !== 7 || fields[1] !== '0' || fields[2] !== '0' || fields[6] !== '0') return null;
  const pid = Number(fields[0]), cursorX = Number(fields[3]), cursorY = Number(fields[4]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(cursorX) || cursorX < 0
    || !Number.isSafeInteger(cursorY) || cursorY < 0 || !fields[5]) return null;
  if (pid !== pane.agentPid && !(await ancestors(pane.agentPid, readProcess)).some(parent => parent.pid === pid)) return null;
  const line = await run('tmux', tmuxArgv(pane, ['capture-pane', '-p', '-e', '-t', pane.paneId,
    '-S', String(cursorY), '-E', String(cursorY)]), env, signal);
  return { tty: fields[5], cursorX, cursorY, line };
}
export async function sendTmux(pane: PaneCapture, text: string, enter: boolean, run: CommandRunner,
  env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  await run('tmux', tmuxArgv(pane, ['send-keys', '-t', pane.paneId, ...(enter ? ['Enter'] : ['-l', text])]), env, signal);
}

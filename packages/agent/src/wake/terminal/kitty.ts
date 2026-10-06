import { ancestors, type ProcessReader } from '../../harness/proc';
import type { PaneCapture } from './capture';
import type { CommandRunner } from './process';
import type { PaneView } from './tmux';

export function kittyArgv(pane: PaneCapture, args: readonly string[]): string[] {
  if (!pane.socket?.startsWith('unix:') || pane.socket.length <= 5 || pane.socket.includes('\0')) throw new Error('kitty_unix_socket_required');
  return ['@', '--to', pane.socket, ...args];
}

export async function inspectKitty(pane: PaneCapture, run: CommandRunner, env: NodeJS.ProcessEnv,
  signal: AbortSignal, read: ProcessReader): Promise<{ view?: PaneView; reason?: string }> {
  try {
    const windows = JSON.parse(await run('kitten', kittyArgv(pane, ['ls']), env, signal));
    const matches = windows.flatMap((os: { tabs: { windows: { id: number; foreground_processes: { pid: number }[] }[] }[] }) => os.tabs.flatMap(tab => tab.windows))
      .filter((window: { id: number }) => String(window.id) === pane.paneId);
    if (matches.length !== 1) return { reason: 'kitty_window_missing' };
    const foreground = matches[0].foreground_processes;
    if (!Array.isArray(foreground) || foreground.length === 0) return { reason: 'kitty_foreground_unavailable' };
    for (const process of foreground) {
      if (!Number.isSafeInteger(process.pid) || process.pid <= 0 || (process.pid !== pane.agentPid
        && !(await ancestors(process.pid, read)).some(parent => parent.pid === pane.agentPid))) return { reason: 'kitty_window_not_owned' };
    }
    // ls has no TTY field. Query the foreground process's kernel TTY, never a title.
    const ttyName = (await run('ps', ['-o', 'tty=', '-p', String(foreground[0].pid)], { ...env, LC_ALL: 'C' }, signal)).trim();
    if (!/^(?:pts\/\d+|tty[^\s/]+)$/.test(ttyName)) return { reason: 'kitty_tty_unavailable' };
    const screen = await run('kitten', kittyArgv(pane, ['get-text', '--match', `id:${pane.paneId}`, '--extent', 'screen', '--ansi', '--add-cursor']), env, signal);
    const cursor = /\x1b\[\?25[hl]\x1b\[(\d+);(\d+)H(?:\x1b\[\?12[hl]|\x1b\[[1-6] q)\n?$/.exec(screen);
    if (!cursor) return { reason: 'kitty_cursor_unavailable' };
    const cursorY = Number(cursor[1]) - 1, cursorX = Number(cursor[2]) - 1;
    const rows = screen.slice(0, cursor.index).split('\n');
    if (!Number.isSafeInteger(cursorX) || cursorX < 0 || !Number.isSafeInteger(cursorY) || cursorY < 0 || cursorY >= rows.length)
      return { reason: 'kitty_cursor_unavailable' };
    // Preserve inherited SGR attributes from prior rows for the prompt guard.
    const styling = rows.slice(0, cursorY).join('\n').match(/\x1b\[[0-9;:]*m/g)?.join('') ?? '';
    return { view: { tty: `/dev/${ttyName}`, cursorX, cursorY, line: styling + rows[cursorY] } };
  } catch (error) {
    return { reason: error instanceof Error && error.message === 'kitty_unix_socket_required' ? error.message : 'kitty_probe_failed' };
  }
}

export async function sendKitty(pane: PaneCapture, text: string, enter: boolean, run: CommandRunner,
  env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  // send-text interprets escapes. Escape literal backslashes; encode the separate CR.
  await run('kitten', kittyArgv(pane, ['send-text', '--match', `id:${pane.paneId}`, '--', enter ? '\\r' : text.replace(/\\/g, '\\\\')]), env, signal);
}

import type { PaneCapture } from './capture';
import type { CommandRunner } from './process';
import type { PaneView } from './tmux';

export async function inspectWezterm(pane: PaneCapture, run: CommandRunner, env: NodeJS.ProcessEnv,
  signal: AbortSignal): Promise<{ view?: PaneView; reason?: string }> {
  const rows: unknown = JSON.parse(await run('wezterm', ['cli', 'list', '--format', 'json'], env, signal));
  if (!Array.isArray(rows)) return { reason: 'wezterm_pane_missing' };
  const row = rows.find(value => value && typeof value === 'object' && String(value.pane_id) === pane.paneId);
  if (!row) return { reason: 'wezterm_pane_missing' };
  if (typeof row.tty_name !== 'string' || !row.tty_name) return { reason: 'wezterm_tty_unavailable' };
  if (!Number.isSafeInteger(row.cursor_x) || row.cursor_x < 0 || !Number.isSafeInteger(row.cursor_y) || row.cursor_y < 0)
    return { reason: 'wezterm_cursor_unavailable' };
  // Cursor row is authoritative: footer/transcript lines cannot stand in for the composer.
  const line = await run('wezterm', ['cli', 'get-text', '--pane-id', pane.paneId, '--escapes',
    '--start-line', String(row.cursor_y), '--end-line', String(row.cursor_y)], env, signal);
  // lines_to_escapes emits a row CRLF, a reset, then println adds LF.
  // Strip only that framing and ASCII charset resets; preserve SGR dim evidence.
  const captured = line.replace(/\r\n(?:\x1b(?:\[[0-9;:]*m|\(B))*\n$/, '').replace(/\x1b\(B/g, '');
  return { view: { tty: row.tty_name, cursorX: row.cursor_x, cursorY: row.cursor_y, line: captured } };
}
export async function sendWezterm(pane: PaneCapture, text: string, enter: boolean, run: CommandRunner,
  env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  await run('wezterm', ['cli', 'send-text', '--pane-id', pane.paneId, '--no-paste', enter ? '\r' : text], env, signal);
}

import { fileURLToPath } from 'node:url';
import type { PaneCapture } from './capture';
import type { CommandRunner } from './process';
import type { PaneView } from './tmux';

export function iterm2ScriptPath(): string {
  // esbuild chunks and the helper sit beside the running dist/khala.mjs.
  return fileURLToPath(new URL('./iterm2_send.py', import.meta.url));
}
export async function inspectIterm2(pane: PaneCapture, run: CommandRunner, env: NodeJS.ProcessEnv,
  signal: AbortSignal): Promise<{ view?: PaneView; reason?: string }> {
  try {
    const view = JSON.parse(await run('python3', [iterm2ScriptPath(), pane.paneId], env, signal));
    if (view.reason) return { reason: view.reason };
    if (typeof view.tty !== 'string' || !/^\/dev\/tty[^\s/]+$/.test(view.tty)) return { reason: 'iterm2_tty_unavailable' };
    if (typeof view.line !== 'string' || !Number.isSafeInteger(view.cursorX) || view.cursorX < 0
      || !Number.isSafeInteger(view.cursorY) || view.cursorY < 0) return { reason: 'iterm2_cursor_unavailable' };
    return { view };
  } catch { return { reason: 'iterm2_python_api_unavailable' }; }
}
export async function sendIterm2(pane: PaneCapture, text: string, enter: boolean, run: CommandRunner,
  env: NodeJS.ProcessEnv, signal: AbortSignal, expected?: PaneView): Promise<'skipped' | void> {
  if (!expected) return 'skipped';
  const result = JSON.parse(await run('python3', [iterm2ScriptPath(), pane.paneId, enter ? '\r' : text, JSON.stringify(expected)], env, signal));
  if (result.status === 'not_empty') return 'skipped';
  if (result.status !== 'sent') throw new Error('iterm2_send_failed');
}

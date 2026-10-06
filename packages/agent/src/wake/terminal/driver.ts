import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readActivity } from '../../activity';
import { readJson, stateRoot } from '../../state';
import { readProcess, type ProcessReader } from '../../harness/proc';
import type { WakeDriver, WakeDriverContext } from '../driver';
import { driverAllowed, readWakeState, wakeLine, failAttempt } from '../shared';
import { readPane, type PaneCapture } from './capture';
import { isEmptyPrompt, type EmptyPrompt } from './prompt-guard';
import { ownsTerminal, runTerminalCommand, type CommandRunner } from './process';
import { inspectTmux, sendTmux, tmuxArgv, type PaneView } from './tmux';
import { inspectWezterm, sendWezterm } from './wezterm';

export type TerminalDriverDeps = {
  run?: CommandRunner;
  readProcess?: ProcessReader;
  ownsTerminal?: typeof ownsTerminal;
  platform?: NodeJS.Platform;
  delay?: (signal: AbortSignal) => Promise<void>;
};

/**
 * The composer text before the cursor on an empty prompt row. tmux and real
 * terminals drop trailing blank cells when capturing (`❯ ` comes back as `❯`),
 * so restore the spacing up to the guarded cursor column. Only ASCII spaces are
 * added; captured cells such as Claude's U+00A0 are kept as-is.
 */
export function promptPrefix(captured: string, cursorColumn: number): string {
  return captured.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r?\n$/, '').slice(0, cursorColumn).padEnd(cursorColumn, ' ');
}

export function createTerminalWakeDriver(guard?: EmptyPrompt, deps: TerminalDriverDeps = {}): WakeDriver {
  const run = deps.run ?? runTerminalCommand;
  const read = deps.readProcess ?? readProcess;
  const platform = deps.platform ?? process.platform;
  const probe = async (ctx: WakeDriverContext, empty: boolean, cleanup = false): Promise<{ pane?: PaneCapture; view?: PaneView; reason?: string }> => {
    if (ctx.signal.aborted) return { reason: 'terminal_aborted' };
    if (platform !== 'linux' && platform !== 'darwin') return { reason: 'terminal_unavailable_on_platform' };
    if (!guard) return { reason: 'terminal_empty_prompt_unavailable' };
    if (!cleanup && !await driverAllowed(stateRoot(ctx.env), ctx.harness, 'terminal', true)) return { reason: 'terminal_consent_required' };
    if (!cleanup && (await readWakeState(ctx.files.dir)).terminal?.disabled) return { reason: 'nonce_timeout' };
    const pane = await readPane(ctx.files);
    if (!pane) return { reason: ctx.harness === 'codex' && (ctx.env.TMUX || ctx.env.WEZTERM_PANE)
      ? 'terminal_capture_pending_prompt' : 'no remote-control API' };
    const activity = await readActivity(ctx.files);
    // Do not let the test idle override weaken this transport's safety boundary.
    if (!cleanup && (activity.state !== 'idle' || ctx.now - Date.parse(activity.updatedAt) < 30_000)) return { reason: 'terminal_not_idle' };
    const agent = await read(pane.agentPid);
    if (!agent || (pane.agentStartTime !== undefined && pane.agentStartTime !== agent.startTime)) return { reason: 'terminal_agent_exited' };
    const inspection: { view?: PaneView | undefined; reason?: string } = pane.kind === 'tmux'
      ? { view: await inspectTmux(pane, run, ctx.env, ctx.signal, read) ?? undefined }
      : await inspectWezterm(pane, run, ctx.env, ctx.signal);
    const view = inspection.view;
    if (!view) return { reason: inspection.reason ?? 'terminal_pane_unsafe' };
    if (!await (deps.ownsTerminal ?? ownsTerminal)(pane.agentPid, view.tty, ctx.env, ctx.signal, run, platform))
      return { reason: 'terminal_pane_not_owned' };
    if (empty && !isEmptyPrompt(view.line, view.cursorX, guard)) return { reason: 'terminal_prompt_not_empty' };
    return { pane, view };
  };
  const safeProbe = async (ctx: WakeDriverContext, empty: boolean, cleanup = false) => {
    try { return await probe(ctx, empty, cleanup); }
    catch { return { reason: 'terminal_probe_failed' }; }
  };
  return {
    id: 'terminal', rung: 4, optIn: true, minIdleMs: 30_000, deadlineMs: 10_000, verification: 'nonce',
    available: async ctx => !!(await safeProbe(ctx, true)).pane,
    unavailableReason: async ctx => (await safeProbe(ctx, true)).reason,
    async wake(ctx, line) {
      // The transport boundary accepts only the U11 fixed literal, regardless of caller or inbox contents.
      const nonce = /\(k-([a-f0-9]{8})\)$/.exec(line)?.[1];
      if (!nonce || wakeLine(nonce) !== line) throw new TypeError('invalid_terminal_wake_line');
      const activity = await readActivity(ctx.files);
      const ready = await safeProbe(ctx, true);
      if (!ready.pane || ctx.signal.aborted) return 'skipped';
      const beforeSend = await readActivity(ctx.files);
      if (beforeSend.state !== 'idle' || beforeSend.updatedAt !== activity.updatedAt) return 'skipped';
      const send = ready.pane.kind === 'tmux' ? sendTmux : sendWezterm;
      await send(ready.pane, line, false, run, ctx.env, ctx.signal);
      const sameComposer = (final: Awaited<ReturnType<typeof safeProbe>>) => {
        if (!final.pane || !final.view || final.pane.agentPid !== ready.pane!.agentPid
          || final.pane.agentStartTime !== ready.pane!.agentStartTime || final.pane.capturedAt !== ready.pane!.capturedAt
          || final.view.tty !== ready.view!.tty || final.pane.kind !== ready.pane!.kind
          || final.pane.paneId !== ready.pane!.paneId || final.pane.socket !== ready.pane!.socket) return false;
        const text = final.view.line.replace(/\x1b\[[0-9;]*m/g, '').replace(/[ \r\n]+$/, '');
        return text === `${promptPrefix(ready.view!.line, guard!.cursorColumn)}${line}` && final.view.cursorY === ready.view!.cursorY
          && final.view.cursorX === guard!.cursorColumn + line.length;
      };
      // Revoked consent or new activity prohibits submission, but not removing our
      // exact insertion. Cleanup still requires the original owner, normal modes,
      // pane identity, row, cursor and unchanged composer; never erase a draft.
      const cleanup = async () => {
        const cleanupCtx = { ...ctx, signal: new AbortController().signal };
        const current = await safeProbe(cleanupCtx, false, true);
        if (!sameComposer(current)) return;
        if (current.pane!.kind === 'tmux') {
          await run('tmux', tmuxArgv(current.pane!, ['send-keys', '-t', current.pane!.paneId,
            '-N', String(line.length), 'BSpace']), ctx.env, cleanupCtx.signal);
        } else {
          await sendWezterm(current.pane!, '\x7f'.repeat(line.length), false, run, ctx.env, cleanupCtx.signal);
        }
      };
      try {
        await (deps.delay ?? (signal => delay(500, undefined, { signal })))(ctx.signal);
      } catch (error) {
        try { await cleanup(); } finally { await failAttempt(ctx.files.dir, nonce, ctx.now + 500); }
        throw error;
      }
      const final = await safeProbe({ ...ctx, now: ctx.now + 500 }, false);
      const current = await readActivity(ctx.files);
      if (!sameComposer(final) || current.updatedAt !== activity.updatedAt || ctx.signal.aborted) {
        try { await cleanup(); } finally { await failAttempt(ctx.files.dir, nonce, ctx.now + 500); }
        return;
      }
      await send(final.pane!, line, true, run, ctx.env, ctx.signal);
    },
  };
}

/** An armed live Stop watcher owns rung 2; this driver delegates and never types. */
export function createClaudeWatcherDriver(read: ProcessReader = readProcess): WakeDriver {
  return {
    id: 'watcher', rung: 2, optIn: false, minIdleMs: 0, deadlineMs: 30_000, verification: 'none',
    async available(ctx) {
      const lease = await readJson<{ state?: string; pid?: number }>(path.join(ctx.files.dir, 'watcher.json'));
      return lease?.state === 'armed' && Number.isSafeInteger(lease.pid) && lease.pid! > 0 && !!await read(lease.pid!);
    },
    wake() { /* The already-running hook watcher performs the wake. */ },
  };
}

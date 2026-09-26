import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type InternalCommand, type InternalCommandIo, type InternalRuntime, isInternalChannelArgument,
} from '@khala/contracts/internal/command';
import { INTERNAL_WEB_BUNDLE_DIRECTORY } from '@khala/contracts/internal/descriptor';
import { PLAINTEXT_DELETION_NOTICE, deleteConfirmation, deleteInternalChannel } from '../lifecycle/delete';
import { exportInternalChannel } from '../lifecycle/export';
import { type OpenBootstrapInput, type OpenOutcome, openBootstrap } from '../launcher/browser-handoff';
import { WebBundleError, webBundleManifest } from '../launcher/bundle';
import { type LaunchRequest, launchInternal } from '../launcher/launcher';
import { DEFAULT_START_PORT } from '../server/server';

// Application-owned entry for `khala internal`. The agent CLI loads this module
// only for that command, so no other command pays for the store, the server or
// node:sqlite. It is bundled separately as `khala-internal.js`.

export type InternalRuntimeOptions = Readonly<{
  /** Built internal web bundle; defaults to `internal-web/` beside this module. */
  bundleDirectory?: string;
  startPort?: number;
  openBrowser?: (input: Pick<OpenBootstrapInput, 'bootstrapUrl' | 'credential' | 'handoffParent'> & Readonly<{
    env: InternalCommandIo['env'];
  }>) => Promise<OpenOutcome>;
}>;

type Failure = Readonly<{ ok: false; error: string; channelId?: string; resumeCommand?: string }>;

/** `$XDG_STATE_HOME/khala/internal`, falling back to `~/.local/state`. */
export function internalRoot(env: InternalCommandIo['env']): string | null {
  // An empty XDG variable means unset.
  const state = env.XDG_STATE_HOME || (env.HOME ? path.join(env.HOME, '.local/state') : undefined);
  if (!state || !path.isAbsolute(state)) return null;
  return path.resolve(state, 'khala', 'internal');
}

function defaultBundleDirectory(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), INTERNAL_WEB_BUNDLE_DIRECTORY);
}

/** The runtime is a separate bundle, so the command is checked again here. */
function validCommand(command: unknown): command is InternalCommand {
  if (typeof command !== 'object' || command === null) return false;
  const value = command as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(',');
  switch (value.kind) {
    case 'create': return keys === 'kind';
    case 'resume': return keys === 'channelId,kind' && isInternalChannelArgument(value.channelId);
    case 'export':
      return keys === 'channelId,format,kind,output,replace' && isInternalChannelArgument(value.channelId)
        && (value.format === 'markdown' || value.format === 'jsonl') && typeof value.output === 'string'
        && value.output.length > 0 && !value.output.includes('\0') && typeof value.replace === 'boolean';
    case 'delete': return keys === 'channelId,confirmed,kind' && isInternalChannelArgument(value.channelId) && typeof value.confirmed === 'boolean';
    default: return false;
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}

export function createInternalRuntime(options: InternalRuntimeOptions = {}): InternalRuntime {
  const fail = async (io: InternalCommandIo, value: Failure): Promise<number> => {
    await io.stderr.write(`${JSON.stringify(value)}\n`);
    return 3;
  };

  async function launch(request: LaunchRequest, root: string, io: InternalCommandIo): Promise<number> {
    let assets;
    try {
      assets = webBundleManifest(options.bundleDirectory ?? defaultBundleDirectory());
    } catch (error) {
      if (error instanceof WebBundleError) return fail(io, { ok: false, error: 'web_bundle_unavailable' });
      throw error;
    }
    const open = options.openBrowser ?? ((input: Parameters<NonNullable<InternalRuntimeOptions['openBrowser']>>[0]) => openBootstrap(input));
    const outcome = await launchInternal({
      root,
      request,
      assets,
      startPort: options.startPort ?? DEFAULT_START_PORT,
      openBrowser: input => open({ ...input, env: io.env }),
    });
    if (outcome.kind === 'failed') {
      return fail(io, {
        ok: false, error: outcome.code,
        ...(outcome.channelId === undefined ? {} : { channelId: outcome.channelId, resumeCommand: outcome.resumeCommand! }),
      });
    }
    const { report } = outcome;
    try {
      await io.stdout.write(`${JSON.stringify({ ok: true, kind: 'running', ...report })}\n`);
      await io.stderr.write([
        `Khala internal channel ${report.channelId} is running at ${report.origin}${report.portFallback ? ' (requested port was busy)' : ''}.`,
        `Open this URL in your browser: ${report.url}`,
        `Resume later with: ${report.resumeCommand}`,
        'Press Ctrl+C to stop the local server. Agent sessions you started are not affected.',
        '',
      ].join('\n'));
      // Only after the URL is out: automatic opening can add to it, never delay it.
      if (await outcome.openBrowser()) await io.stderr.write('Opened your browser to sign in.\n');
      await waitForAbort(io.signal);
    } finally {
      await outcome.shutdown();
    }
    return 0;
  }

  return {
    async runInternalCommand(command, io) {
      if (!validCommand(command)) return fail(io, { ok: false, error: 'invalid_arguments' });
      const root = internalRoot(io.env);
      if (root === null) return fail(io, { ok: false, error: 'unsafe_path' });
      switch (command.kind) {
        case 'create':
        case 'resume': {
          try {
            fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
          } catch {
            return fail(io, { ok: false, error: 'io_failed' });
          }
          return launch(command.kind === 'create' ? { kind: 'create' } : { kind: 'resume', channelId: command.channelId }, root, io);
        }
        case 'export': {
          const result = exportInternalChannel({
            root,
            channelId: command.channelId,
            format: command.format,
            destination: path.resolve(io.cwd, command.output),
            overwrite: command.replace ? 'replace' : 'refuse',
          });
          if (result.kind === 'failed') return fail(io, { ok: false, error: result.code, channelId: command.channelId });
          await io.stdout.write(`${JSON.stringify({
            ok: true, kind: 'exported', channelId: command.channelId, format: result.format, destination: result.destination, bytes: result.bytes,
          })}\n`);
          return 0;
        }
        case 'delete': {
          const result = deleteInternalChannel({
            root,
            channelId: command.channelId,
            confirmation: command.confirmed ? deleteConfirmation(command.channelId) : null,
          });
          if (result.kind === 'failed') return fail(io, { ok: false, error: result.code, channelId: command.channelId });
          if (result.kind === 'confirmation_required') {
            await io.stderr.write(`${JSON.stringify({ ok: false, error: 'confirmation_required', channelId: command.channelId, notice: PLAINTEXT_DELETION_NOTICE })}\n`);
            return 3;
          }
          await io.stdout.write(`${JSON.stringify({ ok: result.kind === 'deleted', ...result })}\n`);
          return result.kind === 'deleted' ? 0 : 3;
        }
      }
    },
  };
}

export const { runInternalCommand } = createInternalRuntime();

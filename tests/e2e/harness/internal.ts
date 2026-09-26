// Internal-mode composition for acceptance entries. Everything here drives the
// real `khala` CLI entry: `khala internal` starts the real launcher, loopback
// server and SQLite store, and agent commands run through `--internal-descriptor`.
// The only substitutes are the fixture web bundle and a browser opener that
// never opens a browser. Nothing here starts, wraps or signals an agent CLI.

import childProcess from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createInternalRuntime } from '../../../apps/internal/src/composition/internal-cli';
import { runCli } from '../../../packages/agent-cli/src/cli/app';
import { openInbox } from '../../../packages/agent-cli/src/cli/inbox';
import { MAX_SEND_BYTES } from '../../../packages/agent-cli/src/cli/send';
import { createInternalClient } from '../../../packages/agent-cli/src/composition/internal';
import { createInternalDelivery } from '../../../packages/agent-cli/src/composition/internal-delivery';

const FIXTURE_BUNDLE = fileURLToPath(new URL('../../../apps/internal/src/launcher/fixtures/internal-web', import.meta.url));

export type KhalaResult = Readonly<{ code: number; stdout: string; stderr: string }>;

export type KhalaProfile = Readonly<{
  /** `XDG_STATE_HOME` for `khala internal` commands. */
  stateHome: string;
  /** Private Khala state (inbox, pull cursors) of the process running the command. */
  stateDirectory: string;
  /** The launcher's start port; the real launcher falls back visibly when it is taken. */
  port: number;
}>;

export type KhalaInvocation = Readonly<{
  result: Promise<KhalaResult>;
  /** Everything written to stdout so far. */
  stdout(): string;
  stderr(): string;
}>;

/** One `khala` CLI process: the production command table with test streams. */
export function khala(profile: KhalaProfile, argv: readonly string[], options: Readonly<{
  stdin?: string;
  signal?: AbortSignal;
}> = {}): KhalaInvocation {
  const stdin = new PassThrough();
  stdin.end(options.stdin ?? '');
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const text = { out: '', err: '' };
  stdout.on('data', chunk => { text.out += String(chunk); });
  stderr.on('data', chunk => { text.err += String(chunk); });
  const result = runCli(argv, {
    client: null as never,
    // No listening-mode application is composed for internal mode, exactly as in `main.ts`.
    listeningMode: null,
    inbox: (bindingId, generation) => openInbox({
      stateDirectory: profile.stateDirectory, bindingId, generation, maxPayloadBytes: MAX_SEND_BYTES, maxSelectionEvents: 32,
    }),
    stdin, stdout, stderr,
    ...(options.signal ? { signal: options.signal } : {}),
    internal: async () => createInternalRuntime({
      bundleDirectory: FIXTURE_BUNDLE,
      startPort: profile.port,
      openBrowser: async () => ({ opened: false, reason: 'acceptance runs never open a browser' }),
    }),
    env: { XDG_STATE_HOME: profile.stateHome },
    cwd: profile.stateHome,
    internalClient: async descriptorPath => createInternalClient({ descriptorPath }),
    internalDelivery: async descriptorPath => createInternalDelivery({ descriptorPath, stateDirectory: profile.stateDirectory }),
  }).then(code => ({ code, stdout: text.out, stderr: text.err }));
  return { result, stdout: () => text.out, stderr: () => text.err };
}

/** Runs one short `khala` command to completion. */
export function khalaOnce(profile: KhalaProfile, argv: readonly string[], stdin?: string): Promise<KhalaResult> {
  return khala(profile, argv, stdin === undefined ? {} : { stdin }).result;
}

export type LaunchReport = Readonly<{
  channelId: string;
  resumeCommand: string;
  descriptorPath: string;
  origin: string;
  port: number;
  url: string;
}>;

export type RunningLauncher = Readonly<{
  report: LaunchReport;
  /** Closes the launcher the way Ctrl+C does and resolves its exit code. */
  close(): Promise<number>;
}>;

const REPORT_TIMEOUT_MS = 20_000;

/** `khala internal` (create) or `khala internal --resume <channel-id>`, running until closed. */
export async function startLauncher(profile: KhalaProfile, resume?: string): Promise<RunningLauncher> {
  const abort = new AbortController();
  const run = khala(profile, resume === undefined ? ['internal'] : ['internal', '--resume', resume], { signal: abort.signal });
  let settled: KhalaResult | null = null;
  void run.result.then(result => { settled = result; });
  const deadline = Date.now() + REPORT_TIMEOUT_MS;
  while (!run.stdout().includes('\n')) {
    if (settled !== null) throw new Error(`launcher exited ${(settled as KhalaResult).code}: ${(settled as KhalaResult).stderr}`);
    if (Date.now() > deadline) throw new Error('launcher did not report');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const report = JSON.parse(run.stdout().split('\n')[0]!) as LaunchReport & { ok: boolean; kind: string };
  if (!report.ok || report.kind !== 'running') throw new Error('launcher did not start');
  let closing: Promise<number> | null = null;
  return {
    report,
    close() {
      closing ??= (abort.abort(), run.result.then(result => result.code));
      return closing;
    },
  };
}

/** A loopback port that was free a moment ago, so a resume can ask for the same origin. */
export async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as net.AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export type Reply = Readonly<{ status: number; text: string; json: unknown }>;

export type HumanSession = Readonly<{
  origin: string;
  channelId: string;
  call(pathname: string, init?: Readonly<{ method?: string; body?: unknown }>): Promise<Reply>;
}>;

async function reply(response: Response): Promise<Reply> {
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, text, json };
}

/** Redeems the printed bootstrap URL exactly as the browser bootstrap script does. */
export async function humanSession(report: LaunchReport): Promise<HumanSession> {
  const { origin } = report;
  const fragment = new URLSearchParams(new URL(report.url).hash.slice(1));
  const response = await fetch(`${origin}/__khala/session`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ credential: fragment.get('credential'), channelId: fragment.get('channel') }),
  });
  if (response.status !== 200) throw new Error(`bootstrap exchange failed: ${response.status}`);
  const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
  const { requestSecret } = await response.json() as { requestSecret: string };
  return {
    origin,
    channelId: report.channelId,
    async call(pathname, init = {}) {
      return reply(await fetch(`${origin}${pathname}`, {
        method: init.method ?? 'GET',
        headers: {
          cookie, origin, 'x-khala-request-secret': requestSecret,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }));
    },
  };
}

/** Whether anything answers on the origin; a closed launcher refuses the connection. */
export async function reachable(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Process audit: Khala must never start a process on the agent's behalf.

const SPAWNING = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;

export type ProcessAudit = Readonly<{
  /** Every process start requested while the audit was installed, outside `allow`. */
  started(): readonly string[];
  /** Starts a process that the test, not Khala, owns. */
  allow<T>(start: () => T): T;
  uninstall(): void;
}>;

/**
 * Records every `node:child_process` start in this worker. Named ESM imports see
 * the wrapper because builtin exports are re-synced after the patch.
 */
export function installProcessAudit(): ProcessAudit {
  const target = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originals = new Map(SPAWNING.map(name => [name, target[name]!]));
  const started: string[] = [];
  let allowed = 0;
  for (const name of SPAWNING) {
    const original = originals.get(name)!;
    target[name] = function audited(this: unknown, ...args: unknown[]) {
      if (allowed === 0) started.push(`${name}:${path.basename(String(args[0]))}`);
      return original.apply(this, args);
    };
  }
  syncBuiltinESMExports();
  return {
    started: () => [...started],
    allow(start) {
      allowed += 1;
      try { return start(); } finally { allowed -= 1; }
    },
    uninstall() {
      for (const [name, original] of originals) target[name] = original;
      syncBuiltinESMExports();
    },
  };
}

/** Whether a process exists; signal 0 checks without delivering anything. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Creates a private (0700) directory, as Khala requires for its state roots. */
export function privateDirectory(...segments: string[]): string {
  const directory = path.join(...segments);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

// Drivers for the internal-channel browser acceptance. Everything runs through
// the real `khala` CLI entry (`runCli`) over the application's own `khala internal`
// runtime, exactly as a user's terminal would: the launcher is `khala internal`
// and `khala internal --resume <id>`, and each agent is an externally started CLI
// session that only ever runs `khala internal discovery`, `join`, `send` and
// `read`. Khala launches no agent here; the test process plays each agent's CLI.

import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { runCli } from '../../../../../packages/agent-cli/src/cli/app';
import { ChannelCreateService } from '../../../../../packages/agent-cli/src/cli/channels/create/service';
import { openInbox } from '../../../../../packages/agent-cli/src/cli/inbox';
import { createUnavailableClient } from '../../../../../packages/agent-cli/src/composition/unavailable';
import { createInternalClient } from '../../../../../packages/agent-cli/src/composition/internal';
import { createInternalDelivery } from '../../../../../packages/agent-cli/src/composition/internal-delivery';
import { createInternalRuntime } from '../../../../internal/src/composition/internal-cli';

export type CliRun = Readonly<{ code: number; out: string; err: string }>;

type CliOptions = Readonly<{
  /** `XDG_STATE_HOME` of the terminal the command runs in. */
  stateHome: string;
  bundleDirectory: string;
  stdin?: string;
  signal?: AbortSignal;
  /** Called with each stdout chunk as it is written. */
  onStdout?: (text: string) => void;
}>;

/** One `khala …` invocation in a terminal whose state lives under `stateHome`. */
export async function khala(argv: readonly string[], options: CliOptions): Promise<CliRun> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks = { out: '', err: '' };
  stdout.on('data', chunk => {
    chunks.out += String(chunk);
    options.onStdout?.(chunks.out);
  });
  stderr.on('data', chunk => { chunks.err += String(chunk); });
  const stdin = new PassThrough();
  stdin.end(options.stdin ?? '');
  const inboxState = path.join(options.stateHome, 'agent-inbox');
  const code = await runCli(argv, {
    client: createUnavailableClient(),
    listeningMode: null,
    inbox: (bindingId, generation) => openInbox({
      stateDirectory: inboxState, bindingId, generation, maxPayloadBytes: 64 * 1024, maxSelectionEvents: 32,
    }),
    stdin, stdout, stderr,
    ...(options.signal ? { signal: options.signal } : {}),
    env: { XDG_STATE_HOME: options.stateHome },
    cwd: options.stateHome,
    // The browser is opened by the test itself; the runtime only prints the manual URL.
    internal: async () => createInternalRuntime({
      bundleDirectory: options.bundleDirectory,
      startPort: 0,
      openBrowser: async () => ({ opened: false, reason: 'test' }),
    }),
    internalClient: async descriptorPath => createInternalClient({ descriptorPath }),
    internalDelivery: async descriptorPath => createInternalDelivery({ descriptorPath, stateDirectory: inboxState }),
  });
  return { code, ...chunks };
}

/** `$XDG_STATE_HOME/khala/internal`, as `khala internal` resolves it. */
export function internalRootOf(stateHome: string): string {
  return path.join(stateHome, 'khala', 'internal');
}

export type LauncherReport = Readonly<{ channelId: string; origin: string; url: string; resumeCommand: string }>;

export type RunningLauncher = Readonly<{
  report: LauncherReport;
  /** The operator's Ctrl+C: resolves with the launcher's exit status once it has shut down. */
  close(): Promise<CliRun>;
}>;

/** Runs `khala internal` (or `khala internal --resume <id>`) until the returned launcher is closed. */
export async function startLauncher(
  args: readonly string[], options: Omit<CliOptions, 'signal' | 'onStdout' | 'stdin'>,
): Promise<RunningLauncher> {
  const abort = new AbortController();
  let reported: (report: LauncherReport) => void = () => {};
  const running = new Promise<LauncherReport>(resolve => { reported = resolve; });
  const exited = khala(['internal', ...args], {
    ...options,
    signal: abort.signal,
    onStdout(text) {
      const line = text.split('\n').find(each => each.includes('"kind":"running"'));
      if (line) reported(JSON.parse(line) as LauncherReport);
    },
  });
  const report = await Promise.race([
    running,
    exited.then(result => { throw new Error(`khala internal exited early: ${JSON.stringify(result)}`); }),
  ]);
  let closing: Promise<CliRun> | null = null;
  return {
    report,
    close() {
      abort.abort();
      closing ??= exited;
      return closing;
    },
  };
}

/**
 * An agent CLI session the user started on its own. It gets only what a user's
 * agent would: the launcher's published transport descriptor (`active.json`),
 * copied into its own private state root so its granted binding never overwrites
 * another agent's.
 */
export class AgentSession {
  private constructor(
    readonly name: string,
    readonly stateHome: string,
    readonly bundleDirectory: string,
    readonly discoveryDescriptor: string,
  ) {}

  static async start(input: Readonly<{
    name: string; harness: string; sessionId: string; launcherStateHome: string; stateHome: string; bundleDirectory: string;
  }>): Promise<AgentSession> {
    const root = internalRootOf(input.stateHome);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(internalRootOf(input.launcherStateHome), 'active.json'), path.join(root, 'active.json'));
    fs.chmodSync(path.join(root, 'active.json'), 0o600);
    const issued = await khala(
      ['internal', 'discovery', '--harness', input.harness, '--session', input.sessionId, '--label', input.name],
      { stateHome: input.stateHome, bundleDirectory: input.bundleDirectory },
    );
    if (issued.code !== 0) throw new Error(`khala internal discovery failed: ${issued.err}`);
    const { descriptorPath } = JSON.parse(issued.out) as { descriptorPath: string };
    return new AgentSession(input.name, input.stateHome, input.bundleDirectory, descriptorPath);
  }

  /** The agent's `active.json`: its granted binding once the owner approved and it joined. */
  get activePath(): string {
    return path.join(internalRootOf(this.stateHome), 'active.json');
  }

  granted(): Readonly<{ channelId: string; origin: string; bindingId: string; bindingCapability: string }> {
    return JSON.parse(fs.readFileSync(this.activePath, 'utf8'));
  }

  private run(argv: readonly string[], stdin?: string): Promise<CliRun> {
    return khala(argv, { stateHome: this.stateHome, bundleDirectory: this.bundleDirectory, ...(stdin === undefined ? {} : { stdin }) });
  }

  /** `khala join <channel-url>`: asks for access, then finishes activation once approved. */
  async join(channelUrl: string): Promise<string> {
    const result = await this.run(['--internal-descriptor', this.discoveryDescriptor, 'join', channelUrl]);
    return result.code === 0 || result.code === 3 ? (JSON.parse(result.out) as { outcome: string }).outcome : `error:${result.err.trim()}`;
  }

  /** The channel-creation service behind `khala channels create` and its MCP tool, on this session's discovery descriptor. */
  channelCreate(): ChannelCreateService {
    return new ChannelCreateService(createInternalClient({ descriptorPath: this.discoveryDescriptor }));
  }

  send(body: string): Promise<CliRun> {
    return this.run(['--internal-descriptor', this.activePath, 'send'], body);
  }

  read(ack?: string): Promise<CliRun> {
    return this.run(['--internal-descriptor', this.activePath, 'read', ...(ack === undefined ? [] : ['--ack', ack])]);
  }

  /** Reads everything waiting, acknowledges it, and returns the message bodies in order. */
  async readAll(): Promise<string[]> {
    const first = await this.read();
    if (first.code !== 0) throw new Error(`${this.name}: khala read failed: ${first.err}`);
    if (first.out.trim() === JSON.stringify({ ok: true, kind: 'empty' })) return [];
    const token = /batchToken: (\S+)/.exec(first.out)?.[1];
    if (!token) throw new Error(`${this.name}: no batch token in ${first.out}`);
    const acked = await this.read(token);
    if (acked.code !== 0) throw new Error(`${this.name}: khala read --ack failed: ${acked.err}`);
    // Each release's canonical JSON is `[domain, releaseId, bindingId, generation, policy, items]`,
    // and each item ends with the message body.
    const releases = [...first.out.matchAll(/^canonicalReleaseJson:\n(.+)$/gm)].map(match => JSON.parse(match[1]!) as unknown[]);
    return releases.flatMap(release => (release[5] as unknown[][]).map(item => item.at(-1) as string));
  }
}

// A fake, externally started agent CLI session. The test starts a real sentinel
// process that stands in for the user's own Claude or Codex CLI, before Khala is
// asked for anything; Khala never learns its PID and must never signal it. The
// native harness boundary is the only fake: where a real CLI would call
// `khala` from a hook, skill or MCP entry, this driver runs the production
// `khala` command table. It never deduplicates what it is given, so a duplicate
// delivery surfaces here instead of being masked by the host.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  LocalHarnessCapabilities, LocalHarnessObservation,
} from '../../../packages/agent-cli/src/composition/internal-listening-mode';
import { type KhalaProfile, type KhalaResult, type ProcessAudit, khalaOnce, privateDirectory } from '../harness/internal';

/** Catchable signals the sentinel records; SIGKILL/SIGSTOP are caught by the liveness check. */
const RECORDED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2', 'SIGPIPE', 'SIGALRM'];
const SENTINEL = `
const fs = require('node:fs');
const file = process.argv[1];
for (const signal of ${JSON.stringify(RECORDED_SIGNALS)}) process.on(signal, () => fs.appendFileSync(file, signal + '\\n'));
setInterval(() => {}, 1000);
`;

export type DeliveredEvent = Readonly<{
  releaseId: string;
  eventId: string;
  authorParticipantId: string;
  body: string;
}>;

export type ReadView =
  | Readonly<{ kind: 'empty' }>
  | Readonly<{ kind: 'batch'; token: string; events: readonly DeliveredEvent[] }>
  | Readonly<{ kind: 'refused'; code: number; error: string }>;

export type SendView =
  | Readonly<{ kind: 'accepted'; eventId: string; clientTxnId: string }>
  | Readonly<{ kind: 'refused'; code: number; output: string }>;

export type ExternalCli = Readonly<{
  name: string;
  harness: 'codex' | 'claude';
  sessionId: string;
  /** PID of the user-started CLI stand-in; recorded before any Khala operation. */
  pid: number;
  /** Signals the CLI stand-in received; Khala must never send any. */
  signalsReceived(): readonly string[];
  /** Runs `khala internal discovery` for this session against the launcher's state root. */
  discover(launcher: KhalaProfile): Promise<void>;
  /**
   * Follows the resumed launcher's port. The session's `grant.json` still names the previous
   * launch's grant, which ended with it; the next `join` reseeds it from the new `active.json`.
   */
  relaunched(launcher: KhalaProfile): void;
  /** `khala join <channel-url>`: files an access request, or finishes an approved one. */
  join(channelUrl: string): Promise<string>;
  status(): Promise<Readonly<{ connected: boolean; binding: Readonly<{ bindingId: string; generation: number }> | null }>>;
  /** A deliberate `khala send`; the only way this session ever writes to the channel. */
  send(body: string): Promise<SendView>;
  /** `khala read`, acknowledging `ack` first when given. */
  read(ack?: string): Promise<ReadView>;
  /** `khala mode <args>` for this session's own binding, under the CLI's released `claim`; the parsed output. */
  mode(args: readonly string[], claim?: LocalHarnessCapabilities): Promise<Record<string, unknown>>;
  /**
   * The CLI's native hook fires the installed `khala codex-hook`, with no descriptor option, with `input` on stdin. `claim` is the
   * released capability claim of this CLI's installed version and hook trust.
   */
  codexHook(input: unknown, claim?: LocalHarnessCapabilities, observation?: LocalHarnessObservation): Promise<KhalaResult>;
  /**
   * The model ends its turn with prose and calls no Khala tool. A correct
   * integration posts nothing: replies are deliberate sends only.
   */
  endTurnWithProse(prose: string): Promise<void>;
  /** Every release this session was shown, with how often; never deduplicated. */
  deliveries(): ReadonlyMap<string, number>;
  /** Granted descriptor this session's `khala` calls use. */
  descriptorPath(): string;
  /** The user closes their CLI at the end of the run. */
  close(): Promise<void>;
}>;

type Options = Readonly<{
  name: string;
  harness: 'codex' | 'claude';
  sessionId: string;
  /** Scenario owner whose evidence this session records. */
  ownerId: string;
  /** Private state directory of the owner this session belongs to. */
  stateDirectory: string;
  audit: ProcessAudit;
  /** Records fake-contract evidence for the owner; identifiers only. */
  record(kind: string, subject: Readonly<{ ownerId: string; operationId: string }>): void;
}>;

export function parseBatch(text: string): ReadView {
  const lines = text.split('\n');
  const token = lines.find(line => line.startsWith('batchToken: '))?.slice('batchToken: '.length);
  if (!lines[0]?.startsWith('<khala-channel-batch-v1>') || token === undefined) throw new Error('unexpected read output');
  const events: DeliveredEvent[] = [];
  lines.forEach((line, index) => {
    if (line !== 'canonicalReleaseJson:') return;
    // [encoding, releaseId, bindingId, generation, policyVersion, [[room, event, author, device, digest, body]]]
    const [, releaseId, , , , rows] = JSON.parse(lines[index + 1]!) as [string, string, string, number, number, string[][]];
    for (const [, eventId, authorParticipantId, , , body] of rows) {
      events.push({ releaseId, eventId: eventId!, authorParticipantId: authorParticipantId!, body: body! });
    }
  });
  return { kind: 'batch', token, events };
}

export function createExternalCli(options: Options): ExternalCli {
  const signalFile = path.join(options.stateDirectory, `${options.name}.signals`);
  fs.writeFileSync(signalFile, '');
  // The user starts their CLI; the test owns this process, Khala never sees it.
  const child: ChildProcess = options.audit.allow(() =>
    spawn(process.execPath, ['-e', SENTINEL, signalFile], { stdio: 'ignore', detached: false }));
  if (child.pid === undefined) throw new Error('CLI stand-in did not start');
  const pid = child.pid;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));

  // Both sessions share the launcher's Khala root, as two CLIs of one OS user do. Each
  // joins with its own discovery descriptor and then uses its own granted descriptor
  // beside it (#391); only the CLI's local inbox state is kept per session.
  const khalaState = privateDirectory(options.stateDirectory, 'khala');
  let discoveryPath: string | null = null;
  let grantPath: string | null = null;
  let launcherPort = 0;
  const profile = (): KhalaProfile => ({ stateHome: options.stateDirectory, stateDirectory: khalaState, port: launcherPort });
  const delivered = new Map<string, number>();
  const record = (kind: string, operationId: string) => options.record(kind, { ownerId: options.ownerId, operationId });

  const cli = async (argv: readonly string[], stdin?: string, claim?: LocalHarnessCapabilities) =>
    khalaOnce(profile(), ['--internal-descriptor', argv[0] === 'join' ? discoveryPath! : grantPath!, ...argv], stdin,
      claim ? { capabilities: claim } : {});

  return {
    name: options.name,
    async close() {
      // The user closes their own CLI at the end of the run.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    },
    harness: options.harness,
    sessionId: options.sessionId,
    pid,
    signalsReceived: () => fs.readFileSync(signalFile, 'utf8').split('\n').filter(Boolean),

    async discover(launcher) {
      launcherPort = launcher.port;
      const issued = await khalaOnce(launcher, ['internal', 'discovery', '--harness', options.harness, '--session', options.sessionId]);
      if (issued.code !== 0) throw new Error(`discovery failed: ${issued.stderr}`);
      const { descriptorPath } = JSON.parse(issued.stdout) as { descriptorPath: string };
      discoveryPath = descriptorPath;
      grantPath = path.join(path.dirname(descriptorPath), 'grant.json');
    },

    relaunched(launcher) {
      launcherPort = launcher.port;
    },

    async join(channelUrl) {
      const result = await cli(['join', channelUrl]);
      const outcome = (JSON.parse(result.stdout || result.stderr) as { outcome?: string; error?: string });
      return outcome.outcome ?? `error:${outcome.error}`;
    },

    async status() {
      const result = await cli(['status']);
      return JSON.parse(result.stdout) as Awaited<ReturnType<ExternalCli['status']>>;
    },

    async send(body) {
      const result = await cli(['send'], body);
      const output = JSON.parse(result.stdout || result.stderr) as { ok: boolean; eventId?: string; clientTxnId?: string };
      if (result.code !== 0 || !output.ok) return { kind: 'refused', code: result.code, output: result.stdout || result.stderr };
      record('channel.sent', `event-${output.eventId}`);
      return { kind: 'accepted', eventId: output.eventId!, clientTxnId: output.clientTxnId! };
    },

    async read(ack) {
      const result = await cli(ack === undefined ? ['read'] : ['read', '--ack', ack]);
      if (result.code !== 0) return { kind: 'refused', code: result.code, error: result.stderr.trim() };
      const trimmed = result.stdout.trim();
      if (trimmed.startsWith('{')) {
        const parsed = JSON.parse(trimmed) as { kind: string };
        if (parsed.kind !== 'empty') throw new Error(`unexpected read output ${parsed.kind}`);
        return { kind: 'empty' };
      }
      const view = parseBatch(trimmed);
      if (view.kind === 'batch') {
        for (const release of new Set(view.events.map(event => event.releaseId))) {
          delivered.set(release, (delivered.get(release) ?? 0) + 1);
          record('context.consumed', release.replace(/^rel_/, 'rel-'));
        }
      }
      return view;
    },

    async mode(args, claim) {
      const result = await cli(['mode', ...args], undefined, claim);
      return JSON.parse(result.stdout || result.stderr) as Record<string, unknown>;
    },

    // The exact installed command: `khala codex-hook`, with no descriptor option.
    // It reads the launcher's `active.json`, which the first grant mirrors into (#401; per-session hook identity is #407).
    codexHook: (input, claim, observation) => khalaOnce(profile(), ['codex-hook'], JSON.stringify(input), {
      ...(claim ? { capabilities: claim } : {}), ...(observation ? { observation } : {}),
      defaultDescriptorPath: path.join(path.dirname(discoveryPath!), '..', '..', 'active.json'),
    }),

    async endTurnWithProse() {
      // The session calls no Khala tool, so nothing reaches the channel. A host
      // that posted this text on its own would be the defect under test.
    },

    deliveries: () => delivered,
    descriptorPath: () => grantPath!,
  };
}

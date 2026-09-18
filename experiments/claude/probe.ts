import { mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { collectInventory, sanitize, sha256, replayQueue, snapshotTranscript, transcriptEntriesFrom, type TranscriptEntry, type TranscriptSnapshot } from './evidence.ts';
import {
  PRIOR_MARKER, Pushable, Recorder, assistantText, busyPrompt, findProcesses as findLiveProcesses, releasedLine, seedPrompt, setupPrompt,
  toolResultFor, toolUses, writeFeedLine,
  type Mode, type Observation, type OpenSession, type PermissionDecision, type SetupAction, type StreamMessage,
} from './scenario.ts';

export type ProbeInput = { sessionId: string; expectedWorkdir: string; nonce: string; mode: Mode; deadlineMs: number };

export type ProbeReport = {
  harness: 'claude';
  version: string;
  mode: Mode;
  originalSessionId: string;
  observedSessionId: string | null;
  setupActions: readonly SetupAction[];
  observations: readonly Observation[];
  identity: { before: TranscriptSnapshot | null; after: TranscriptSnapshot | null; init: Record<string, unknown> | null };
  outcome: 'supported' | 'unsupported' | 'inconclusive';
  limitations: readonly string[];
  rawLogSha256: string | null;
};

export type ProbeDeps = {
  openSession: OpenSession;
  snapshot: (workdir: string, sessionId: string) => Promise<TranscriptSnapshot>;
  entriesFrom: (workdir: string, sessionId: string, fromLine: number) => Promise<{ line: number; entry: TranscriptEntry }[]>;
  runDir: string;
  busySeconds?: number;
  settleMs?: number;
  allowedTargets?: readonly Target[];
  findProcesses?: (pattern: string) => Promise<number[]>;
};

export type Target = { sessionId: string; workdir: string };

// The only session the owner designated for this experiment on #12. Every other target is refused.
export const DESIGNATED_TARGETS: readonly Target[] = [
  { sessionId: '51b0420c-e090-4215-81f0-2d1f7073a07c', workdir: join(homedir(), '.cache', 'khala-disposable', 'claude-target') },
];

const DISCONNECT_WINDOW_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertDesignatedTarget(sessionId: string, workdir: string, allowed: readonly Target[] = DESIGNATED_TARGETS): void {
  if (!UUID.test(sessionId)) throw new Error('sessionId must be the designated session UUID');
  if (!isAbsolute(workdir)) throw new Error('expectedWorkdir must be absolute');
  if (!allowed.some(target => target.sessionId === sessionId && target.workdir === workdir)) {
    throw new Error('Refusing a session and workdir pair that is not a designated disposable target');
  }
}

export function validateInput(input: ProbeInput, allowed: readonly Target[] = DESIGNATED_TARGETS): void {
  assertDesignatedTarget(input.sessionId, input.expectedWorkdir, allowed);
  if (!/^[A-Za-z0-9-]{4,64}$/.test(input.nonce)) throw new Error('nonce must be 4-64 letters, digits or dashes');
  if (!['idle', 'busy', 'disconnect'].includes(input.mode)) throw new Error('mode must be idle, busy or disconnect');
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1000 || input.deadlineMs > 900_000) throw new Error('deadlineMs must be an integer between 1000 and 900000');
}

// Drives one case against the designated session: resume, agent-performed setup, the case, exit, identity checks.
export async function runAttachmentProbe(input: ProbeInput, deps: ProbeDeps): Promise<ProbeReport> {
  validateInput(input, deps.allowedTargets);
  const findProcesses = deps.findProcesses ?? findLiveProcesses;
  const started = performance.now();
  const wallAtStart = Date.now();
  const clock = () => performance.now() - started;
  const deadlineAt = started + input.deadlineMs;
  const remaining = () => Math.max(0, deadlineAt - performance.now());
  const settleMs = deps.settleMs ?? 3000;
  // The target runs in its own cwd, so a relative feed path would name a different, nonexistent file there.
  const runDir = resolve(deps.runDir);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const feedPath = join(runDir, 'released-feed.jsonl');
  await writeFile(feedPath, '', { mode: 0o600 });
  const recorder = new Recorder(clock, 'events.jsonl');
  const setupActions: SetupAction[] = [];
  const limitations: string[] = [];
  let phase: 'setup' | 'case' | 'closing' = 'setup';
  const busySeconds = Math.round(deps.busySeconds ?? 20);
  const busyTag = `busy-done-${input.nonce}`;
  const watchCommand = `tail -n 0 -F ${feedPath}`;
  const busyCommand = `sleep ${busySeconds} && echo ${busyTag}`;

  const before = await deps.snapshot(input.expectedWorkdir, input.sessionId).catch(() => null);
  if (!before) limitations.push('Designated transcript was unreadable before the run.');

  // Stand-in for the owner's permission dialog: it approves only the exact commands the prompts ask for,
  // each in its own phase, and records every approval as a human confirmation.
  const canUseTool = async (tool: string, toolInput: Record<string, unknown>): Promise<PermissionDecision> => {
    const command = typeof toolInput.command === 'string' ? toolInput.command : JSON.stringify(toolInput);
    recorder.observe('permission-request', null, `${tool}: ${command}`);
    const watchesFeed = tool === 'Monitor' && command.trim() === watchCommand && phase === 'setup';
    const isBusyCommand = tool === 'Bash' && command.trim() === busyCommand && phase === 'case';
    if (watchesFeed || isBusyCommand) {
      setupActions.push({ actor: 'human', action: sanitize(`approve ${tool} permission prompt: ${command}`) });
      return { behavior: 'allow' };
    }
    return { behavior: 'deny', message: 'Not approved during this experiment.' };
  };

  const session = deps.openSession({ sessionId: input.sessionId, workdir: input.expectedWorkdir, canUseTool });
  const pump = (async () => {
    try { for await (const message of session.messages) recorder.record(message); }
    catch (error) { limitations.push(sanitize(`Session stream ended with an error: ${(error as Error).message}`)); }
    finally { recorder.close(); }
  })();

  let init: Record<string, unknown> | null = null;
  let observedSessionId: string | null = null;
  let consumed = false;
  let markerRecalled = false;
  let replaced = false;
  const messageId = `m-${input.mode}`;
  try {
    session.send(setupPrompt(feedPath));
    const initIndex = await recorder.waitFor(message => message.type === 'system' && message.subtype === 'init', remaining());
    if (initIndex < 0) throw new Error('No init message before the deadline.');
    const initMessage = recorder.log[initIndex].message;
    init = {
      session_id: initMessage.session_id, cwd: sanitize(String(initMessage.cwd)), model: initMessage.model,
      permissionMode: initMessage.permissionMode, claude_code_version: initMessage.claude_code_version,
      hasMonitor: Array.isArray(initMessage.tools) && initMessage.tools.includes('Monitor'),
    };
    observedSessionId = String(initMessage.session_id);
    recorder.observe('session-init', initIndex, `session ${observedSessionId}`);
    if (observedSessionId !== input.sessionId || initMessage.cwd !== input.expectedWorkdir) {
      replaced = true;
      throw new Error('Resumed session identity or working directory differs from the designated target.');
    }

    const watchIndex = await recorder.waitFor(message => toolUses(message).some(use => use.name === 'Monitor'), remaining(), initIndex);
    if (watchIndex < 0) throw new Error('The agent did not call Monitor before the deadline.');
    setupActions.push({ actor: 'agent', action: 'start Monitor watch on the connector feed' });
    recorder.observe('agent-setup-tool-call', watchIndex, 'Monitor');
    // Resume replays a zero-turn result for the previous run, so only a result after the watch call ends setup.
    const setupDone = await recorder.waitFor(message => message.type === 'result', remaining(), watchIndex);
    const watchStarted = recorder.log.some((entry, index) => index > watchIndex && entry.message.type === 'system' && entry.message.subtype === 'task_started');
    if (setupDone < 0 || !watchStarted) throw new Error('The agent did not start a notification watch before the deadline.');
    recorder.observe('setup-complete', setupDone);
    phase = 'case';

    let busyToolId: string | null = null;
    if (input.mode === 'busy') {
      session.send(busyPrompt(busySeconds, busyTag));
      const busyIndex = await recorder.waitFor(message => toolUses(message).some(use => use.name === 'Bash'), remaining(), setupDone + 1);
      if (busyIndex < 0) throw new Error('The busy tool call never started.');
      busyToolId = toolUses(recorder.log[busyIndex].message).find(use => use.name === 'Bash')!.id;
      recorder.observe('busy-tool-start', busyIndex);
    }
    await sleep(Math.min(settleMs, remaining()));

    const writeFrom = recorder.log.length;
    await writeFeedLine(feedPath, releasedLine(messageId, input.nonce));
    recorder.observe('notification-write', null, messageId);
    if (input.mode === 'disconnect') {
      const pids = await findProcesses(feedPath);
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      recorder.observe('connector-disconnect', null, `killed ${pids.length} watch process(es) immediately after the write`);
      limitations.push('No replay was attempted: Monitor exposes no acknowledgement or dedup semantics, so a resend could double-deliver.');
    }

    if (busyToolId) {
      const toolEnd = await recorder.waitFor(message => toolResultFor(message, busyToolId!) !== null, remaining(), writeFrom);
      if (toolEnd >= 0) {
        const output = toolResultFor(recorder.log[toolEnd].message, busyToolId)!;
        recorder.observe('busy-tool-end', toolEnd, output.includes(busyTag) ? 'completed with expected output' : 'output missing: possibly interrupted');
      }
    }
    const consumption = await recorder.waitFor(message => assistantText(message).includes(input.nonce), remaining(), writeFrom);
    if (consumption >= 0) {
      consumed = true;
      recorder.observe('context-consumption', consumption);
      const markerIndex = await recorder.waitFor(message => assistantText(message).includes(PRIOR_MARKER), remaining(), consumption);
      markerRecalled = markerIndex >= 0;
      if (markerRecalled) recorder.observe('prior-marker-recalled', markerIndex);
      const complete = await recorder.waitFor(message => message.type === 'result', remaining(), consumption);
      if (complete >= 0) recorder.observe('task-complete', complete);
    } else {
      limitations.push(`No context consumption of the ${input.mode} message before the deadline.`);
    }
    if (input.mode === 'disconnect') {
      // A message released after the watch died shows whether anything reconnects on the session's behalf.
      const lateFrom = recorder.log.length;
      await writeFeedLine(feedPath, releasedLine('m-after-disconnect', `${input.nonce}-late`));
      recorder.observe('notification-write', null, 'm-after-disconnect');
      const late = await recorder.waitFor(message => assistantText(message).includes(`${input.nonce}-late`), Math.min(DISCONNECT_WINDOW_MS, remaining()), lateFrom);
      if (late >= 0) recorder.observe('post-disconnect-consumption', late);
      else limitations.push(`A message released after the watch died was not delivered within ${DISCONNECT_WINDOW_MS / 1000}s: nothing reconnects the watch without the agent re-arming it.`);
    }
  } catch (error) {
    limitations.push(sanitize((error as Error).message));
  }

  // Exit: close the input stream, then prove nothing replaced the session after it ended.
  phase = 'closing';
  session.end();
  const exited = await Promise.race([pump.then(() => true), sleep(Math.max(5000, Math.min(30_000, remaining()))).then(() => false)]);
  if (!exited) { session.abort(); await pump; limitations.push('Closing the input did not end the session while its Monitor watch was live; the probe aborted it.'); }
  recorder.observe('session-exit', null, exited ? 'input closed, process exited' : 'aborted');
  await writeFeedLine(feedPath, releasedLine('m-after-exit', `${input.nonce}-after-exit`));
  const exitCheckStart = await deps.snapshot(input.expectedWorkdir, input.sessionId).catch(() => null);
  await sleep(settleMs);
  const after = await deps.snapshot(input.expectedWorkdir, input.sessionId).catch(() => null);
  const runEntries = before ? await deps.entriesFrom(input.expectedWorkdir, input.sessionId, before.lines + 1).catch(() => []) : [];

  // The native queue is only visible in the transcript; same-host wall clock maps its timestamps onto this run's clock.
  const onClock = (timestamp: string | undefined) => Math.round(Date.parse(timestamp ?? '') - wallAtStart);
  const queue = replayQueue(runEntries);
  const enqueue = queue.find(item => item.content.includes(input.nonce) && item.content.includes(`"id":"${messageId}"`));
  if (enqueue) {
    recorder.observations.push({ kind: 'native-queue-accepted', monotonicMs: onClock(enqueue.timestamp), evidencePath: `transcript#L${enqueue.line}`, detail: 'queue-operation enqueue; same-host wall clock' });
    const { cleared } = enqueue;
    if (cleared) {
      const how = cleared.operation === 'dequeue' ? 'dequeued into a new turn' : 'injected into the running turn, then removed from the queue';
      recorder.observations.push({ kind: 'native-queue-delivered', monotonicMs: onClock(cleared.timestamp), evidencePath: `transcript#L${cleared.line}`, detail: `${how}; same-host wall clock` });
    } else {
      limitations.push('The released message was enqueued but never left the native queue during the run.');
    }
  } else if (consumed) {
    limitations.push('Consumption was observed but no matching native queue entry was found in the transcript.');
  }

  // The SDK launches the CLI with `--resume=<id>`; the probe's own npm/shell argv carries `--session-id` instead.
  const lingering = [...await findProcesses(feedPath), ...await findProcesses(`--resume=${input.sessionId}`)];
  const postExit = exitCheckStart ? runEntries.filter(({ line }) => line > exitCheckStart.lines) : [];
  const conversational = postExit.filter(({ entry }) => entry.type === 'user' || entry.type === 'assistant');
  if (lingering.length > 0) limitations.push(`${lingering.length} process(es) referencing the session or feed outlived the session.`);
  if (conversational.length > 0) limitations.push('The transcript gained conversation turns after the session exited.');
  if (lingering.length === 0 && conversational.length === 0) recorder.observe('no-replacement-after-exit', null, 'no process referencing the session or feed; no conversation turn after a post-exit write');
  // Shutdown can leave the stopped watch's own notification enqueued; the CLI delivers it first on the next resume.
  for (const item of queue.filter(entry => entry.cleared === null)) {
    recorder.observations.push({ kind: 'undelivered-queue-entry', monotonicMs: onClock(item.timestamp), evidencePath: `transcript#L${item.line}`, detail: 'still queued when the session exited' });
  }
  if (before && after && (after.siblingTranscripts !== before.siblingTranscripts || after.sessionIds.some(id => id !== input.sessionId))) {
    replaced = true;
    limitations.push('A new session transcript appeared in the target project directory.');
  }
  for (const key of ['cwds', 'permissionModes', 'models'] as const) {
    if (before && after && after[key].some(value => !before[key].includes(value))) limitations.push(`Session ${key} changed during the run.`);
  }

  const raw = recorder.log.map(entry => JSON.stringify({ monotonicMs: Math.round(entry.monotonicMs), message: entry.message })).join('\n');
  await writeFile(join(runDir, 'events.jsonl'), raw, { mode: 0o600 });
  await rm(feedPath, { force: true });

  const humanActions = setupActions.filter(action => action.actor === 'human');
  if (humanActions.length > 0) limitations.push(`${humanActions.length} human permission confirmation(s) were needed; the no-setup contract is not met without a pre-existing allow rule.`);
  if (consumed && !markerRecalled) limitations.push('Nonce consumed but the prior context marker was not reported.');
  const outcome: ProbeReport['outcome'] = replaced ? 'unsupported'
    : consumed && markerRecalled && humanActions.length === 0 && !limitations.some(text => text.includes('changed')) ? 'supported'
    : consumed && markerRecalled ? 'unsupported'
    : 'inconclusive';

  return {
    harness: 'claude', version: String(init?.claude_code_version ?? 'unobserved'), mode: input.mode,
    originalSessionId: input.sessionId, observedSessionId, setupActions, observations: recorder.observations,
    identity: { before, after, init }, outcome, limitations, rawLogSha256: raw ? sha256(raw) : null,
  };
}

// Live driver: resumes the designated session under its own ID via the pinned Agent SDK and installed CLI.
export async function liveOpenSession(claudeBinary: string): Promise<OpenSession> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  return ({ sessionId, workdir, canUseTool }) => {
    const input = new Pushable<{ type: 'user'; message: { role: 'user'; content: string }; parent_tool_use_id: null; origin: { kind: 'human' } }>();
    const abortController = new AbortController();
    const q = query({
      prompt: input,
      options: { resume: sessionId, cwd: workdir, pathToClaudeCodeExecutable: claudeBinary, abortController, canUseTool, stderr: () => {} },
    });
    return {
      messages: q as AsyncIterable<StreamMessage>,
      send: text => input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, origin: { kind: 'human' } }),
      end: () => input.end(),
      abort: () => abortController.abort(),
    };
  };
}

// Seeds the prior context marker in its own earlier run, so later probes test recall across a process boundary.
export async function seedMarker(sessionId: string, workdir: string, open: OpenSession, deadlineMs: number, allowed: readonly Target[] = DESIGNATED_TARGETS): Promise<{ sessionId: string | null; acknowledged: boolean }> {
  assertDesignatedTarget(sessionId, workdir, allowed);
  const recorder = new Recorder(() => performance.now(), 'seed');
  const session = open({ sessionId, workdir, canUseTool: async () => ({ behavior: 'deny', message: 'No tools while seeding.' }) });
  const pump = (async () => { try { for await (const message of session.messages) recorder.record(message); } finally { recorder.close(); } })();
  session.send(seedPrompt());
  const init = await recorder.waitFor(message => message.type === 'system' && message.subtype === 'init', deadlineMs);
  const done = await recorder.waitFor(message => message.type === 'result', deadlineMs);
  session.end();
  await pump;
  return {
    sessionId: init >= 0 ? String(recorder.log[init].message.session_id) : null,
    acknowledged: done >= 0 && recorder.log.some(entry => assistantText(entry.message).includes('MARKER-STORED')),
  };
}

export type CliCommand =
  | { kind: 'inventory'; deadlineMs: number }
  | { kind: 'seed'; sessionId: string; workdir: string; deadlineMs: number }
  | { kind: 'probe'; input: ProbeInput; out: string };

const USAGE = `Usage:
  npm run probe -- --inventory [--deadline-ms N]
  npm run probe -- --seed --session-id <uuid> --workdir <abs-path> [--deadline-ms N]
  npm run probe -- --session-id <uuid> --workdir <abs-path> --nonce <nonce> --mode idle|busy|disconnect [--deadline-ms N] [--out dir]

Only the designated disposable session and workdir in DESIGNATED_TARGETS (probe.ts) are accepted. --inventory runs just \`claude --version\` and \`claude --help\`.`;

export function parseArguments(args: readonly string[]): CliCommand | 'help' {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--inventory' || arg === '--seed') {
      if (flags.has(arg)) throw new Error(`${arg} given twice`);
      flags.add(arg);
      continue;
    }
    if (!['--session-id', '--workdir', '--nonce', '--mode', '--deadline-ms', '--out'].includes(arg)) throw new Error(`Unknown argument ${arg}`);
    const value = args[++index];
    if (value === undefined || value.startsWith('--') || values.has(arg)) throw new Error(`${arg} needs exactly one value`);
    values.set(arg, value);
  }
  const deadlineText = values.get('--deadline-ms') ?? '600000';
  if (!/^\d+$/.test(deadlineText)) throw new Error('--deadline-ms must be an integer');
  const deadlineMs = Number(deadlineText);
  if (flags.size > 1) throw new Error('--inventory and --seed are exclusive');
  if (flags.has('--inventory')) {
    if (values.size > (values.has('--deadline-ms') ? 1 : 0)) throw new Error('--inventory takes only --deadline-ms');
    return { kind: 'inventory', deadlineMs };
  }
  const sessionId = values.get('--session-id');
  const workdir = values.get('--workdir');
  if (!sessionId || !workdir) throw new Error('--session-id and --workdir are required');
  assertDesignatedTarget(sessionId, workdir);
  if (flags.has('--seed')) return { kind: 'seed', sessionId, workdir, deadlineMs };
  const input: ProbeInput = { sessionId, expectedWorkdir: workdir, nonce: values.get('--nonce') ?? '', mode: values.get('--mode') as Mode, deadlineMs };
  validateInput(input);
  return { kind: 'probe', input, out: values.get('--out') ?? 'runs' };
}

async function main(): Promise<void> {
  const command = parseArguments(process.argv.slice(2));
  if (command === 'help') { console.log(USAGE); return; }
  const claudeBinary = process.env.KHALA_CLAUDE_BIN ?? 'claude';
  if (command.kind === 'inventory') { console.log(JSON.stringify(await collectInventory(command.deadlineMs, claudeBinary), null, 2)); return; }
  const { execFileSync } = await import('node:child_process');
  const resolved = execFileSync('which', [claudeBinary], { encoding: 'utf8' }).trim();
  const open = await liveOpenSession(resolved);
  if (command.kind === 'seed') { console.log(JSON.stringify(await seedMarker(command.sessionId, command.workdir, open, command.deadlineMs), null, 2)); return; }
  const runDir = join(command.out, `${new Date().toISOString().replace(/[:.]/g, '-')}-${command.input.mode}`);
  const report = await runAttachmentProbe(command.input, { openSession: open, snapshot: snapshotTranscript, entriesFrom: transcriptEntriesFrom, runDir, busySeconds: 20 });
  const json = sanitize(JSON.stringify(report, null, 2));
  await writeFile(join(runDir, 'report.json'), json);
  console.log(json);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(sanitize(String((error as Error).message ?? error))); console.error(USAGE); process.exitCode = 1; });
}

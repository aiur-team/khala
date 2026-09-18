/**
 * Live fixture driver for the explicitly designated disposable Codex thread.
 * One process, one monotonic clock. It hosts the existing session in a native
 * app-server, then delivers from separate notifier connections. It never forks,
 * starts a thread, overrides settings, answers approvals, or replays blindly.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { sameSessionAcceptance, withConditions, type Acceptance, type CaseConditions, type Settings } from './acceptance.js';
import { assertThreadMatches, refuseIfHeld, runWithCleanup, spawnedLockHolder, validateTarget, type Target } from './guards.js';
import { groupPids, lockHolder, pidsMatching, socketListenerPid, stopProcess as stopGroup } from './proc.js';
import { WsRpcClient, type Message } from './ws-rpc.js';

type Event = { t: number; conn: string; method: string; threadId?: string; turnId?: string;
  itemType?: string; clientId?: string | null; status?: string; text?: string; exitCode?: number | null; durationMs?: number | null };

const t0 = performance.now();
const now = () => Math.round((performance.now() - t0) * 10) / 10;
const events: Event[] = [];
const waiters = new Set<() => void>();
/** Literal replacements applied to everything published; the scratch dir and model are added once known. */
const redactions: [string, string][] = [];
const redact = (s: string) => [...redactions, [homedir(), '<HOME>'] as [string, string]]
  .reduce((out, [from, to]) => from ? out.split(from).join(to) : out, s);

function record(conn: string, m: Message): void {
  const p = (m.params ?? {}) as Record<string, any>;
  const item = p.item as Record<string, any> | undefined;
  const e: Event = { t: now(), conn, method: m.method, threadId: p.threadId, turnId: p.turnId ?? p.turn?.id };
  if (p.turn?.status) e.status = p.turn.status;
  if (p.status?.type) e.status = p.status.type;
  if (item) {
    e.itemType = item.type;
    if (item.type === 'userMessage') {
      e.clientId = item.clientId;
      e.text = (item.content ?? []).map((c: any) => c.text ?? '').join('');
    }
    if (item.type === 'agentMessage' && m.method === 'item/completed') e.text = item.text;
    if (item.type === 'commandExecution') { e.status = item.status; e.exitCode = item.exitCode ?? null; e.durationMs = item.durationMs ?? null; }
  }
  if (m.method.includes('delta') || m.method.startsWith('account/') || m.method.includes('tokenUsage')) return;
  events.push(e);
  for (const w of waiters) w();
}

function waitFor(pred: (e: Event) => boolean, timeoutMs: number, from = 0): Promise<Event | null> {
  return new Promise(resolve => {
    let i = from;
    const check = () => {
      for (; i < events.length; i++) if (pred(events[i])) { done(); resolve(events[i]); return; }
    };
    const timer = setTimeout(() => { done(); resolve(null); }, timeoutMs);
    const done = () => { clearTimeout(timer); waiters.delete(check); };
    waiters.add(check);
    check();
  });
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Executors this driver started; a failed run must not leave one holding the thread. */
const spawned: ChildProcess[] = [];

let rolloutPath = '';
function rolloutDigest(): { bytes: number; sha256: string } | null {
  if (!existsSync(rolloutPath)) return null;
  const data = readFileSync(rolloutPath);
  return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}

async function startExecutor(sock: string, workdir: string, log: string): Promise<ChildProcess> {
  // Own process group: the `codex` launcher execs a separate native binary, which
  // must not outlive the launcher and keep holding the thread.
  const child = spawn('codex', ['app-server', '--listen', `unix://${sock}`], { cwd: workdir, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  spawned.push(child);
  const chunks: Buffer[] = [];
  child.stderr!.on('data', c => chunks.push(c));
  child.once('exit', () => writeFileSync(log, Buffer.concat(chunks)));
  for (let i = 0; i < 150 && !existsSync(sock); i++) await sleep(100);
  if (!existsSync(sock)) throw new Error('executor socket did not appear');
  return child;
}
async function stopProcess(child: ChildProcess) {
  return { ...await stopGroup(child), t: now() };
}
async function connect(name: string, sock: string, deadlineMs = 300_000): Promise<WsRpcClient> {
  const c = await WsRpcClient.connect(sock, deadlineMs, m => record(name, m));
  await c.initialize(`khala_${name}`);
  return c;
}
function settingsOf(r: any): Settings {
  return { model: r.model ?? null, cwd: r.cwd ?? null, approvalPolicy: r.approvalPolicy, sandbox: r.sandbox, reasoningEffort: r.reasoningEffort ?? null };
}
const text = (t: string) => [{ type: 'text', text: t, text_elements: [] }];
function deliveryText(nonce: string): string {
  return `Synthetic approved attachment probe: reply with one line containing exactly ${nonce} followed by the prior context marker you were asked to remember earlier in this conversation. Do not run tools or change settings.`;
}

async function main(target: Target): Promise<void> {
  const { threadId, workdir, priorMarker, scratchDir } = target;
  validateTarget(target, homedir(), realpathSync(workdir));
  rolloutPath = target.rollout;
  redactions.push([scratchDir, '<SCRATCH>']);
  mkdirSync(scratchDir, { recursive: true });
  const runId = randomUUID().slice(0, 8);
  const sockA = join(scratchDir, `exec-${runId}.sock`);
  const setupActions: { actor: 'agent' | 'human'; action: string; t: number }[] = [];
  const cases: Record<string, unknown> = {};
  const version = await new Promise<string>(r => execFile('codex', ['--version'], (_e, o) => r(String(o).trim())));
  const rolloutBefore = rolloutDigest();
  const statusBefore = { lockHolder: lockHolder(threadId) };
  refuseIfHeld(statusBefore.lockHolder);

  // Setup: host the designated thread in one native executor. Rejoin without overrides.
  const A = await startExecutor(sockA, workdir, join(scratchDir, `exec-${runId}.stderr`));
  setupActions.push({ actor: 'agent', action: 'Start `codex app-server --listen unix://<scratch>/exec.sock` in the fixture workdir.', t: now() });
  const owner = await connect('owner', sockA);
  const preRead: any = await owner.request('thread/read', { threadId, includeTurns: false });
  assertThreadMatches(preRead?.thread, target);
  const resumed: any = await owner.request('thread/resume', { threadId, excludeTurns: true });
  setupActions.push({ actor: 'agent', action: 'Owner connection: thread/resume {threadId, excludeTurns:true}; no model/cwd/approval/sandbox overrides.', t: now() });
  assertThreadMatches({ id: resumed?.thread?.id, cwd: resumed?.cwd }, target);
  const s0 = settingsOf(resumed);
  if (s0.model) redactions.unshift([s0.model, '<MODEL>']);
  const executor = { pid: A.pid!, lockHolderAfterLoad: lockHolder(threadId), preLoadStatus: preRead?.thread?.status?.type ?? null, resumedThreadId: resumed.thread?.id };
  // The launcher execs a native binary; that binary holds the writer lock and is the executor identity.
  const nativeA = spawnedLockHolder(executor.lockHolderAfterLoad, groupPids(A.pid!));
  const reread = async (): Promise<Settings> => settingsOf(await owner.request('thread/resume', { threadId, excludeTurns: true }));

  async function deliver(label: string, conn: string, opts: { cid?: string; nonce?: string } = {}) {
    const cid = opts.cid ?? randomUUID();
    const nonce = opts.nonce ?? `release-nonce-${runId}-${label}`;
    const notifier = await connect(conn, sockA);
    const attempt = now();
    let ack: number | null = null; let queueId: string | null = null; let error: unknown = null;
    try {
      const r: any = await notifier.request('thread/queue/add', { threadId, clientUserMessageId: cid, input: text(deliveryText(nonce)) });
      ack = now(); queueId = r?.queuedSubmission?.id ?? null;
      if (r?.queuedSubmission?.clientUserMessageId !== cid) error = 'client_id_mismatch';
    } catch (e: any) { error = e?.remote ?? e?.code ?? 'unknown'; }
    await notifier.close();
    return { cid, nonce, attempt, ack, queueIdSha256: queueId ? createHash('sha256').update(queueId).digest('hex').slice(0, 16) : null, error };
  }
  async function observeConsumption(cid: string, nonce: string, from: number, timeoutMs = 180_000) {
    const consumed = await waitFor(e => e.itemType === 'userMessage' && e.clientId === cid, timeoutMs, from);
    if (!consumed) return { consumedAt: null, turnId: null, reply: null, turnCompletedAt: null, consumedCount: 0, observedThreadId: null,
      executorPidAtConsumption: null, lockHolderAtConsumption: null };
    // Sampled as soon as the consumption is observed: the process serving the socket
    // that carried the event, and the writer-lock holder.
    const executorPidAtConsumption = socketListenerPid(sockA);
    const lockHolderAtConsumption = lockHolder(threadId);
    const done = await waitFor(e => e.method === 'turn/completed' && e.turnId === consumed.turnId, timeoutMs, from);
    const reply = [...events].reverse().find(e => e.itemType === 'agentMessage' && e.turnId === consumed.turnId && e.text) ?? null;
    await sleep(1500);
    const consumedCount = new Set(events.filter(e => e.itemType === 'userMessage' && e.clientId === cid && e.method === 'item/completed').map(e => e.turnId)).size
      || events.filter(e => e.itemType === 'userMessage' && e.clientId === cid && e.method === 'item/started').length;
    return { consumedAt: consumed.t, turnId: consumed.turnId, reply: reply?.text ?? null, replyAt: reply?.t ?? null,
      turnCompletedAt: done?.t ?? null, turnStatus: done?.status ?? null, consumedCount, observedThreadId: consumed.threadId ?? null, nonceSeen: Boolean(reply?.text?.includes(nonce)),
      executorPidAtConsumption, lockHolderAtConsumption };
  }
  const accept = (d: { cid: string; nonce: string }, c: any, before: Settings, after: Settings, conditions: CaseConditions): Acceptance => withConditions(sameSessionAcceptance({
    originalThreadId: threadId, originalExecutorPid: nativeA, lockHolderPid: c.lockHolderAtConsumption, observedExecutorPid: c.executorPidAtConsumption ?? -1,
    observedThreadId: c.observedThreadId, clientUserMessageId: d.cid, consumedMessageCount: c.consumedCount,
    replyText: c.reply, nonce: d.nonce, priorMarker, deliveredText: deliveryText(d.nonce), settingsBefore: before, settingsAfter: after }), conditions);
  const busyConditions = (b: { commandStartedAt: number | null }, o: { commandCompletedAt: number | null; exitCode: number | null },
    deliveredAt: number | null, consumedInBusyTurn: boolean, statusAtDelivery?: string | null): CaseConditions => ({
    kind: 'busy', statusAtDelivery, commandStartedAt: b.commandStartedAt, commandCompletedAt: o.commandCompletedAt,
    commandExitCode: o.exitCode, deliveredAt, consumedInBusyTurn });
  async function busyTurn(seconds: number) {
    const from = events.length;
    const r: any = await owner.request('turn/start', { threadId, input: text(`Run exactly this shell command once and wait for it: sleep ${seconds}. Then reply BUSY-DONE.`) });
    const busyTurnId = r?.turn?.id;
    const cmd = await waitFor(e => e.method === 'item/started' && e.itemType === 'commandExecution' && e.turnId === busyTurnId, 120_000, from);
    return { busyTurnId, commandStartedAt: cmd?.t ?? null, from };
  }
  async function busyOutcome(busyTurnId: string, from: number) {
    const cmdDone = await waitFor(e => e.method === 'item/completed' && e.itemType === 'commandExecution' && e.turnId === busyTurnId, 180_000, from);
    const turnDone = await waitFor(e => e.method === 'turn/completed' && e.turnId === busyTurnId, 180_000, from);
    return { commandCompletedAt: cmdDone?.t ?? null, commandStatus: cmdDone?.status ?? null, exitCode: cmdDone?.exitCode ?? null,
      durationMs: cmdDone?.durationMs ?? null, busyTurnCompletedAt: turnDone?.t ?? null, busyTurnStatus: turnDone?.status ?? null };
  }

  // Idle. The native queue is durable across executor exit and drains on load, so
  // wait for leftovers to finish (recorded, never deleted) before calling it idle.
  {
    const drainStart = now();
    let queueAtLoad: number | null = null;
    let status: any;
    let queueDrained = false;
    for (let i = 0; i < 240; i++) {
      const list: any = await owner.request('thread/queue/list', { threadId });
      queueAtLoad ??= (list?.data ?? []).length;
      status = await owner.request('thread/read', { threadId, includeTurns: false });
      if ((list?.data ?? []).length === 0 && status?.thread?.status?.type === 'idle') { queueDrained = true; break; }
      await sleep(500);
    }
    cases.drainBeforeIdle = { queueAtLoad, queueDrained, waitedMs: Math.round(now() - drainStart),
      turnsDrained: new Set(events.filter(e => e.method === 'turn/completed').map(e => e.turnId)).size };
    const before = await reread();
    const from = events.length;
    const d = await deliver('idle', 'notifier-idle');
    const c = await observeConsumption(d.cid, d.nonce, from);
    const after = await reread();
    const statusAtDelivery = status?.thread?.status?.type ?? null;
    cases.idle = { statusAtDelivery, delivery: d, consumption: c,
      acceptance: accept(d, c, before, after, { kind: 'idle', queueDrained, statusAtDelivery }) };
  }
  // Busy: queued during a controlled long tool call.
  {
    const before = await reread();
    const b = await busyTurn(25);
    const status: any = await owner.request('thread/read', { threadId, includeTurns: false });
    const d = await deliver('busy', 'notifier-busy');
    const o = await busyOutcome(b.busyTurnId, b.from);
    const c = await observeConsumption(d.cid, d.nonce, b.from, 240_000);
    const after = await reread();
    const statusAtDelivery = status?.thread?.status?.type ?? null;
    const consumedInBusyTurn = c.turnId === b.busyTurnId;
    cases.busy = { statusAtDelivery, busy: { ...b, ...o, from: undefined }, delivery: d, consumption: c, consumedInBusyTurn,
      acceptance: accept(d, c, before, after, busyConditions(b, o, d.ack, consumedInBusyTurn, statusAtDelivery)) };
  }
  // Disconnect after write, before response; reconcile. The same-ID replay is an opt-in
  // semantics probe: earlier runs showed it creates a second, executed entry.
  {
    const before = await reread();
    const b = await busyTurn(30);
    const cid = randomUUID(); const nonce = `release-nonce-${runId}-disconnect`;
    const lost = await connect('notifier-lost', sockA);
    const attempt = now();
    await lost.writeOnly('thread/queue/add', { threadId, clientUserMessageId: cid, input: text(deliveryText(nonce)) });
    lost.terminate();
    const writeFlushedAt = now();
    const ackSeenBySender = events.some(e => e.conn === 'notifier-lost' && e.t >= attempt && e.method === 'thread/queue/changed');
    const rec = await connect('notifier-reconcile', sockA);
    const list1: any = await rec.request('thread/queue/list', { threadId });
    const original = new Set((list1?.data ?? []).filter((q: any) => q.clientUserMessageId === cid).map((q: any) => q.id));
    const pendingAfterDisconnect = original.size;
    let replay: any = null; let replayError: unknown = null;
    if (target.replayProbe) {
      try { replay = await rec.request('thread/queue/add', { threadId, clientUserMessageId: cid, input: text(deliveryText(nonce)) }); }
      catch (e: any) { replayError = e?.remote ?? e?.code ?? 'unknown'; }
    }
    const list2: any = await rec.request('thread/queue/list', { threadId });
    const matches = (list2?.data ?? []).filter((q: any) => q.clientUserMessageId === cid);
    // Delete only entries that were not pending before the replay, whatever order list returns.
    let duplicateDeleted = false;
    for (const q of matches.filter((q: any) => !original.has(q.id))) {
      await rec.request('thread/queue/delete', { threadId, queuedSubmissionId: q.id });
      duplicateDeleted = true;
    }
    const list3: any = await rec.request('thread/queue/list', { threadId });
    await rec.close();
    const o = await busyOutcome(b.busyTurnId, b.from);
    const c = await observeConsumption(cid, nonce, b.from, 240_000);
    const after = await reread();
    cases.disconnect = { busy: { ...b, ...o, from: undefined }, attempt, writeFlushedAt, ackSeenBySender,
      reconcile: { pendingAfterDisconnect, replayProbe: Boolean(target.replayProbe), replayAccepted: Boolean(replay?.queuedSubmission), replayError,
        sameIdEntriesAfterReplay: matches.length, duplicateDeleted,
        sameIdEntriesAfterCleanup: (list3?.data ?? []).filter((q: any) => q.clientUserMessageId === cid).length },
      consumption: c, acceptance: accept({ cid, nonce }, c, before, after, busyConditions(b, o, writeFlushedAt, c.turnId === b.busyTurnId)) };
  }
  // AE2 negative control: a second native executor resuming the same thread.
  {
    const sockB = join(scratchDir, `dup-${runId}.sock`);
    const digestBefore = rolloutDigest();
    const B = await startExecutor(sockB, workdir, join(scratchDir, `dup-${runId}.stderr`));
    const dup = await connect('duplicate', sockB);
    const read: any = await dup.request('thread/read', { threadId, includeTurns: false }).catch((e: any) => ({ error: e?.remote ?? e?.code }));
    let resumeResult: any; let resumeError: unknown = null;
    try { resumeResult = await dup.request('thread/resume', { threadId, excludeTurns: true }); } catch (e: any) { resumeError = e?.remote ?? e?.code ?? 'unknown'; }
    const holder = lockHolder(threadId);
    const nativeB = groupPids(B.pid!).find(p => p !== B.pid) ?? B.pid!;
    await dup.close();
    const stopped = await stopProcess(B);
    const ownerStillLive: any = await owner.request('thread/read', { threadId, includeTurns: false });
    const hypothetical = sameSessionAcceptance({ originalThreadId: threadId, originalExecutorPid: nativeA, lockHolderPid: holder,
      observedExecutorPid: nativeB, observedThreadId: resumeResult?.thread?.id ?? null, clientUserMessageId: 'none',
      consumedMessageCount: 1, replyText: `x ${priorMarker}`, nonce: 'x', priorMarker, deliveredText: deliveryText('x'),
      settingsBefore: s0, settingsAfter: resumeResult ? settingsOf(resumeResult) : s0 });
    cases.duplicateExecutor = { duplicatePid: nativeB, statusSeenByDuplicate: read?.thread?.status?.type ?? read,
      resumeSucceeded: Boolean(resumeResult?.thread), resumedThreadId: resumeResult?.thread?.id ?? null, resumeError,
      lockHolderDuringDuplicate: holder, originalExecutorPid: nativeA, duplicateStopped: stopped,
      ownerStatusAfter: ownerStillLive?.thread?.status?.type, rolloutUnchangedByDuplicate: JSON.stringify(digestBefore) === JSON.stringify(rolloutDigest()),
      acceptanceIfDuplicateConsumed: hypothetical, inputSentToDuplicate: false };
  }
  const sFinal = await reread();
  // Exit: stop the target; delivery must fail closed with no replacement executor.
  {
    const appServersBefore = new Set(pidsMatching('app-server'));
    await owner.close();
    const stopped = await stopProcess(A);
    const digest = rolloutDigest();
    const lockAfterExit = lockHolder(threadId);
    let connectError: unknown = null;
    try { const c = await WsRpcClient.connect(sockA, 5000); await c.close(); } catch (e: any) { connectError = e?.code ?? 'unknown'; }
    const nonce = `release-nonce-${runId}-exit`;
    const cli = await new Promise<{ code: number | null; stderrHead: string; t: number }>(r => {
      const started = now();
      execFile('codex', ['queue', '--remote', `unix://${sockA}`, '--thread', threadId, '--message', deliveryText(nonce)],
        { timeout: 30_000, killSignal: 'SIGKILL' }, (e: any, _o, err) => r({ code: e ? (e.code ?? null) : 0, stderrHead: redact(String(err).split('\n').filter(l => !l.startsWith('WARNING')).slice(0, 2).join(' | ')), t: now() - started }));
    });
    await sleep(3000);
    // Sampled after the delivery attempts: any executor that loaded the thread holds its writer lock.
    const lockHolderAfterAttempts = lockHolder(threadId);
    const replacements = [...pidsMatching(threadId), ...pidsMatching(sockA)];
    const newAppServers = pidsMatching('app-server').filter(p => !appServersBefore.has(p)).length;
    cases.exit = { executorStopped: stopped, lockHolderAfterExit: lockAfterExit, lockHolderAfterAttempts, connectError, cliRemoteQueue: cli,
      replacementProcesses: replacements.length, newAppServerProcesses: newAppServers, rolloutUnchangedAfterExitAttempts: JSON.stringify(digest) === JSON.stringify(rolloutDigest()),
      nonceInRollout: readFileSync(rolloutPath, 'utf8').includes(nonce) };
  }

  const report = {
    harness: 'codex', version, runId, originalThreadId: threadId, workdir: redact(workdir),
    executor, settingsAtLoad: s0, settingsFinal: sFinal, settingsPreserved: JSON.stringify(s0) === JSON.stringify(sFinal),
    setupActions, cases, rolloutBefore, rolloutAfter: rolloutDigest(), statusBefore,
    events: events.map(e => ({ ...e, threadIdMatches: e.threadId === undefined ? undefined : e.threadId === threadId, threadId: undefined })),
  };
  writeFileSync(target.outFile, redact(JSON.stringify(report, null, 2)) + '\n');
  console.log(`wrote ${redact(target.outFile)}`);
}

const input = JSON.parse(readFileSync(0, 'utf8')) as Target;
runWithCleanup(() => main(input), spawned, stopGroup).then(() => process.exit(0), e => {
  console.error('live run failed:', redact(String(e?.message ?? e)), e?.method ?? '', e?.remote ? redact(JSON.stringify(e.remote)) : '', e?.stack ? redact(e.stack.split('\n').slice(1, 4).join(' | ')) : '');
  process.exit(1);
});

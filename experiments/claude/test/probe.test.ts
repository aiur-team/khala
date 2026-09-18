import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runAttachmentProbe, parseArguments, type ProbeDeps } from '../probe.ts';
import { collectInventory, inspectCommand, replayQueue, sanitize, type TranscriptSnapshot } from '../evidence.ts';
import { PRIOR_MARKER, Pushable, type OpenSession, type StreamMessage } from '../scenario.ts';

const SESSION = '00000000-0000-4000-8000-000000000000';
const input = { sessionId: SESSION, expectedWorkdir: '/synthetic/work', nonce: 'synthetic-nonce', mode: 'idle' as const, deadlineMs: 5000 };

const snapshot = async (): Promise<TranscriptSnapshot> => ({
  lines: 1, sha256: 'x', sessionIds: [SESSION], cwds: ['/synthetic/work'], versions: ['0.0.0'], permissionModes: ['default'], models: ['m'], siblingTranscripts: 0,
});

const assistant = (content: unknown[]): StreamMessage => ({ type: 'assistant', message: { content } });
const text = (value: string) => assistant([{ type: 'text', text: value }]);

// A scripted stand-in for the resumed CLI: replays a stale result on resume like the real CLI, then reacts to prompts.
function fakeSession(behavior: { sessionId?: string; consume?: boolean; recall?: boolean }): { open: OpenSession; approvals: string[] } {
  const approvals: string[] = [];
  const open: OpenSession = ({ canUseTool }) => {
    const out = new Pushable<StreamMessage>();
    let turns = 0;
    const init: StreamMessage = { type: 'system', subtype: 'init', session_id: behavior.sessionId ?? SESSION, cwd: '/synthetic/work', model: 'm', permissionMode: 'default', claude_code_version: '0.0.0', tools: ['Monitor'] };
    return {
      messages: out,
      send: prompt => void (async () => {
        if (turns++ === 0) {
          out.push(init);
          out.push({ type: 'result', subtype: 'success', num_turns: 0 });
          out.push(init);
          const command = prompt.match(/`(tail[^`]+)`/)![1];
          out.push(assistant([{ type: 'tool_use', id: 't1', name: 'Monitor', input: { command } }]));
          const decision = await canUseTool('Monitor', { command });
          approvals.push(decision.behavior);
          if (decision.behavior === 'allow') out.push({ type: 'system', subtype: 'task_started' });
          out.push(text('SETUP-DONE'));
          out.push({ type: 'result', subtype: 'success', num_turns: 1 });
          if (behavior.consume) {
            const feed = command.split(' ').at(-1)!;
            const wait = setInterval(async () => {
              const lines = await readFile(feed, 'utf8').catch(() => '');
              const nonce = lines.match(/token (\S+)/)?.[1];
              if (!nonce) return;
              clearInterval(wait);
              out.push({ type: 'system', subtype: 'task_notification', summary: lines });
              out.push(text(`${nonce} ${behavior.recall ? PRIOR_MARKER : ''}`));
              out.push({ type: 'result', subtype: 'success', num_turns: 1 });
            }, 20);
          }
        }
      })(),
      end: () => out.end(),
      abort: () => out.end(),
    };
  };
  return { open, approvals };
}

async function withRunDir<T>(fn: (runDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'kha103-run-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

type Entries = Awaited<ReturnType<ProbeDeps['entriesFrom']>>;
const deps = (open: OpenSession, runDir: string, entries: Entries = []): ProbeDeps => ({ openSession: open, snapshot, entriesFrom: async () => entries, runDir, settleMs: 50 });

const now = Date.now();
const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const queueEntries: Entries = [
  { line: 2, entry: { type: 'queue-operation', operation: 'enqueue', timestamp: at(0), content: '<task-notification>{"id":"m-idle","text":"token synthetic-nonce"}' } },
  { line: 3, entry: { type: 'queue-operation', operation: 'dequeue', timestamp: at(5) } },
  { line: 4, entry: { type: 'user', origin: { kind: 'task-notification' }, timestamp: at(6) } },
  { line: 5, entry: { type: 'queue-operation', operation: 'enqueue', timestamp: at(9), content: '<task-notification>stopped' } },
];

test('invalid target and deadline arguments fail closed', async () => {
  const { open } = fakeSession({});
  for (const change of [{ sessionId: '' }, { sessionId: 'not-a-uuid' }, { expectedWorkdir: 'relative' }, { nonce: '' }, { mode: 'replay' }, { deadlineMs: 0 }, { deadlineMs: Infinity }, { deadlineMs: 1500.5 }]) {
    await assert.rejects(runAttachmentProbe({ ...input, ...change } as typeof input, deps(open, '/nonexistent')));
  }
  for (const args of [[], ['--resume', 'id'], ['--inventory', '--nonce', 'x'], ['--session-id', 'x'], ['--inventory', '--inventory'], ['--inventory', '--deadline-ms', 'wat'], ['--inventory', '--seed']]) {
    assert.throws(() => parseArguments(args));
  }
  assert.equal(parseArguments(['--help']), 'help');
});

test('the replayed resume result does not end setup; consumption with recall still needs a human approval', async () => {
  await withRunDir(async runDir => {
    const { open, approvals } = fakeSession({ consume: true, recall: true });
    const report = await runAttachmentProbe(input, deps(open, runDir, queueEntries));
    assert.deepEqual(approvals, ['allow']);
    const byKind = new Map(report.observations.map(entry => [entry.kind, entry]));
    assert.equal(byKind.get('native-queue-accepted')?.evidencePath, 'transcript#L2');
    assert.equal(byKind.get('native-queue-delivered')?.evidencePath, 'transcript#L3');
    assert.equal(byKind.get('undelivered-queue-entry')?.evidencePath, 'transcript#L5');
    assert.ok(!report.limitations.some(entry => entry.includes('no matching native queue entry')));
    const kinds = report.observations.map(entry => entry.kind);
    for (const kind of ['session-init', 'agent-setup-tool-call', 'setup-complete', 'notification-write', 'context-consumption', 'prior-marker-recalled', 'task-complete']) assert.ok(kinds.includes(kind), kind);
    assert.equal(report.observedSessionId, SESSION);
    assert.ok(report.setupActions.some(action => action.actor === 'human'));
    assert.equal(report.outcome, 'unsupported');
  });
});

test('a nonce without the prior marker is not claimed as continuity', async () => {
  await withRunDir(async runDir => {
    const { open } = fakeSession({ consume: true, recall: false });
    const report = await runAttachmentProbe(input, deps(open, runDir));
    assert.ok(report.limitations.some(entry => entry.includes('prior context marker was not reported')));
    assert.ok(report.limitations.some(entry => entry.includes('no matching native queue entry')));
    assert.notEqual(report.outcome, 'supported');
  });
});

test('a different resumed session ID is a replacement, not attachment', async () => {
  await withRunDir(async runDir => {
    const { open } = fakeSession({ sessionId: '11111111-1111-4111-8111-111111111111', consume: true, recall: true });
    const report = await runAttachmentProbe(input, deps(open, runDir));
    assert.equal(report.outcome, 'unsupported');
    assert.ok(!report.observations.some(entry => entry.kind === 'notification-write'));
  });
});

test('no delivery before the deadline is inconclusive and the session is still closed', async () => {
  await withRunDir(async runDir => {
    const { open } = fakeSession({ consume: false });
    const started = performance.now();
    const report = await runAttachmentProbe({ ...input, deadlineMs: 1000 }, deps(open, runDir));
    assert.equal(report.outcome, 'inconclusive');
    assert.ok(report.observations.some(entry => entry.kind === 'session-exit'));
    assert.ok(performance.now() - started < 10_000);
  });
});

test('a message released after the watch dies is reported undelivered, never replayed', async () => {
  await withRunDir(async runDir => {
    const { open } = fakeSession({ consume: true, recall: true });
    const report = await runAttachmentProbe({ ...input, mode: 'disconnect', deadlineMs: 20_000 }, deps(open, runDir));
    assert.ok(report.observations.some(entry => entry.kind === 'connector-disconnect'));
    assert.ok(report.limitations.some(entry => entry.includes('No replay was attempted')));
    assert.ok(report.limitations.some(entry => entry.includes('nothing reconnects the watch')));
  });
});

test('queue replay pairs FIFO dequeues and mid-turn removals with the right items', () => {
  const op = (line: number, operation: string, content?: string) => ({ line, entry: { type: 'queue-operation', operation, content, timestamp: at(line) } });
  const fates = replayQueue([
    op(1, 'enqueue', 'stale-stop'), op(2, 'dequeue'),
    op(3, 'enqueue', 'busy-prompt'), op(4, 'dequeue'),
    op(5, 'enqueue', 'released m-busy'), { line: 6, entry: { type: 'attachment' } }, op(7, 'remove', 'released m-busy'),
    op(8, 'enqueue', 'watch stopped'),
  ]);
  assert.deepEqual(fates.map(fate => [fate.content, fate.cleared?.operation ?? null, fate.cleared?.line ?? null]), [
    ['stale-stop', 'dequeue', 2], ['busy-prompt', 'dequeue', 4], ['released m-busy', 'remove', 7], ['watch stopped', null, null],
  ]);
});

test('published text redacts private paths and common credential forms', () => {
  const result = sanitize('at /home/alice/private, /Users/bob/work and C:\\Users\\bob\\work token=secret-123 Authorization: Bearer abc123 sk-ant-12345678901234567890');
  for (const value of ['alice', 'bob', 'secret-123', 'abc123', 'sk-ant-12345678901234567890']) assert.ok(!result.includes(value));
});

// Fake binaries use .cjs so `require` works regardless of an enclosing package's module type.
test('inventory executes only version and help, never session commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kha103-commands-'));
  try {
    const binary = join(dir, 'claude.cjs');
    const log = join(dir, 'args.jsonl');
    await writeFile(binary, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');\nconsole.log(process.argv[2] === '--version' ? '2.1.271 (Claude Code)' : 'Usage: claude [options]');\n`, { mode: 0o700 });
    const result = await collectInventory(2000, binary);
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), [['--version'], ['--help']]);
    assert.equal(result.version, '2.1.271');
    assert.ok(result.commands.every(command => command.exitCode === 0));
    assert.ok(!JSON.stringify(result).includes(dir));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('deadline kills a real uncooperative inspection child before resolving', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kha103-deadline-'));
  try {
    const binary = join(dir, 'claude.cjs');
    const pidFile = join(dir, 'pid');
    await writeFile(binary, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const started = performance.now();
    const report = await inspectCommand(binary, '--help', 500);
    assert.equal(report.status, 'deadline');
    assert.ok(performance.now() - started < 3000);
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

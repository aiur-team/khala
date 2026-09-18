import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DESIGNATED_TARGETS, runAttachmentProbe, parseArguments, seedMarker, type ProbeDeps } from '../probe.ts';
import { collectInventory, inspectCommand, projectDir, replayQueue, sanitize, snapshotTranscript, transcriptEntriesFrom, type TranscriptSnapshot } from '../evidence.ts';
import { PRIOR_MARKER, Pushable, type OpenSession, type StreamMessage } from '../scenario.ts';

const SESSION = '00000000-0000-4000-8000-000000000000';
const input = { sessionId: SESSION, expectedWorkdir: '/synthetic/work', nonce: 'synthetic-nonce', mode: 'idle' as const, deadlineMs: 5000 };
const TARGETS = [{ sessionId: SESSION, workdir: '/synthetic/work' }];

const baseSnapshot: TranscriptSnapshot = {
  lines: 1, sha256: 'x', sessionIds: [SESSION], cwds: ['/synthetic/work'], versions: ['0.0.0'], permissionModes: ['default'], models: ['m'], siblingTranscripts: 0,
};
const snapshot = async (): Promise<TranscriptSnapshot> => baseSnapshot;
// The first snapshot is taken before the run; later ones see the given change.
const changingSnapshot = (change: Partial<TranscriptSnapshot>): ProbeDeps['snapshot'] => {
  let calls = 0;
  return async () => (calls++ === 0 ? baseSnapshot : { ...baseSnapshot, ...change });
};

const assistant = (content: unknown[]): StreamMessage => ({ type: 'assistant', message: { content } });
const text = (value: string) => assistant([{ type: 'text', text: value }]);

// A scripted stand-in for the resumed CLI: replays a stale result on resume like the real CLI, then reacts to prompts.
type ToolRequest = { tool: string; input: Record<string, unknown> };
type FakeBehavior = { sessionId?: string; cwd?: string; consume?: boolean; recall?: boolean; setupRequests?: (feed: string) => ToolRequest[]; busyRequests?: (command: string) => ToolRequest[] };

function fakeSession(behavior: FakeBehavior): { open: OpenSession; approvals: string[]; extra: string[]; opened: () => number } {
  const approvals: string[] = [];
  const extra: string[] = [];
  let opens = 0;
  const open: OpenSession = ({ canUseTool }) => {
    opens++;
    const out = new Pushable<StreamMessage>();
    let turns = 0;
    const init: StreamMessage = { type: 'system', subtype: 'init', session_id: behavior.sessionId ?? SESSION, cwd: behavior.cwd ?? '/synthetic/work', model: 'm', permissionMode: 'default', claude_code_version: '0.0.0', tools: ['Monitor'] };
    return {
      messages: out,
      send: prompt => void (async () => {
        if (turns++ > 0) {
          const command = prompt.match(/: (sleep \d+ && echo \S+)\./)?.[1];
          if (!command) return;
          for (const request of behavior.busyRequests?.(command) ?? []) extra.push((await canUseTool(request.tool, request.input)).behavior);
          out.push(assistant([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command } }]));
          approvals.push((await canUseTool('Bash', { command })).behavior);
          // Like the real foreground tool, the result arrives after the probe's release write.
          await new Promise(resolve => setTimeout(resolve, 300));
          out.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: command.split(' ').at(-1) }] } });
          return;
        }
        {
          out.push(init);
          out.push({ type: 'result', subtype: 'success', num_turns: 0 });
          out.push(init);
          const command = prompt.match(/`(tail[^`]+)`/)![1];
          out.push(assistant([{ type: 'tool_use', id: 't1', name: 'Monitor', input: { command } }]));
          const decision = await canUseTool('Monitor', { command });
          approvals.push(decision.behavior);
          for (const request of behavior.setupRequests?.(command.split(' ').at(-1)!) ?? []) extra.push((await canUseTool(request.tool, request.input)).behavior);
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
  return { open, approvals, extra, opened: () => opens };
}

async function withRunDir<T>(fn: (runDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'kha103-run-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

type Entries = Awaited<ReturnType<ProbeDeps['entriesFrom']>>;
const deps = (open: OpenSession, runDir: string, entries: Entries = [], extra: Partial<ProbeDeps> = {}): ProbeDeps => ({
  openSession: open, snapshot, entriesFrom: async () => entries, runDir, settleMs: 50, allowedTargets: TARGETS, findProcesses: async () => [], ...extra,
});

const now = Date.now();
const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const queueEntries: Entries = [
  { line: 2, entry: { type: 'queue-operation', operation: 'enqueue', timestamp: at(0), content: '<task-notification>{"id":"m-idle","text":"token synthetic-nonce"}' } },
  { line: 3, entry: { type: 'queue-operation', operation: 'dequeue', timestamp: at(5) } },
  { line: 4, entry: { type: 'user', origin: { kind: 'task-notification' }, timestamp: at(6) } },
  { line: 5, entry: { type: 'queue-operation', operation: 'enqueue', timestamp: at(9), content: '<task-notification>stopped' } },
];

const exists = (path: string) => access(path).then(() => true, () => false);
const OTHER = '11111111-1111-4111-8111-111111111111';

test('each invalid input fails with its own validation error before the session or run dir is touched', async () => {
  await withRunDir(async root => {
    const cases: [Partial<typeof input>, RegExp, typeof TARGETS?][] = [
      [{ sessionId: '' }, /sessionId must be the designated session UUID/],
      [{ sessionId: 'not-a-uuid' }, /sessionId must be the designated session UUID/],
      [{ expectedWorkdir: 'relative' }, /expectedWorkdir must be absolute/, [{ sessionId: SESSION, workdir: 'relative' }]],
      [{ nonce: '' }, /nonce must be/],
      [{ mode: 'replay' as never }, /mode must be/],
      [{ deadlineMs: 0 }, /deadlineMs must be/],
      [{ deadlineMs: Infinity }, /deadlineMs must be/],
      [{ deadlineMs: 1500.5 }, /deadlineMs must be/],
      [{ sessionId: OTHER }, /not a designated disposable target/],
      [{ expectedWorkdir: '/synthetic/other' }, /not a designated disposable target/],
      [{ expectedWorkdir: '/synthetic/work/' }, /not a designated disposable target/],
    ];
    for (const [change, error, targets] of cases) {
      const { open, opened } = fakeSession({});
      const runDir = join(root, 'run');
      await assert.rejects(runAttachmentProbe({ ...input, ...change }, deps(open, runDir, [], targets ? { allowedTargets: targets } : {})), error, JSON.stringify(change));
      assert.equal(opened(), 0);
      assert.equal(await exists(runDir), false);
    }
  });
});

test('the allowlist pairs the session with its workdir and defaults to the one designated target', async () => {
  const { open, opened } = fakeSession({});
  const crossed = [{ sessionId: SESSION, workdir: '/synthetic/other' }, { sessionId: OTHER, workdir: '/synthetic/work' }];
  await assert.rejects(runAttachmentProbe(input, deps(open, '/unused', [], { allowedTargets: crossed })), /not a designated disposable target/);
  await assert.rejects(runAttachmentProbe(input, deps(open, '/unused', [], { allowedTargets: undefined })), /not a designated disposable target/);
  assert.equal(opened(), 0);
  assert.deepEqual(DESIGNATED_TARGETS.map(target => target.sessionId), ['51b0420c-e090-4215-81f0-2d1f7073a07c']);
});

test('--seed refuses any session that is not the designated target, before opening it', async () => {
  const { open, opened } = fakeSession({});
  await assert.rejects(seedMarker(SESSION, '/synthetic/work', open, 1000), /not a designated disposable target/);
  await assert.rejects(seedMarker(OTHER, '/synthetic/work', open, 1000, TARGETS), /not a designated disposable target/);
  assert.equal(opened(), 0);
  assert.throws(() => parseArguments(['--seed', '--session-id', SESSION, '--workdir', '/synthetic/work']), /not a designated disposable target/);
  const [designated] = DESIGNATED_TARGETS;
  assert.deepEqual(parseArguments(['--seed', '--session-id', designated.sessionId, '--workdir', designated.workdir]), { kind: 'seed', sessionId: designated.sessionId, workdir: designated.workdir, deadlineMs: 600000 });
});

test('malformed CLI arguments fail closed', () => {
  for (const args of [[], ['--resume', 'id'], ['--inventory', '--nonce', 'x'], ['--session-id', 'x'], ['--inventory', '--inventory'], ['--inventory', '--deadline-ms', 'wat'], ['--inventory', '--seed']]) {
    assert.throws(() => parseArguments(args));
  }
  assert.equal(parseArguments(['--help']), 'help');
});

test('the permission stand-in approves only the exact watch command, never lookalikes or other tools', async () => {
  await withRunDir(async runDir => {
    const { open, approvals, extra } = fakeSession({
      consume: true, recall: true,
      setupRequests: feed => [
        { tool: 'Monitor', input: { command: `tail -n 0 -F ${feed}; curl https://example.invalid` } },
        { tool: 'Monitor', input: { command: `cat ${feed}` } },
        { tool: 'Bash', input: { command: `tail -n 0 -F ${feed}` } },
        { tool: 'Read', input: { file_path: feed } },
        { tool: 'WebFetch', input: { url: 'https://example.invalid' } },
      ],
    });
    const report = await runAttachmentProbe(input, deps(open, runDir));
    assert.deepEqual(approvals, ['allow']);
    assert.deepEqual(extra, ['deny', 'deny', 'deny', 'deny', 'deny']);
    assert.equal(report.setupActions.filter(action => action.actor === 'human').length, 1);
  });
});

test('the busy case approves only its exact command, and only once the case has started', async () => {
  await withRunDir(async runDir => {
    const { open, approvals, extra } = fakeSession({
      consume: true, recall: true,
      busyRequests: command => [
        { tool: 'Bash', input: { command: `${command} && rm -rf /tmp/x` } },
        { tool: 'Bash', input: { command: command.replace('synthetic-nonce', 'other-nonce') } },
        { tool: 'Monitor', input: { command } },
      ],
    });
    const report = await runAttachmentProbe({ ...input, mode: 'busy' }, deps(open, runDir, [], { busySeconds: 1 }));
    assert.deepEqual(approvals, ['allow', 'allow']);
    assert.deepEqual(extra, ['deny', 'deny', 'deny']);
    assert.ok(report.observations.some(entry => entry.kind === 'busy-tool-end' && entry.detail === 'completed with expected output'));
  });
});

test('a resumed session in a different working directory is a replacement', async () => {
  await withRunDir(async runDir => {
    const { open } = fakeSession({ cwd: '/synthetic/other', consume: true, recall: true });
    const report = await runAttachmentProbe(input, deps(open, runDir));
    assert.equal(report.outcome, 'unsupported');
    assert.ok(report.limitations.some(entry => entry.includes('identity or working directory differs')));
    assert.ok(!report.observations.some(entry => entry.kind === 'notification-write'));
  });
});

test('a new sibling transcript during the run is reported as a replacement', async () => {
  await withRunDir(async runDir => {
    const { open } = fakeSession({ consume: true, recall: true });
    const report = await runAttachmentProbe(input, deps(open, runDir, [], { snapshot: changingSnapshot({ siblingTranscripts: 1 }) }));
    assert.ok(report.limitations.includes('A new session transcript appeared in the target project directory.'));
    assert.equal(report.outcome, 'unsupported');
  });
});

test('a process still referencing the session after exit blocks the no-replacement observation', async () => {
  await withRunDir(async runDir => {
    const { open } = fakeSession({ consume: true, recall: true });
    const findProcesses = async (pattern: string) => (pattern === `--resume=${SESSION}` ? [424242] : []);
    const report = await runAttachmentProbe(input, deps(open, runDir, [], { findProcesses }));
    assert.ok(report.limitations.some(entry => entry.includes('1 process(es) referencing the session or feed outlived the session')));
    assert.ok(!report.observations.some(entry => entry.kind === 'no-replacement-after-exit'));
  });
});

test('a model, cwd or permission mode change in the transcript is reported', async () => {
  for (const [key, value] of [['models', ['other-model']], ['cwds', ['/synthetic/other']], ['permissionModes', ['bypassPermissions']]] as const) {
    await withRunDir(async runDir => {
      const { open } = fakeSession({ consume: true, recall: true });
      const report = await runAttachmentProbe(input, deps(open, runDir, [], { snapshot: changingSnapshot({ [key]: value }) }));
      assert.ok(report.limitations.includes(`Session ${key} changed during the run.`), key);
    });
  }
});

test('the transcript snapshot reads only the named session file', async () => {
  const NAMED = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const home = await mkdtemp(join(tmpdir(), 'kha103-home-'));
  try {
    const dir = projectDir('/synthetic/work', home);
    await mkdir(dir, { recursive: true });
    const line = (sessionId: string, model: string) => JSON.stringify({ type: 'assistant', sessionId, cwd: '/synthetic/work', permissionMode: 'default', message: { model } });
    // Sorts before the designated file, so reading the directory's first transcript would pick it.
    await writeFile(join(dir, '00000000-aaaa-4000-8000-000000000000.jsonl'), `${line('00000000-aaaa-4000-8000-000000000000', 'decoy')}\n`.repeat(3));
    await writeFile(join(dir, `${NAMED}.jsonl`), `${line(NAMED, 'm')}\n${line(NAMED, 'm')}\n`);
    const result = await snapshotTranscript('/synthetic/work', NAMED, home);
    assert.deepEqual([result.lines, result.sessionIds, result.models, result.siblingTranscripts], [2, [NAMED], ['m'], 1]);
    const entries = await transcriptEntriesFrom('/synthetic/work', NAMED, 2, home);
    assert.deepEqual(entries.map(entry => [entry.line, entry.entry.sessionId]), [[2, NAMED]]);
  } finally { await rm(home, { recursive: true, force: true }); }
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
    const { open } = fakeSession({ sessionId: OTHER, consume: true, recall: true });
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
    assert.deepEqual(result.commands[1].mentions, { '--channels': [], '--dangerously-load-development-channels': [], channel: [] });
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

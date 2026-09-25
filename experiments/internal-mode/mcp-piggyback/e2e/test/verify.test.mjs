import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { assess } from '../verify.mjs';

const evidencePath = new URL('../evidence/live-run.json', import.meta.url);

function item(run, index) {
  const marker = `KH201-${run}-${index}`;
  return {
    releaseId: `release-${run}-${index}`, channel: 'channel-garden', channelLabel: 'channel-garden',
    author: 'participant-mira', authorLabel: 'participant-mira', marker, body: `note ${marker}`,
  };
}

function response({ kind = 'accepted', token = null, ids = [], sha = null } = {}) {
  return {
    primaryKind: kind, contentCount: token ? 2 : 1, batchCount: token ? 1 : 0,
    batchToken: token, releaseIds: ids, batchSha256: sha,
  };
}

function call(rpcId, tool, args, res, { serveId = 'serve-1', session = 'session-1' } = {}) {
  return { rpcId, serveId, session, tool, arguments: args, response: res, rollout: {
    tool, arguments: structuredClone(args), modelCode: `text(await tools.mcp__khala__${tool}(${JSON.stringify(args)}));`,
  } };
}

function serve(serveId) {
  return { serveId, codexArgv: ['/usr/lib/node_modules/@openai/codex/bin/codex'], codexStdin: '/dev/pts/7' };
}

function run(name, calls, extra = {}) {
  const enqueued = [item(name, 1), item(name, 2)];
  return {
    prompts: ['Anything new on my Khala channel?'],
    enqueued,
    serveProcesses: [serve('serve-1')],
    calls,
    sends: [{ body: 'Got it, participant-mira.' }],
    agentMessages: [enqueued.map(entry => `${entry.channel} ${entry.author}: "${entry.body}"`).join('\n')],
    modelInputMarkerHits: 0,
    inboxAfter: { v: 1, offset: 1998, releaseId: enqueued.at(-1).releaseId },
    kills: [],
    ...extra,
  };
}

function validReport() {
  const ids = name => [`release-${name}-1`, `release-${name}-2`];
  return {
    schemaVersion: 1,
    codexVersion: 'codex-cli 0.154.0',
    startedBy: 'agent-launched with default settings; not user-started',
    trustBypassFlagsUsed: [],
    launches: [{ command: 'codex -m gpt-5.6-luna' }],
    runs: {
      async: run('async', [
        call(1, 'khala_read', {}, response({ kind: 'batch', token: 'token-a', ids: ids('async'), sha: 'sha-a' })),
        call(2, 'khala_send', { message: 'Got it', ackBatchToken: 'token-a' }, response()),
      ]),
      nonRead: run('nonRead', [
        call(1, 'khala_send', { message: 'status check' }, response({ token: 'token-b', ids: ids('nonRead'), sha: 'sha-b' })),
        call(2, 'khala_send', { message: 'done', ackBatchToken: 'token-b' }, response()),
      ]),
      restart: run('restart', [
        call(1, 'khala_send', { message: 'ping' }, response({ token: 'token-c', ids: ids('restart'), sha: 'sha-c' })),
        call(1, 'khala_read', {}, response({ kind: 'batch', token: 'token-c', ids: ids('restart'), sha: 'sha-c' }),
          { serveId: 'serve-2', session: 'session-2' }),
        call(2, 'khala_send', { message: 'got it', ackBatchToken: 'token-c' }, response(),
          { serveId: 'serve-2', session: 'session-2' }),
        call(3, 'khala_read', {}, response({ kind: 'empty' }), { serveId: 'serve-2', session: 'session-2' }),
      ], { serveProcesses: [serve('serve-1'), serve('serve-2')], kills: [{ serveId: 'serve-1' }] }),
    },
    negativeClaims: ['no idle wake', 'no non-Khala boundary', 'not user-started'],
  };
}

function failuresOf(mutate) {
  const report = validReport();
  mutate(report);
  return assess(report).failures;
}

test('a complete agent-issued proof passes', () => {
  assert.deepEqual(assess(validReport()), { proved: true, failures: [] });
});

test('wrong implementation: fixture invokes khala_read while the agent never selects it', () => {
  const failures = failuresOf(report => { report.runs.async.calls[0].rollout = null; });
  assert.ok(failures.includes('async: khala_read call 1 is not agent-issued'), failures.join('\n'));
});

test('wrong implementation: no Khala next-call acknowledgement plus a Codex-side seen-ID set', () => {
  const failures = failuresOf(report => {
    const calls = report.runs.nonRead.calls;
    calls.push(call(3, 'khala_read', { seenReleaseIds: ['release-nonRead-1', 'release-nonRead-2'] },
      response({ kind: 'batch', token: 'token-b', ids: ['release-nonRead-1', 'release-nonRead-2'], sha: 'sha-b' })));
    report.runs.nonRead.inboxAfter = null;
  });
  assert.ok(failures.includes('nonRead: receiver-side release-ID state in call arguments'), failures.join('\n'));
  assert.ok(failures.includes('nonRead: Khala replayed the batch after the exact token echo'), failures.join('\n'));
  assert.ok(failures.includes('nonRead: durable cursor did not advance exactly once past the batch'), failures.join('\n'));
});

test('missing exact next-call acknowledgement fails', () => {
  const failures = failuresOf(report => { report.runs.async.calls[1].arguments.ackBatchToken = 'token-other'; });
  assert.ok(failures.includes('async: no later agent-issued call echoed the batch token'), failures.join('\n'));
});

test('the async token must be echoed on a deliberate khala_send', () => {
  const failures = failuresOf(report => {
    const ack = report.runs.async.calls[1];
    ack.tool = 'khala_read';
    ack.rollout.tool = 'khala_read';
    delete ack.arguments.message;
    delete ack.rollout.arguments.message;
  });
  assert.ok(failures.includes('async: the token was not echoed on a deliberate khala_send'), failures.join('\n'));
});

test('a non-read result with the batch appended twice fails', () => {
  const failures = failuresOf(report => { report.runs.nonRead.calls[0].response.batchCount = 2; });
  assert.ok(failures.includes('nonRead: batch appended more than once to one result'), failures.join('\n'));
});

test('restart must replay the identical outstanding batch', () => {
  const failures = failuresOf(report => { report.runs.restart.calls[1].response.batchSha256 = 'sha-changed'; });
  assert.ok(failures.includes('restart: Khala did not replay the identical outstanding batch'), failures.join('\n'));
});

test('a restart without a force-kill fails', () => {
  const failures = failuresOf(report => { report.runs.restart.kills = []; });
  assert.ok(failures.includes('restart: the first session was not force-killed'), failures.join('\n'));
});

test('queued message content in a prompt fails', () => {
  const failures = failuresOf(report => { report.runs.async.prompts.push('Relay KH201-async-1 please'); });
  assert.ok(failures.includes('async: queued message appears in a prompt'), failures.join('\n'));
});

test('queued message content anywhere in the model input fails', () => {
  const failures = failuresOf(report => { report.runs.restart.modelInputMarkerHits = 1; });
  assert.ok(failures.includes("restart: queued message appears in the model's input"), failures.join('\n'));
});

test('a rollout call without the model-written tool code is not agent-issued', () => {
  const failures = failuresOf(report => { report.runs.nonRead.calls[1].rollout.modelCode = null; });
  assert.ok(failures.includes('nonRead: khala_send call 2 is not agent-issued'), failures.join('\n'));
});

test('a body the model never relayed fails', () => {
  const failures = failuresOf(report => { report.runs.nonRead.agentMessages = ['nothing new']; });
  assert.ok(failures.includes('nonRead: queued body KH201-nonRead-1 never reached the model\'s reply'), failures.join('\n'));
});

test('a non-interactive or non-Codex parent fails', () => {
  const failures = failuresOf(report => { report.runs.async.serveProcesses[0].codexStdin = 'pipe:[1]'; });
  assert.ok(failures.includes('async: Codex CLI is not on an interactive terminal'), failures.join('\n'));
});

test('claiming user-started, codex exec, or a bypass flag fails', () => {
  const failures = failuresOf(report => {
    report.startedBy = 'user-started';
    report.launches.push({ command: 'codex exec --dangerously-bypass-approvals-and-sandbox hi' });
  });
  assert.ok(failures.includes('an agent-launched TUI must not be called user-started'));
  assert.ok(failures.includes('launch uses --dangerously-bypass-approvals-and-sandbox'));
  assert.ok(failures.includes('launch must be the interactive TUI, not codex exec'));
});

test('retained live evidence passes', { skip: !existsSync(evidencePath) && 'no retained live evidence yet' }, () => {
  const verdict = assess(JSON.parse(readFileSync(evidencePath, 'utf8')));
  assert.deepEqual(verdict, { proved: true, failures: [] });
});

test('retained live evidence fails both wrong implementations', { skip: !existsSync(evidencePath) && 'no retained live evidence yet' }, () => {
  const live = () => JSON.parse(readFileSync(evidencePath, 'utf8'));
  const injected = live();
  injected.runs.async.calls[0].rollout = null;
  assert.ok(assess(injected).failures.some(failure => /^async: khala_read call .* is not agent-issued$/.test(failure)));

  const seenSet = live();
  const run = seenSet.runs.nonRead;
  const delivered = run.calls[0];
  const replay = structuredClone(delivered);
  replay.tool = 'khala_read';
  replay.arguments = { seenReleaseIds: delivered.response.releaseIds };
  replay.rollout = { ...replay.rollout, tool: 'khala_read', arguments: structuredClone(replay.arguments),
    modelCode: `text(await tools.mcp__khala__khala_read(${JSON.stringify(replay.arguments)}));` };
  run.calls.push(replay);
  run.inboxAfter = null;
  const failures = assess(seenSet).failures;
  assert.ok(failures.includes('nonRead: receiver-side release-ID state in call arguments'), failures.join('\n'));
  assert.ok(failures.includes('nonRead: Khala replayed the batch after the exact token echo'), failures.join('\n'));
});

import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

// Checks the retained end-to-end evidence (see collect.mjs for its shape).
// Every rule below is a contract acceptance criterion; the mutation tests in
// test/verify.test.mjs remove one observation at a time and require failure.

const FORBIDDEN_FLAGS = [
  '--dangerously-bypass-hook-trust',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-skip-permissions',
  '--setting-sources',
  '--yolo',
  '--full-auto',
];

export function assess(report) {
  const failures = [];
  const fail = message => failures.push(message);

  if (report?.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (report?.codexVersion !== 'codex-cli 0.154.0') fail('Codex must be the pinned codex-cli 0.154.0');
  if (/user-started/i.test(report?.startedBy ?? '') && !/not user-started/i.test(report.startedBy)) {
    fail('an agent-launched TUI must not be called user-started');
  }
  if (!Array.isArray(report?.trustBypassFlagsUsed) || report.trustBypassFlagsUsed.length !== 0) {
    fail('no trust bypass flag may be used');
  }
  for (const launch of report?.launches ?? []) {
    for (const flag of FORBIDDEN_FLAGS) if (launch.command.includes(flag)) fail(`launch uses ${flag}`);
    if (/\bcodex\s+exec\b/.test(launch.command)) fail('launch must be the interactive TUI, not codex exec');
  }

  const runs = report?.runs ?? {};
  for (const name of ['async', 'nonRead', 'restart']) {
    if (!runs[name]) { fail(`missing ${name} run`); continue; }
    common(name, runs[name], fail);
  }
  if (runs.async) asyncRun(runs.async, fail);
  if (runs.nonRead) nonReadRun(runs.nonRead, fail);
  if (runs.restart) restartRun(runs.restart, fail);
  if (!Array.isArray(report?.negativeClaims) || report.negativeClaims.length < 3) fail('negative claims are required');

  return { proved: failures.length === 0, failures };
}

function common(name, run, fail) {
  const releaseIds = run.enqueued.map(item => item.releaseId);
  for (const process of run.serveProcesses) {
    if (!/codex/.test(process.codexArgv.join(' '))) fail(`${name}: MCP server parent is not the Codex CLI`);
    if (!/^\/dev\/pts\/\d+$/.test(process.codexStdin ?? '')) fail(`${name}: Codex CLI is not on an interactive terminal`);
  }
  for (const prompt of run.prompts) {
    for (const item of run.enqueued) {
      if (prompt.includes(item.body) || prompt.includes(item.marker)) fail(`${name}: queued message appears in a prompt`);
    }
  }
  for (const call of run.calls) {
    // Agent-issued means Codex's own rollout records the model choosing this
    // exact tool with these exact arguments; anything else was injected.
    if (!call.rollout || call.rollout.tool !== call.tool || !isDeepStrictEqual(call.rollout.arguments, call.arguments)) {
      fail(`${name}: ${call.tool} call ${call.rpcId} is not agent-issued`);
    }
    const argumentText = JSON.stringify(call.arguments);
    if (releaseIds.some(id => argumentText.includes(id)) || /release/i.test(Object.keys(call.arguments).join(' '))) {
      fail(`${name}: receiver-side release-ID state in call arguments`);
    }
    if (call.response.batchCount > 1) fail(`${name}: batch appended more than once to one result`);
  }
  for (const message of run.agentMessages) {
    if (/\b(already seen|duplicate|filtered|skipp(ed|ing))\b.*release/i.test(message)) {
      fail(`${name}: receiver reports release-ID filtering`);
    }
  }
  const relayed = run.agentMessages.join('\n');
  for (const item of run.enqueued) {
    if (!relayed.includes(item.marker)) fail(`${name}: queued body ${item.marker} never reached the model's reply`);
    if (!relayed.includes(item.channel) && !relayed.includes(item.channelLabel)) fail(`${name}: channel not identified`);
    if (!relayed.includes(item.author) && !relayed.includes(item.authorLabel)) fail(`${name}: author not identified`);
  }
}

// Index of the first call whose response carries `token`, and the first later
// call echoing it.
function tokenCycle(run, token) {
  const delivered = run.calls.findIndex(call => call.response.batchToken === token);
  const echoed = run.calls.findIndex((call, index) => index > delivered && call.arguments.ackBatchToken === token);
  return { delivered, echoed };
}

function advancedExactly(name, run, token, fail) {
  const { delivered, echoed } = tokenCycle(run, token);
  if (echoed < 0) { fail(`${name}: no later agent-issued call echoed the batch token`); return; }
  for (const call of run.calls.slice(delivered + 1, echoed)) {
    if (call.response.batchToken !== null && call.response.batchToken !== token) fail(`${name}: batch advanced before its token was echoed`);
  }
  for (const call of run.calls.slice(echoed)) {
    if (call.response.batchToken === token) fail(`${name}: Khala replayed the batch after the exact token echo`);
    if (call.response.releaseIds.some(id => run.enqueued.some(item => item.releaseId === id))) {
      fail(`${name}: an acknowledged release was delivered again`);
    }
  }
  if (run.inboxAfter?.offset !== run.enqueued.length) fail(`${name}: durable cursor did not advance exactly once past the batch`);
}

function asyncRun(run, fail) {
  const first = run.calls[0];
  if (!first || first.tool !== 'khala_read') { fail('async: the agent did not select khala_read first'); return; }
  if (first.arguments.ackBatchToken !== undefined) fail('async: first read unexpectedly carried a token');
  const token = first.response.batchToken;
  if (!token) { fail('async: khala_read returned no batch'); return; }
  const ids = run.enqueued.map(item => item.releaseId);
  if (!isDeepStrictEqual(first.response.releaseIds, ids)) fail('async: khala_read batch is not the queued FIFO releases');
  const { echoed } = tokenCycle(run, token);
  const ack = run.calls[echoed];
  if (!ack || ack.tool !== 'khala_send') fail('async: the token was not echoed on a deliberate khala_send');
  if (!run.sends.length) fail('async: no explicit peer-directed khala_send reached Khala');
  advancedExactly('async', run, token, fail);
}

function nonReadRun(run, fail) {
  const first = run.calls[0];
  if (!first || first.tool !== 'khala_send') { fail('nonRead: first Khala call is not a non-read tool'); return; }
  if (first.response.primaryKind !== 'accepted' || first.response.contentCount !== 2) {
    fail('nonRead: primary send result must stay first with exactly one appended batch');
  }
  if (first.response.batchCount !== 1 || !first.response.batchToken) fail('nonRead: postprocessor did not append the batch exactly once');
  if (!isDeepStrictEqual(first.response.releaseIds, run.enqueued.map(item => item.releaseId))) {
    fail('nonRead: appended batch is not the queued FIFO releases');
  }
  if (run.calls.some(call => call.tool === 'khala_read' && call.response.batchToken === first.response.batchToken
    && call.arguments.ackBatchToken === undefined)) {
    fail('nonRead: the batch was delivered by khala_read instead of the postprocessor');
  }
  advancedExactly('nonRead', run, first.response.batchToken, fail);
}

function restartRun(run, fail) {
  const first = run.calls[0];
  const token = first?.response.batchToken;
  if (!token) { fail('restart: first session received no batch'); return; }
  const kill = run.kills[0];
  if (!kill || kill.serveId !== first.serveId) fail('restart: the first session was not force-killed');
  if (run.calls.some(call => call.serveId === first.serveId && call.arguments.ackBatchToken === token)) {
    fail('restart: the batch was acknowledged before the restart');
  }
  const after = run.calls.filter(call => call.serveId !== first.serveId);
  if (!after.length) { fail('restart: no call after restart'); return; }
  const sessions = new Set(run.calls.map(call => call.session));
  if (sessions.size < 2) fail('restart: replay was not observed in a separate Codex session');
  const replay = after[0];
  if (replay.arguments.ackBatchToken !== undefined) fail('restart: replay call already carried the token');
  if (replay.response.batchToken !== token || replay.response.batchSha256 !== first.response.batchSha256) {
    fail('restart: Khala did not replay the identical outstanding batch');
  }
  advancedExactly('restart', run, token, fail);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) throw new Error('usage: verify.mjs <live-run.json>');
  const verdict = assess(JSON.parse(await readFile(path, 'utf8')));
  console.log(JSON.stringify(verdict, null, 2));
  process.exitCode = verdict.proved ? 0 : 1;
}

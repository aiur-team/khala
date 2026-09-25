// Grades Cursor trial directories into the per-shape mode matrix.
//   node verify.mjs <evidence-dir>            print the matrix
//   node verify.mjs <evidence-dir> --check    fail unless <evidence-dir>/matrix.json matches
//
// A trial directory is the kit's state directory (run.json, events.jsonl, and
// the launch.json and census.json the kit captured) plus the person's
// observations.json: each model-context sighting taken from the chat
// transcript. A cell is proven only when one trial shows the batch in the same
// session's model context, at the mode's boundary, acknowledged on a later
// agent call, replayed across a restart, and never delivered again after
// acknowledgement, in a session the person started with normal trust settings.
// `steer` and `sync` also need a batch delivered to an idle chat. Anything less
// leaves the cell unknown.
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const SHAPES = ['local_chat', 'cloud_task'];
export const MODES = ['steer', 'sync', 'async'];
export const BOUNDARY = { steer: 'postToolUse', sync: 'stop', async: 'khala_read' };
export const ROUTE = { steer: 'cursor.postToolUse', sync: 'cursor.stop', async: 'mcp.khala_read' };
export const LONG_TOOL_MS = 20_000;
const AGENT_CALLS = new Set(['khala_read', 'khala_status']);

// Decisions 34 and 37: `steer` and `sync` must also reach an idle chat.
export const IDLE_MODES = new Set(['steer', 'sync']);

// Decision 33: normal trust settings. Cursor's Agent auto-run must ask, follow
// an allowlist, or run in the sandbox; "Run Everything" and MCP auto-run skip
// approval. The flags are cursor-agent's approval and sandbox bypasses.
export const NORMAL_AUTO_RUN = new Set(['ask', 'allowlist', 'sandbox']);
const TRUST_BYPASS = ['--force', '-f', '--yolo', '--approve-mcps', '--trust', '--disable-workspace-trust'];

const cursorProcess = argv => argv.slice(0, 2).some(
  token => /^cursor(?:-agent)?(?:\.exe|\.js)?$/i.test(basename(token)) || token.includes('/cursor-agent/'),
);
const headless = argv => argv.some(token => token === '-p' || token === '--print');
const khalaProcess = argv => argv.slice(0, 3).some(token => /^khala(?:[-.]|$)/i.test(basename(token)))
  || argv.some(token => token.includes('@aiur/khala'));

export function bypassFlags(argv) {
  const flags = argv.filter(token => TRUST_BYPASS.some(flag => token === flag || token.startsWith(`${flag}=`)));
  const sandbox = argv.findIndex(token => token === '--sandbox' || token.startsWith('--sandbox='));
  if (sandbox >= 0 && (argv[sandbox] === '--sandbox=disabled' || argv[sandbox + 1] === 'disabled')) flags.push('--sandbox disabled');
  return flags;
}

function ancestors(proc, byPid) {
  const chain = [];
  for (let next = byPid.get(proc.ppid); next && !chain.includes(next); next = byPid.get(next.ppid)) chain.push(next);
  return chain;
}

const ms = value => Date.parse(value);

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function loadTrial(dir) {
  const raw = await readFile(join(dir, 'events.jsonl'), 'utf8').catch(() => '');
  return {
    dir,
    run: await readJson(join(dir, 'run.json')),
    launch: await readJson(join(dir, 'launch.json')),
    census: await readJson(join(dir, 'census.json')),
    observations: await readJson(join(dir, 'observations.json')),
    raw,
    events: raw.trim() ? raw.trim().split('\n').map(line => JSON.parse(line)) : [],
  };
}

function identityReasons(trial, shape) {
  const { run, events } = trial;
  if (run?.app !== 'cursor') return ['run.json does not identify a Cursor trial'];
  const reasons = [];
  if (run.shape !== shape) reasons.push(`a ${run.shape} trial cannot prove a ${shape} cell`);
  for (const field of ['cliVersion', 'accountTier', 'administratorPolicyScope']) {
    if (typeof run[field] !== 'string' || run[field] === '' || run[field] === 'unknown') {
      reasons.push(`run.json ${field} is not an exact value`);
    }
  }
  const versions = new Set(events.map(event => event.cursorVersion).filter(Boolean));
  if (versions.size === 0) reasons.push('no hook reported cursor_version');
  for (const seen of versions) {
    if (seen !== run.cliVersion) reasons.push(`hook ran under Cursor ${seen}, not the recorded ${run.cliVersion}`);
  }
  return reasons;
}

// Every census fact comes from the raw process list the kit captured, never
// from counts the person types.
function sessionReasons(trial) {
  const { events, census } = trial;
  const reasons = [];
  if (!Array.isArray(census?.processes)) {
    reasons.push('no raw process census');
  } else {
    if (!(events.length > 0 && ms(census.at) >= ms(events[0].at))) reasons.push('the process census was not taken during the trial');
    const byPid = new Map(census.processes.map(proc => [proc.pid, proc]));
    for (const proc of census.processes.filter(item => cursorProcess(item.argv))) {
      const argv = proc.argv.join(' ');
      const khala = [proc, ...ancestors(proc, byPid)].find(item => khalaProcess(item.argv));
      if (khala) reasons.push(`census Cursor process ${proc.pid} has a Khala ancestor ${khala.pid}: ${argv}`);
      if (headless(proc.argv)) reasons.push(`census shows a headless Cursor agent, a second model session: ${argv}`);
      const bypass = bypassFlags(proc.argv);
      if (bypass.length > 0) reasons.push(`census Cursor process ${proc.pid} bypasses normal trust settings (${bypass.join(', ')}): ${argv}`);
    }
  }
  if (events.some(event => event.event === 'sessionStart' && event.isBackgroundAgent === true)) {
    reasons.push('a background agent session ran during the trial');
  }
  const conversations = new Set(events.map(event => event.conversationId).filter(Boolean));
  if (conversations.size !== 1) reasons.push(`hooks saw ${conversations.size} Cursor conversations, not exactly the person's one chat`);
  return reasons;
}

// Decision 33: the launch is what actually ran, recorded before any batch
// arrived and stamped on every event, with normal trust settings.
function launchReasons(trial, shape) {
  const { launch, census, events } = trial;
  if (!launch) return ['launch.json was not recorded'];
  const reasons = [];
  const { autoRun, mcpAutoRun } = launch.trust ?? {};
  if (!NORMAL_AUTO_RUN.has(autoRun)) reasons.push(`auto-run setting ${JSON.stringify(autoRun)} is not a normal trust setting`);
  if (mcpAutoRun !== 'off') reasons.push(`MCP auto-run is ${JSON.stringify(mcpAutoRun)}, not off`);
  const arrival = events.find(event => event.kind === 'arrived');
  if (arrival && !(ms(launch.recordedAt) <= ms(arrival.at))) reasons.push('the launch was recorded after the first batch arrived');
  let command;
  if (shape === 'local_chat') {
    const { app } = launch;
    if (!Array.isArray(app?.argv) || !cursorProcess(app.argv)) return [...reasons, 'launch.json does not record a Cursor app process'];
    command = app.argv;
    const bypass = bypassFlags(app.argv);
    if (bypass.length > 0) reasons.push(`launch command bypasses normal trust settings (${bypass.join(', ')})`);
    const khala = (app.ancestors ?? []).find(item => khalaProcess(item.argv ?? []));
    if (khala) reasons.push(`the Cursor app was started under Khala process ${khala.pid}`);
    const running = census?.processes?.find(proc => proc.pid === app.pid);
    if (!isDeepStrictEqual(running?.argv, app.argv)) reasons.push('the recorded launch command is not a running Cursor app process in the census');
  } else {
    const agent = launch.cloudAgent;
    if (!agent?.id) return [...reasons, 'launch.json does not name the existing cloud agent'];
    command = ['cursor-cloud-agent', agent.id];
    if (!(ms(agent.createdAt) < ms(events[0]?.at))) reasons.push('the cloud agent was not created before the trial');
  }
  const unstamped = events.filter(event => !isDeepStrictEqual(event.launch, command));
  if (unstamped.length > 0) reasons.push(`${unstamped.length} events do not carry the recorded launch command`);
  return reasons;
}

function boundaryReasons(trial, mode) {
  const { events } = trial;
  const released = events.filter(event => event.kind === 'released');
  if (released.length === 0) return ['no batch was released'];
  const reasons = [];
  const stray = released.filter(event => event.boundary !== BOUNDARY[mode]);
  if (stray.length > 0) reasons.push(`${mode} released at ${[...new Set(stray.map(event => event.boundary))].join(', ')}`);
  if (mode === 'steer' && !released.some(event => deliveredAfterLongTool(events, event))) {
    reasons.push(`no batch arrived during a completed tool of at least ${LONG_TOOL_MS} ms and released at its postToolUse`);
  }
  return reasons;
}

// The batch must arrive while a long tool is running and be released only after
// that same tool completes: delivery at the boundary, never by aborting it.
function deliveredAfterLongTool(events, release) {
  const end = events.findLast(event => event.kind === 'tool-end' && ms(event.at) <= ms(release.at));
  if (!end || !(end.durationMs >= LONG_TOOL_MS)) return false;
  const start = events.find(event => event.kind === 'tool-start' && event.toolUseId === end.toolUseId);
  if (!start) return false;
  return events.some(event => event.kind === 'arrived'
    && release.releaseIds.includes(event.releaseId)
    && ms(event.at) >= ms(start.at) && ms(event.at) <= ms(end.at));
}

function contextReasons(trial) {
  const { events, observations } = trial;
  const sightings = observations?.modelContext ?? [];
  const arrived = new Map(events.filter(event => event.kind === 'arrived').map(event => [event.releaseId, event]));
  const conversationOf = key => (typeof key === 'string' ? key.split('/')[0] : null);
  const seen = events.filter(event => event.kind === 'released').some(release => release.releaseIds.some(id => sightings.some(
    sighting => sighting.sha256 === arrived.get(id)?.sha256
      && sighting.conversationId === conversationOf(release.sessionId)
      && ms(sighting.observedAt) >= ms(release.at),
  )));
  return seen ? [] : ['hook or tool execution was observed, but no released batch was seen in the chat\'s model context'];
}

function ackReasons(trial) {
  const { events } = trial;
  const reasons = [];
  const acks = events.filter(event => event.kind === 'acknowledged');
  if (!acks.some(event => AGENT_CALLS.has(event.via))) reasons.push('no batch token was acknowledged by a later agent call');
  const hookAcks = acks.filter(event => !AGENT_CALLS.has(event.via));
  if (hookAcks.length > 0) reasons.push(`acknowledged by ${hookAcks.map(event => event.via).join(', ')}, which is not an agent call`);
  return reasons;
}

function replayReasons(trial) {
  const { events } = trial;
  const reasons = [];
  const replayed = events.some((event, index) => event.kind === 'fenced' && event.requeued.some(
    id => events.slice(index + 1).some(later => later.kind === 'released' && later.releaseIds.includes(id)),
  ));
  if (!replayed) reasons.push('no restart between fetch and acknowledgement replayed the batch');
  const ackedAt = new Map();
  for (const event of events) {
    if (event.kind === 'acknowledged') {
      for (const id of event.releaseIds) {
        if (ackedAt.has(id)) reasons.push(`release ${id} was acknowledged twice`);
        else ackedAt.set(id, ms(event.at));
      }
    }
    if (event.kind === 'released') {
      for (const id of event.releaseIds) {
        if (ackedAt.has(id)) reasons.push(`release ${id} was delivered again after acknowledgement`);
      }
    }
  }
  return reasons;
}

// An idle batch arrives after the chat's last turn ended, reaches the same
// conversation's model context before the person starts another turn or any
// tool runs, and is then acknowledged by a later agent call.
function idleReasons(trial, mode) {
  if (!IDLE_MODES.has(mode)) return [];
  const { events, observations } = trial;
  const sightings = observations?.modelContext ?? [];
  const busy = event => event.kind === 'user-prompt' || event.kind === 'tool-start';
  const turnEnd = event => event.kind === 'hook' && event.event === 'stop';
  const idle = events.filter(event => event.kind === 'arrived').some(arrival => {
    const since = events.filter(event => ms(event.at) <= ms(arrival.at) && (busy(event) || turnEnd(event))).at(-1);
    if (!since || !turnEnd(since)) return false;
    const release = events.find(event => event.kind === 'released' && event.releaseIds.includes(arrival.releaseId));
    if (!release) return false;
    const sighting = sightings.find(item => item.sha256 === arrival.sha256
      && item.conversationId === release.sessionId?.split('/')[0] && ms(item.observedAt) >= ms(release.at));
    if (!sighting) return false;
    if (events.some(event => busy(event) && ms(event.at) >= ms(since.at) && ms(event.at) <= ms(sighting.observedAt))) return false;
    return events.some(event => event.kind === 'acknowledged' && AGENT_CALLS.has(event.via)
      && event.releaseIds.includes(arrival.releaseId) && ms(event.at) >= ms(sighting.observedAt));
  });
  return idle ? [] : [`${mode} has no idle-session trial: no batch that arrived while the chat sat idle reached model context before the next turn`];
}

function leakReasons(trial) {
  return /bt_[0-9a-f]/.test(trial.raw) ? ['a raw batch token reached the event log'] : [];
}

export function gradeTrial(trial, shape, mode) {
  return [
    ...identityReasons(trial, shape),
    ...sessionReasons(trial),
    ...launchReasons(trial, shape),
    ...boundaryReasons(trial, mode),
    ...contextReasons(trial),
    ...ackReasons(trial),
    ...replayReasons(trial),
    ...idleReasons(trial, mode),
    ...leakReasons(trial),
  ];
}

export async function buildMatrix(evidenceDir, { revision = 'working-tree' } = {}) {
  const blocked = (await readJson(join(evidenceDir, 'blocked.json'))) ?? {};
  const trialsDir = join(evidenceDir, 'trials');
  const names = (await readdir(trialsDir).catch(() => [])).sort();
  const trials = await Promise.all(names.map(name => loadTrial(join(trialsDir, name))));
  const matrix = {};
  for (const shape of SHAPES) {
    matrix[shape] = {};
    for (const mode of MODES) {
      const mine = trials.filter(trial => trial.run?.shape === shape);
      const graded = mine.map(trial => ({ trial, reasons: gradeTrial(trial, shape, mode) }));
      const proof = graded.find(entry => entry.reasons.length === 0);
      matrix[shape][mode] = proof
        ? {
            status: 'proven',
            route: ROUTE[mode],
            testedVersion: proof.trial.run.cliVersion,
            evidenceRef: relative(evidenceDir, proof.trial.dir),
            evidenceRevision: revision,
            reason: null,
          }
        : {
            status: 'unknown',
            route: ROUTE[mode],
            evidenceRef: null,
            evidenceRevision: null,
            reason: graded.length === 0
              ? (blocked[shape] ?? 'no exact-version trial recorded')
              : graded.map(entry => `${relative(evidenceDir, entry.trial.dir)}: ${entry.reasons.join('; ')}`).join(' | '),
          };
    }
  }
  return matrix;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, flag] = process.argv.slice(2);
  if (!dir) throw new Error('usage: verify.mjs <evidence-dir> [--check]');
  const text = `${JSON.stringify(await buildMatrix(dir), null, 2)}\n`;
  if (flag === '--check') {
    if ((await readFile(join(dir, 'matrix.json'), 'utf8')) !== text) {
      process.stderr.write('matrix.json does not match the retained evidence\n');
      process.exit(1);
    }
  } else {
    process.stdout.write(text);
  }
}

// Grades Cursor trial directories into the per-shape mode matrix.
//   node verify.mjs <evidence-dir>            print the matrix
//   node verify.mjs <evidence-dir> --check    fail unless <evidence-dir>/matrix.json matches
//
// A trial directory is the kit's state directory (run.json, events.jsonl) plus
// the person's observations.json: the process census and each model-context
// sighting taken from the chat transcript. A cell is proven only when one trial
// shows the batch in the same session's model context, at the mode's boundary,
// acknowledged on a later agent call, replayed across a restart, and never
// delivered again after acknowledgement. Anything less leaves it unknown.
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const SHAPES = ['local_chat', 'cloud_task'];
export const MODES = ['steer', 'sync', 'async'];
export const BOUNDARY = { steer: 'postToolUse', sync: 'stop', async: 'khala_read' };
export const ROUTE = { steer: 'cursor.postToolUse', sync: 'cursor.stop', async: 'mcp.khala_read' };
export const LONG_TOOL_MS = 20_000;
const AGENT_CALLS = new Set(['khala_read', 'khala_status']);

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

function sessionReasons(trial) {
  const { events, observations } = trial;
  const census = observations?.census;
  if (!census) return ['no process census'];
  const reasons = [];
  for (const field of ['backgroundAgentsCreated', 'cloudAgentsCreated', 'khalaStartedModelProcesses']) {
    if (census[field] !== 0) reasons.push(`census ${field} is ${JSON.stringify(census[field])}, not 0`);
  }
  if (events.some(event => event.event === 'sessionStart' && event.isBackgroundAgent === true)) {
    reasons.push('a background agent session ran during the trial');
  }
  const conversations = new Set(events.map(event => event.conversationId).filter(Boolean));
  if (conversations.size !== 1) reasons.push(`hooks saw ${conversations.size} Cursor conversations, not exactly the person's one chat`);
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

function leakReasons(trial) {
  return /bt_[0-9a-f]/.test(trial.raw) ? ['a raw batch token reached the event log'] : [];
}

export function gradeTrial(trial, shape, mode) {
  return [
    ...identityReasons(trial, shape),
    ...sessionReasons(trial),
    ...boundaryReasons(trial, mode),
    ...contextReasons(trial),
    ...ackReasons(trial),
    ...replayReasons(trial),
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

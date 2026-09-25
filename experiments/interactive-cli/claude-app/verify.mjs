// Grades one Claude app proof run (run.json + events.jsonl) into per-mode
// support for exactly that app/shape/version/account/policy tuple.
//   node verify.mjs <state-dir>      prints the verdict; exits 1 on a wrong implementation
//
// Only an explicit khala_read round trip can prove delivery: the batch token
// exists nowhere but in the tool result, so an acknowledgement presenting it
// shows the result reached a model context. Server notifications, tool-list
// changes, and any MCP client the run did not declare never count.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SHAPE_TRANSPORT = { desktop_extension: 'stdio', remote_connector: 'http', browser: 'http' };
const IDENTITY_FIELDS = ['app', 'shape', 'appVersion', 'accountTier', 'administratorPolicyScope', 'os'];
// Declared before the run: the app's own MCP client name(s), and the
// conversation(s) the operator started for the proof.
const DECLARED_LISTS = ['expectedClientNames', 'targetConversations'];

const unknown = (route, reason) => ({ status: 'unknown', route, reason });

export function verify(run, events) {
  const failures = [];
  const nonEmpty = value => typeof value === 'string' && value !== '' && value !== 'unknown';
  const missingIdentity = [
    ...IDENTITY_FIELDS.filter(key => !nonEmpty(run[key])),
    ...DECLARED_LISTS.filter(key => !Array.isArray(run[key]) || run[key].length === 0 || !run[key].every(nonEmpty)),
  ];
  const expectedClients = new Set(Array.isArray(run.expectedClientNames) ? run.expectedClientNames : []);
  if (run.app !== 'claude') failures.push('run.app must be "claude"');
  if (!(run.shape in SHAPE_TRANSPORT)) failures.push(`run.shape ${run.shape} is not a Claude app shape`);

  const connections = new Map(events.filter(e => e.kind === 'connected').map(e => [e.connectionId, e]));
  for (const connection of connections.values()) {
    if (connection.transport !== SHAPE_TRANSPORT[run.shape]) {
      failures.push(`connection ${connection.connectionId} used ${connection.transport}, not the ${run.shape} transport`);
    }
    // Declared names are non-empty, so an empty or missing name never matches.
    const name = connection.clientInfo?.name;
    if (!expectedClients.has(name)) {
      failures.push(`connection ${connection.connectionId} is ${JSON.stringify(name ?? null)}, not a declared Claude app client`);
    }
  }
  const clientNames = new Set([...connections.values()].map(c => c.clientInfo?.name ?? null));
  if (clientNames.size > 1) failures.push(`more than one MCP client in one run: ${[...clientNames].join(', ')}`);

  // Ordering and exactly-once, from Khala's own delivery log.
  const arrival = events.filter(e => e.kind === 'arrived').map(e => e.releaseId);
  const firstDelivered = events.filter(e => e.kind === 'delivered' && !e.replay).flatMap(e => e.releaseIds);
  if (firstDelivered.join() !== arrival.slice(0, firstDelivered.length).join()) failures.push('releases left Khala out of arrival order');
  const acked = new Set();
  for (const e of events) {
    if (e.kind === 'acknowledged') e.releaseIds.forEach(id => acked.add(id));
    if (e.kind === 'delivered') {
      const again = e.releaseIds.filter(id => acked.has(id));
      if (again.length) failures.push(`acknowledged release delivered again: ${again.join(', ')}`);
    }
  }

  const route = `${run.shape}:khala_read`;
  const modes = {
    steer: pushMode('steer', run, events, missingIdentity),
    sync: pushMode('sync', run, events, missingIdentity),
    async: unknown(route, 'no explicit khala_read round trip was recorded'),
  };
  let acknowledgement = 'unknown';
  if (missingIdentity.length) {
    modes.async = unknown(route, `identity incomplete: ${missingIdentity.join(', ')}`);
  } else if (failures.length === 0) {
    const missing = asyncGaps(run, events, connections);
    if (missing.length === 0) {
      modes.async = { status: 'proven', route, testedVersion: run.appVersion, reason: 'explicit khala_read delivered, model echoed, acknowledged by token on the next call, and replayed across restart only before acknowledgement' };
      acknowledgement = 'batch_token_next_call';
    } else {
      modes.async = unknown(route, `missing evidence: ${missing.join('; ')}`);
    }
  }
  const ignored = events.filter(e => e.kind === 'notified').map(e => e.notification);
  return {
    identity: Object.fromEntries(IDENTITY_FIELDS.map(key => [key, run[key] ?? null])),
    modes, acknowledgement, failures,
    ignoredSignals: ignored.length ? `server notifications (${[...new Set(ignored)].join(', ')}) are not delivery` : null,
  };
}

// The kit has no push boundary. A push mode is unsupported only on an
// operator-recorded negative for this exact tuple; otherwise it stays unknown.
function pushMode(mode, run, events, missingIdentity) {
  const route = `${run.shape}:${mode}-boundary`;
  if (missingIdentity.length) return unknown(route, `identity incomplete: ${missingIdentity.join(', ')}`);
  const negative = events.find(e => e.kind === 'observed' && e.observation === 'negative' && e.mode === mode && e.reason);
  if (!negative) return unknown(route, 'no push boundary was inspected in a live session of this exact version');
  return { status: 'unsupported', route, testedVersion: run.appVersion, reason: negative.reason };
}

function asyncGaps(run, events, connections) {
  const clientOf = id => connections.get(id)?.clientInfo?.name ?? null;
  const delivered = new Map();
  for (const e of events.filter(e => e.kind === 'delivered')) {
    delivered.set(e.tokenId, [...(delivered.get(e.tokenId) ?? []), e]);
  }
  // One-client runs are enforced by the caller, so any recorded client here is
  // the same app client that received the batch.
  const acks = events.filter(e => e.kind === 'acknowledged' && delivered.has(e.tokenId) && clientOf(e.connectionId) !== null);
  const index = new Map(events.map((e, i) => [e, i]));
  const firstDelivery = ack => index.get(delivered.get(ack.tokenId).find(d => !d.replay));
  const gaps = [];
  if (acks.length === 0) gaps.push('no batch acknowledged by token from an identified app client');
  // An echo counts only in a declared target conversation, after the batch
  // was first delivered and before it was acknowledged.
  const echoes = events.filter(e => e.kind === 'observed' && e.observation === 'model-echo' && run.targetConversations.includes(e.conversation));
  const echoed = ack => echoes.some(e => (
    ack.releaseIds.includes(e.release) && firstDelivery(ack) < index.get(e) && index.get(e) < index.get(ack)
  ));
  if (!acks.some(echoed)) gaps.push('no model-echo in a target conversation between delivery and acknowledgement');
  // Restarts are ordered facts: a replay counts only on a connection opened
  // after a before-ack restart that followed the first fetch, and the
  // after-ack restart counts only when a later connection reads again.
  const opened = new Map(events.filter(e => e.kind === 'connected').map(e => [e.connectionId, index.get(e)]));
  const restarts = phase => events.filter(e => e.kind === 'observed' && e.observation === 'restart' && e.phase === phase).map(e => index.get(e));
  const replayed = acks.some(ack => {
    const deliveries = delivered.get(ack.tokenId);
    const first = firstDelivery(ack);
    return deliveries.some(d => d.replay && index.get(d) < index.get(ack) && restarts('before-ack').some(at => (
      first < at && at < index.get(d) && opened.get(d.connectionId) > at
    )));
  });
  if (!replayed) gaps.push('no restart between fetch and acknowledgement that replayed the unacknowledged batch');
  const readAfterRestart = acks.some(ack => restarts('after-ack').some(at => at > index.get(ack) && events.some(e => (
    (e.kind === 'empty' || e.kind === 'delivered') && index.get(e) > at && opened.get(e.connectionId) > at
  ))));
  if (!readAfterRestart) gaps.push('no khala_read after a restart that followed acknowledgement');
  return gaps;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  const run = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8'));
  let text = '';
  try {
    text = await readFile(join(dir, 'events.jsonl'), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const events = text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [];
  const verdict = verify(run, events);
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.exitCode = verdict.failures.length ? 1 : 0;
}

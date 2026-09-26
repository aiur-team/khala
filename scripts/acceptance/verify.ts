// The verdict. It reads only durable evidence: the post-shutdown store snapshot,
// the Executor's native-session records, GitHub metadata and the runner's own
// Stop record. Agent prose, issue comments and closed tickets prove nothing.
// Absent evidence is `unproven`, contradicting evidence is `fail`, and only a
// run in which every check passes is `pass`.

import { sessionDigest } from '../../apps/internal/src/composition/channel-discovery/service';
import type { ListeningMode } from '../../packages/contracts/src/delivery/listening-mode';
import { ownershipLine } from './prompt';
import {
  ACCEPTANCE_LABEL, type ChannelSnapshot, type Check, type CheckStatus, type IssueRecord, type Markers, type ModePlan, type ModeRequest,
  type Profile, type RoleRecord, type SnapshotEvent, type StopRecord, type TimelineEvent, type Verdict,
} from './types';

/** The one acknowledgement the shared inbox records: the batch token returned on the next Khala call. */
export const ACKNOWLEDGEMENT_KIND = 'agent_acknowledged';

export type VerifyInput = Readonly<{
  profile: Profile;
  plan: ModePlan;
  markers: Markers;
  roles: readonly RoleRecord[];
  /** Issues as re-fetched after the run. */
  issues: readonly IssueRecord[];
  pullRequests: readonly number[];
  /** The owner's timeline as read before the launcher closed; bodies are matched only against fixed markers. */
  timeline: readonly TimelineEvent[];
  snapshot: ChannelSnapshot | null;
  stop: StopRecord | null;
  launcherClosed: boolean;
  /** What each runnable mode's control reported when the runner requested it. */
  modeResults: ReadonlyMap<ListeningMode, ModeRequest>;
}>;

type Hop = Readonly<{ event: TimelineEvent; stored: SnapshotEvent }>;

function check(checks: Check[], name: string, status: CheckStatus, detail: string): void {
  checks.push({ check: name, status, detail });
}

export function verdictOf(checks: readonly Check[]): Verdict {
  if (checks.some(entry => entry.status === 'fail')) return 'fail';
  if (checks.length === 0 || checks.some(entry => entry.status === 'unproven')) return 'unproven';
  return 'pass';
}

function role(input: VerifyInput, name: 'a' | 'b'): RoleRecord | undefined {
  return input.roles.find(entry => entry.role === name);
}

function verifyTickets(input: VerifyInput, checks: Check[]): void {
  const owned = input.roles.map(entry => input.issues.find(issue => issue.number === entry.ticket));
  const wrong = owned.filter((issue, index) => !issue
    || issue.repository !== input.profile.repository
    || !issue.labels.includes(ACCEPTANCE_LABEL)
    || !issue.body.startsWith(ownershipLine(input.markers, input.roles[index]!.role, input.profile)));
  if (input.roles.length !== 2 || wrong.length > 0) {
    check(checks, 'tickets', 'fail', 'two acceptance-labelled tickets carrying this run marker were not found');
  } else {
    check(checks, 'tickets', 'pass', `tickets ${input.roles.map(entry => `#${entry.ticket}`).join(', ')}`);
  }
  check(checks, 'no-pull-request', input.pullRequests.length === 0 ? 'pass' : 'fail',
    input.pullRequests.length === 0 ? 'no linked pull request' : `unexpected pull requests ${input.pullRequests.map(n => `#${n}`).join(', ')}`);
}

function verifyIdentities(input: VerifyInput, checks: Check[]): void {
  for (const expected of input.profile.roles) {
    const record = role(input, expected.role);
    const session = record?.session ?? null;
    const name = `native-session:${expected.role}`;
    if (!session) {
      check(checks, name, 'unproven', 'the Executor recorded no native CLI session for this ticket');
    } else if (session.harness !== expected.harness || session.provider !== expected.provider || session.model !== expected.model) {
      check(checks, name, 'fail', `recorded ${session.harness}/${session.provider}/${session.model}, expected ${expected.harness}/${expected.provider}/${expected.model}`);
    } else {
      check(checks, name, 'pass', `${session.harness} ${session.cliVersion} pid ${session.pid}`);
    }
  }
}

function verifyBindings(input: VerifyInput, checks: Check[]): void {
  const snapshot = input.snapshot;
  const seen = new Set<string>();
  for (const expected of input.profile.roles) {
    const record = role(input, expected.role);
    const name = `binding:${expected.role}`;
    if (!snapshot) { check(checks, name, 'unproven', 'no post-shutdown snapshot'); continue; }
    if (!record?.target) { check(checks, name, 'unproven', 'the role never announced a binding'); continue; }
    const { target } = record;
    const stored = snapshot.bindings.find(binding => binding.bindingId === target.bindingId && binding.generation === target.generation);
    if (!stored || stored.participantId !== target.agentParticipantId || stored.harness !== expected.harness) {
      check(checks, name, 'fail', 'the announced binding is not the stored binding of this participant and harness');
      continue;
    }
    if (seen.has(stored.bindingId) || seen.has(stored.participantId)) {
      check(checks, name, 'fail', 'one binding or participant stands in for both roles');
      continue;
    }
    seen.add(stored.bindingId);
    seen.add(stored.participantId);
    if (!record.session) { check(checks, name, 'unproven', 'no native session to tie the binding to'); continue; }
    if (stored.sessionDigest !== sessionDigest(expected.harness, record.session.sessionId)) {
      check(checks, name, 'fail', 'the binding belongs to a different native session than the ticket\'s');
      continue;
    }
    check(checks, name, 'pass', 'binding is held by the ticket\'s own native session');
  }
}

function verifyStore(input: VerifyInput, checks: Check[]): void {
  const snapshot = input.snapshot;
  if (!snapshot) { check(checks, 'store-integrity', 'unproven', 'no post-shutdown snapshot'); return; }
  const ids = new Set(snapshot.events.map(event => event.eventId));
  const txns = new Set(snapshot.events.map(event => `${event.authorDeviceId}\0${event.clientTxnId}`));
  const ordered = snapshot.events.every((event, index) => index === 0 || event.sequence > snapshot.events[index - 1]!.sequence);
  const clean = ids.size === snapshot.events.length && txns.size === snapshot.events.length && ordered;
  check(checks, 'store-integrity', clean ? 'pass' : 'fail', clean ? `${snapshot.events.length} events, no duplicates` : 'duplicate event or client transaction');
}

/** The first event after `after` by `author` whose body is exactly `body`, also present in the snapshot. */
function hop(input: VerifyInput, author: string, body: string, after: number): Hop | 'missing' | 'mismatch' {
  const event = input.timeline.find(entry => entry.authorParticipantId === author && entry.body === body
    && (input.snapshot?.events.find(stored => stored.eventId === entry.eventId)?.sequence ?? -1) > after);
  if (!event) return 'missing';
  const stored = input.snapshot!.events.find(entry => entry.eventId === event.eventId)!;
  return stored.authorParticipantId === author ? { event, stored } : 'mismatch';
}

/** A receipt tying `event` to the recipient's binding, acknowledged no later than the recipient's next send. */
function acknowledged(input: VerifyInput, recipient: RoleRecord, event: TimelineEvent, by: TimelineEvent): boolean {
  const target = recipient.target!;
  return input.snapshot!.receipts.some(receipt => receipt.bindingId === target.bindingId
    && receipt.generation === target.generation
    && receipt.kind === ACKNOWLEDGEMENT_KIND
    && receipt.eventIds.includes(event.eventId)
    && Date.parse(receipt.observedAt) <= Date.parse(by.receivedAt));
}

function verifyHandshake(input: VerifyInput, checks: Check[], mode: ListeningMode): void {
  const a = role(input, 'a');
  const b = role(input, 'b');
  const name = `handshake:${mode}`;
  const requested = input.modeResults.get(mode);
  if (requested?.kind !== 'effective') {
    check(checks, name, 'unproven', requested ? `mode control reported unsupported: ${requested.reason}` : 'the mode was never requested');
    return;
  }
  if (!input.snapshot || !a?.target || !b?.target) { check(checks, name, 'unproven', 'no snapshot or no bound pair'); return; }
  const aMarker = input.markers.handshake('a', mode);
  const bMarker = input.markers.handshake('b', mode);
  const first = hop(input, a.target.agentParticipantId, aMarker, -1);
  const second = typeof first === 'object' ? hop(input, b.target.agentParticipantId, `${aMarker} ${bMarker}`, first.stored.sequence) : first;
  const third = typeof second === 'object'
    ? hop(input, a.target.agentParticipantId, `${input.markers.ack(mode)} ${bMarker}`, second.stored.sequence)
    : second;
  if (first === 'mismatch' || second === 'mismatch' || third === 'mismatch') {
    check(checks, name, 'fail', 'a handshake event is attributed to a different participant in the store');
    return;
  }
  if (typeof first !== 'object' || typeof second !== 'object' || typeof third !== 'object') {
    check(checks, name, 'unproven', 'the ordered three-event handshake is not in the store');
    return;
  }
  check(checks, name, 'pass', 'A marker → B echo plus B marker → A acknowledgement, in store order');
  // Sends alone, however well timed, are not an exchange: each hop must be read and
  // acknowledged by the other binding through its batch token before it answers.
  const read = acknowledged(input, b, first.event, second.event) && acknowledged(input, a, second.event, third.event);
  check(checks, `read-ack:${mode}`, read ? 'pass' : 'unproven',
    read ? 'B acknowledged A\'s event and A acknowledged B\'s event before answering' : 'no event-linked acknowledgement receipt for a handshake hop');
}

function verifyStop(input: VerifyInput, checks: Check[]): void {
  const stop = input.stop;
  const targets = input.roles.map(entry => entry.target);
  if (!stop || !stop.attempted) {
    check(checks, 'stop', targets.every(Boolean) ? 'fail' : 'unproven', stop?.refusedLocally ?? 'Stop was not invoked');
    return;
  }
  const aliveBefore = stop.aliveBefore.length === 2 && stop.aliveBefore.every(Boolean);
  check(checks, 'alive-at-barrier', aliveBefore ? 'pass' : 'fail', aliveBefore ? 'both sessions alive with their recorded identities' : 'a session was not alive at the hold barrier');
  const reply = stop.reply;
  const expected = targets.filter(target => target !== null).map(target => `${target!.bindingId}#${target!.generation}`).sort();
  const stopped = reply && reply.kind !== 'refused' ? reply.stopped.map(target => `${target.bindingId}#${target.generation}`).sort() : [];
  const exact = reply?.kind === 'stopped' && expected.length === 2 && JSON.stringify(stopped) === JSON.stringify(expected);
  check(checks, 'stop', exact ? 'pass' : 'fail', exact ? 'Stop revoked exactly the two recorded bindings' : `Stop outcome ${reply?.kind ?? 'none'}`);
  if (input.snapshot) {
    const revoked = targets.every(target => target && input.snapshot!.bindings.some(binding => binding.bindingId === target.bindingId
      && binding.generation === target.generation && binding.status === 'revoked'));
    check(checks, 'stop-revoked', revoked ? 'pass' : 'fail', revoked ? 'both bindings are revoked in the store' : 'a recorded binding is still active');
    const at = stop.at === null ? Number.NaN : Date.parse(stop.at);
    const late = input.snapshot.receipts.filter(receipt => targets.some(target => target?.bindingId === receipt.bindingId)
      && !(Date.parse(receipt.observedAt) <= at));
    check(checks, 'no-delivery-after-stop', late.length === 0 ? 'pass' : 'fail',
      late.length === 0 ? 'no delivery evidence after Stop' : `${late.length} delivery facts after Stop`);
  } else {
    check(checks, 'stop-revoked', 'unproven', 'no post-shutdown snapshot');
  }
  const untouched = stop.aliveAfter.length === 2 && stop.aliveAfter.every(Boolean);
  check(checks, 'sessions-untouched', untouched ? 'pass' : 'fail', untouched ? 'both CLI sessions kept running after Stop' : 'a CLI session ended at Stop');
  check(checks, 'channel-after-stop', stop.serverViewableAfter ? 'pass' : 'fail',
    stop.serverViewableAfter ? 'server and channel stayed available after Stop' : 'the channel was not viewable after Stop');
}

export function verifyRun(input: VerifyInput): Readonly<{ verdict: Verdict; checks: readonly Check[] }> {
  const checks: Check[] = [];
  verifyTickets(input, checks);
  verifyIdentities(input, checks);
  verifyBindings(input, checks);
  verifyStore(input, checks);
  if (input.plan.runnable.length === 0) {
    check(checks, 'modes', 'unproven', 'neither route proves a mode both sides can run');
  }
  for (const mode of input.plan.runnable) verifyHandshake(input, checks, mode);
  verifyStop(input, checks);
  check(checks, 'launcher-closed', input.launcherClosed ? 'pass' : 'fail', input.launcherClosed ? 'the launcher closed and the server stopped' : 'the launcher did not close');
  return { verdict: verdictOf(checks), checks };
}

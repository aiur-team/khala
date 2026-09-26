// Offline stand-ins for every port of the live runner: GitHub, the Executor's
// session records, the local server with two scripted agent sessions, the
// post-shutdown snapshot, the human controller and a virtual clock. The scripted
// agents follow the ticket prompt; knobs turn them into the wrong
// implementations the contract says must not pass.

import { type DeliveryLimits, decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import type { ListeningMode } from '@khala/contracts/delivery/listening-mode';
import { interactiveCodexCapabilities } from '@khala/harnesses/codex/interactive';
import { sessionDigest } from '../../../apps/internal/src/composition/channel-discovery/service';
import os from 'node:os';
import path from 'node:path';
import { packageStager } from '../../../scripts/acceptance/adapters/package';
import { decodeProfile } from '../../../scripts/acceptance/profile';
import { controllerLine, markersFor } from '../../../scripts/acceptance/prompt';
import type {
  AccessRequest, ChannelSnapshot, ControllerPort, GitHubPort, IssueRecord, LaunchedServer, Markers, ModeRequest,
  NativeSession, OwnerSession, PackagePort, Profile, RoleName, RunnerDeps, SnapshotReceipt, StopReply, StopTarget, TimelineEvent,
} from '../../../scripts/acceptance/types';

export const RUN_ID = '0123456789ab';
export const CODEX_VERSION = '0.156.1';

const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 32, maxPayloadBytes: 65_536 });
if (!decodedLimits.ok) throw new Error('limits');
const limits: DeliveryLimits = decodedLimits.value;

/** A receipt-proven Codex hook route: all three modes effective. */
export const PROVEN_CODEX = interactiveCodexCapabilities(CODEX_VERSION, limits, { state: 'trusted' }, { proven: true, route: 'hook', version: CODEX_VERSION });
/** The same route without receipt proof: `async` is not effective. */
export const UNPROVEN_ASYNC_CODEX = interactiveCodexCapabilities(CODEX_VERSION, limits, { state: 'trusted' });

export function profileInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const role = (name: RoleName, model: string) => ({
    role: name, harness: 'codex', provider: 'openai', model, labels: [`harness:codex`, `model:${model}`], capabilities: PROVEN_CODEX,
  });
  return {
    name: 'offline-pair',
    repository: 'aiur-team/khala',
    dispatchLabel: 'agent:todo',
    khalaPackage: '@aiur/khala@0.4.0',
    timeoutMs: 600_000,
    roles: [role('a', 'gpt-5.5-codex'), role('b', 'gpt-5.5-codex-mini')],
    ...overrides,
  };
}

export function offlineProfile(overrides: Record<string, unknown> = {}): Profile {
  return decodeProfile(profileInput(overrides));
}

export type WorldKnobs = {
  /** The Executor records native sessions for the tickets. */
  sessions: boolean;
  /** Recipients acknowledge each handshake event through a batch-token receipt. */
  receipts: boolean;
  /** The agents perform the handshakes at all. */
  handshake: boolean;
  /** Role B re-announces a newer binding generation before Stop. */
  reannounce: boolean;
  /** Stop throws instead of replying. */
  stopThrows: boolean;
  /** Stop claims success but revokes nothing, and delivery continues. */
  deliverAfterStop: boolean;
  /** Stop signals the CLI sessions. */
  stopKillsSessions: boolean;
  /** One ticket fails to close. */
  closeFailsFor: number | null;
  /** The human declines the channel. */
  confirmChannel: boolean;
  /** What the owner mode route confirms for each requested mode. */
  mode: ModeRequest | ((mode: ListeningMode) => ModeRequest);
  /** Another run already holds the lock. */
  lockHeld: boolean;
};

const DEFAULT_KNOBS: WorldKnobs = {
  sessions: true, receipts: true, handshake: true, reannounce: false, stopThrows: false, deliverAfterStop: false,
  stopKillsSessions: false, closeFailsFor: null, confirmChannel: true, mode: { kind: 'effective' }, lockHeld: false,
};

type Binding = { bindingId: string; generation: number; participantId: string; harness: string; sessionDigest: string; status: 'active' | 'revoked' };
type StoredEvent = TimelineEvent & { sequence: number; deviceId: string; clientTxnId: string };

export type World = Readonly<{
  deps: RunnerDeps;
  profile: Profile;
  markers: Markers;
  knobs: WorldKnobs;
  issues: Map<number, IssueRecord>;
  closed: number[];
  stopCalls: (readonly StopTarget[])[];
  /** Every mode request the runner made, in order. */
  modeCalls: Readonly<{ bindingId: string; mode: ListeningMode }>[];
  signalled: number[];
  launcherStarts: number;
  /** Every `khala` command started, with the exact package spec it ran. */
  ran: string[];
  serverClosed(): boolean;
  lockAcquired(): boolean;
  lockReleased(): boolean;
  /** Tamper with an issue between creation and cleanup. */
  editIssue(number: number, change: Partial<IssueRecord>): void;
}>;

export function createWorld(
  partial: Partial<WorldKnobs> = {},
  profile: Profile = offlineProfile(),
  stager: PackagePort = packageStager(path.join(os.tmpdir(), 'khala-acceptance-fakes')),
): World {
  const knobs: WorldKnobs = { ...DEFAULT_KNOBS, ...partial };
  const ran: string[] = [];
  const markers = markersFor(RUN_ID);
  let now = Date.parse('2026-09-26T10:00:00.000Z');
  const iso = () => new Date(now).toISOString();
  const issues = new Map<number, IssueRecord>();
  const closed: number[] = [];
  const stopCalls: (readonly StopTarget[])[] = [];
  const modeCalls: { bindingId: string; mode: ListeningMode }[] = [];
  const signalled: number[] = [];
  const events: StoredEvent[] = [];
  const receipts: SnapshotReceipt[] = [];
  const bindings: Binding[] = [];
  const granted = new Set<RoleName>();
  const announced = new Map<RoleName, number>();
  const requests = new Map<RoleName, AccessRequest>();
  let serverClosed = false;
  let stoppedAt: number | null = null;
  let lockAcquired = false;
  let lockReleased = false;
  let launcherStarts = 0;
  let nextIssue = 1001;
  let receiptCount = 0;
  const ticketOf = new Map<RoleName, number>();
  const sessionOf = (role: RoleName): NativeSession | null => {
    const ticket = ticketOf.get(role);
    if (ticket === undefined || !knobs.sessions) return null;
    const expected = profile.roles.find(entry => entry.role === role)!;
    return {
      sessionId: `native-${role}-${ticket}`, pid: 40_000 + ticket, harness: expected.harness, provider: expected.provider,
      model: expected.model, cliVersion: CODEX_VERSION, launchCommand: `${expected.harness} --model ${expected.model}`, startedAt: iso(),
    };
  };
  const bindingOf = (role: RoleName) => bindings.filter(binding => binding.participantId === `participant_${role}`).at(-1);

  function post(author: string, kind: string, body: string, clientTxnId: string): StoredEvent {
    now += 1_000;
    const event = { eventId: `event_${events.length + 1}`, authorParticipantId: author, authorKind: kind, body, receivedAt: iso(), sequence: events.length + 1, deviceId: `device_${author}`, clientTxnId };
    events.push(event);
    return event;
  }

  function acknowledge(role: RoleName, event: StoredEvent): void {
    const binding = bindingOf(role)!;
    if (binding.status !== 'active' || !knobs.receipts) return;
    now += 500;
    receiptCount += 1;
    receipts.push({
      receiptId: `receipt_${receiptCount}`, bindingId: binding.bindingId, generation: binding.generation,
      kind: 'agent_acknowledged', source: 'agent', observedAt: iso(), eventIds: [event.eventId],
    });
  }

  /** The two scripted sessions react to what the channel now holds. */
  function tick(): void {
    for (const role of ['a', 'b'] as const) {
      const binding = bindingOf(role);
      if (!binding || binding.status !== 'active' || announced.has(role)) continue;
      announced.set(role, binding.generation);
      post(binding.participantId, 'agent', `${markers.ready(role)} binding=${binding.bindingId} generation=${binding.generation}`, `ready-${role}-${binding.generation}`);
    }
    if (!knobs.handshake) return;
    for (const mode of ['steer', 'sync', 'async'] as const satisfies readonly ListeningMode[]) {
      const go = events.find(event => event.authorKind === 'human' && event.body === controllerLine.mode(markers, mode, 'effective'));
      if (!go || stoppedAt !== null) continue;
      const a = markers.handshake('a', mode);
      const b = markers.handshake('b', mode);
      const first = events.find(event => event.body === a) ?? post('participant_a', 'agent', a, `hs-a-${mode}`);
      let second = events.find(event => event.body === `${a} ${b}`);
      if (!second) {
        acknowledge('b', first);
        second = post('participant_b', 'agent', `${a} ${b}`, `hs-b-${mode}`);
      }
      if (!events.some(event => event.body === `${markers.ack(mode)} ${b}`)) {
        acknowledge('a', second);
        post('participant_a', 'agent', `${markers.ack(mode)} ${b}`, `hs-ack-${mode}`);
      }
    }
    const hold = events.find(event => event.body === controllerLine.hold(markers));
    if (hold && knobs.reannounce && bindingOf('b')!.generation === 1) {
      bindings.push({ ...bindingOf('b')!, generation: 2 });
      announced.delete('b');
      tick();
    }
  }

  const owner: OwnerSession = {
    channelId: 'channel_offline',
    channelUrl: 'http://127.0.0.1:4870/channels/channel_offline',
    async timeline() {
      if (serverClosed) throw new Error('server closed');
      tick();
      return events.map(({ eventId, authorParticipantId, authorKind, body, receivedAt }) => ({ eventId, authorParticipantId, authorKind, body, receivedAt }));
    },
    async say(body, clientTxnId) {
      return post('participant_human', 'human', body, clientTxnId).eventId;
    },
    async accessRequests() {
      for (const role of ['a', 'b'] as const) {
        const session = sessionOf(role);
        const ticket = ticketOf.get(role);
        if (ticket === undefined || requests.has(role)) continue;
        const expected = profile.roles.find(entry => entry.role === role)!;
        requests.set(role, {
          requestHandle: `request_${role}`, revision: '1', outcome: 'pending_owner', harness: expected.harness,
          sessionFingerprint: sessionDigest(expected.harness, session?.sessionId ?? `unrecorded-${role}`),
        });
      }
      return [...requests.values()].map(request => ({ ...request }));
    },
    async approve(request) {
      const role = request.requestHandle.endsWith('_a') ? 'a' : 'b';
      const expected = profile.roles.find(entry => entry.role === role)!;
      requests.set(role, { ...request, outcome: 'approved' });
      granted.add(role);
      bindings.push({
        bindingId: `binding_${role}`, generation: 1, participantId: `participant_${role}`, harness: expected.harness,
        sessionDigest: request.sessionFingerprint, status: 'active',
      });
    },
    async requestMode(target, mode) {
      modeCalls.push({ bindingId: target.bindingId, mode });
      return typeof knobs.mode === 'function' ? knobs.mode(mode) : knobs.mode;
    },
    async stop(targets): Promise<StopReply> {
      stopCalls.push(targets);
      if (knobs.stopThrows) throw new Error('stop transport failed');
      // The server's own guard: only the latest generation of a known binding.
      for (const target of targets) {
        const latest = bindings.filter(binding => binding.bindingId === target.bindingId).at(-1);
        if (!latest || latest.generation !== target.generation || latest.participantId !== target.agentParticipantId) {
          return { kind: 'refused', status: 409, code: 'operation_mismatch' };
        }
      }
      stoppedAt = now;
      if (knobs.deliverAfterStop) {
        // A no-op Stop: it claims success, but the bindings stay live and delivery goes on.
        const late = post('participant_human', 'human', 'after stop', 'late-human');
        for (const role of ['a', 'b'] as const) acknowledge(role, late);
      } else {
        for (const target of targets) {
          for (const binding of bindings) if (binding.bindingId === target.bindingId) binding.status = 'revoked';
        }
      }
      if (knobs.stopKillsSessions) for (const role of ['a', 'b'] as const) signalled.push(sessionOf(role)?.pid ?? 0);
      return { kind: 'stopped', stopped: targets };
    },
    async viewable() {
      return !serverClosed;
    },
  };

  const server: LaunchedServer = {
    channelId: owner.channelId,
    origin: 'http://127.0.0.1:4870',
    humanUrl: 'http://127.0.0.1:4870/#credential=offline&channel=channel_offline',
    owner: async () => owner,
    async close() { serverClosed = true; },
    async reachable() { return !serverClosed; },
  };

  const github: GitHubPort = {
    async preflight() {},
    async createIssue(input) {
      const number = nextIssue++;
      const record: IssueRecord = { number, repository: input.repository, title: input.title, body: input.body, labels: [...input.labels], state: 'open', createdAt: iso() };
      issues.set(number, record);
      ticketOf.set(ticketOf.has('a') ? 'b' : 'a', number);
      return record;
    },
    async getIssue(_repository, number) {
      const issue = issues.get(number);
      if (!issue) throw new Error('not found');
      return issue;
    },
    async closeIssue(_repository, number) {
      if (knobs.closeFailsFor === number) throw new Error('github refused the close');
      issues.set(number, { ...issues.get(number)!, state: 'closed' });
      closed.push(number);
    },
    async linkedPullRequests() { return []; },
  };

  const controller: ControllerPort = {
    async confirmChannel() { return knobs.confirmChannel; },
    async confirmGrant() { return true; },
    note() {},
  };

  const deps: RunnerDeps = {
    lock: {
      async acquire() {
        if (knobs.lockHeld) return null;
        lockAcquired = true;
        return { release: async () => { lockReleased = true; } };
      },
    },
    package: stager,
    status: { async status(spec) { ran.push(`status ${spec}`); return { ok: true, output: { v: 1, connected: false } }; } },
    github,
    aiur: {
      async session(ticket) {
        const role = [...ticketOf].find(([, number]) => number === ticket)?.[0];
        return role ? sessionOf(role) : null;
      },
      async alive(session) { return !signalled.includes(session.pid); },
    },
    launcher: { async start(spec) { ran.push(`internal ${spec}`); launcherStarts += 1; return server; } },
    snapshot: {
      async read(): Promise<ChannelSnapshot> {
        if (!serverClosed) throw new Error('a launcher still holds the internal root; the live store is never read');
        return {
          channelId: owner.channelId,
          bindings: bindings.map(binding => ({ ...binding })),
          events: events.map(event => ({
            sequence: event.sequence, eventId: event.eventId, authorParticipantId: event.authorParticipantId,
            authorDeviceId: event.deviceId, clientTxnId: event.clientTxnId, receivedAt: event.receivedAt,
          })),
          receipts: [...receipts],
        };
      },
    },
    controller,
    clock: { now: () => now, sleep: async ms => { now += ms; } },
    pollMs: 1_000,
  };

  return {
    deps, profile, markers, knobs, issues, closed, stopCalls, modeCalls, signalled, ran,
    get launcherStarts() { return launcherStarts; },
    serverClosed: () => serverClosed,
    lockAcquired: () => lockAcquired,
    lockReleased: () => lockReleased,
    editIssue(number, change) { issues.set(number, { ...issues.get(number)!, ...change }); },
  };
}

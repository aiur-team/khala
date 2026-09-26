// The hosted-mode review gate for the security suite, on real parts: the KHA-115
// SQLite ledger, KHA-119 release policy, the KHA-134 review handler and
// registration, the KHA-121 dispatcher and the KHA-118 Codex adapter. The model
// session is the Codex package's fake app-server: every call the adapter makes to
// it is recorded, so what the session received is exactly what the adapter wrote.
// Only the protected human transport is a stand-in, as in the KHA-134 composition
// tests: it hands the handler an authenticated `OwnerAuthority` and an untrusted body.
//
// No production connector entry point composes these parts yet (see the KHA-136
// README), so this is local composition evidence, never live evidence.

import fs from 'node:fs';
import path from 'node:path';
import {
  type ApprovalCommand, type ApprovalResult, type BindingId, type CommandId, type DeliveryLimits, type DeviceId,
  type EventId, type EventRef, type HarnessCapabilities, type HarnessPort, type OwnerAuthority, type OwnerId,
  type ParticipantId, type RoomId, type SessionBinding, decodeDeliveryLimits,
} from '@khala/contracts/delivery/index';
import { encodeMessageContent } from '@khala/contracts/messaging/events';
import { createDispatcher } from '@khala/connector/dispatch/run';
import type { Dispatcher } from '@khala/connector/dispatch/types';
import { createConnectorDispatchStorage } from '@khala/connector/storage/dispatch';
import { type ConnectorStorage, openConnectorStorage } from '@khala/connector/storage/open';
import { sha256Digest } from '@khala/connector/storage/payloads';
import { createCodexHarness } from '@khala/harnesses/codex/index';
import type { ConnectorCapability, ConnectorCapabilityContext } from '../../../apps/connector/src/runtime/capabilities';
import type { ReviewControlHandler } from '../../../apps/connector/src/composition/review/control-handler';
import type { PreviewOutcome } from '../../../apps/connector/src/composition/review/preview-access';
import { registerReview } from '../../../apps/connector/src/composition/review/register';
// The package withholds its fake app-server from exports; the suite reuses it by path.
import { FakeAppServer, FakeCodec, FakeHosts } from '../../../packages/harnesses/src/codex/fakes';
import { type Canary, type SurfaceCapture, createSurfaceCapture, mintCanary } from './fixtures';

const decoded = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
if (!decoded.ok) throw new Error('limits');
export const limits: DeliveryLimits = decoded.value;

export const roomId = 'room_security' as RoomId;
export const otherRoomId = 'room_elsewhere' as RoomId;
export const ownerId = 'owner_b' as OwnerId;
export const bindingId = 'binding_b' as BindingId;
export const agent = 'participant_agent_b' as ParticipantId;
export const author = 'participant_a' as ParticipantId;
const EVIDENCE = 'evidence-kha138';
const POLICY_VERSION = 3;

export const binding: SessionBinding = {
  v: 1, bindingId, ownerId, agentParticipantId: agent, deviceId: 'device_connector_b' as DeviceId,
  harness: 'codex', sessionId: 'existing-session-b', generation: 0,
};

/** The authority the protected transport derives from the owner's authenticated session. */
export const ownerAuthority: OwnerAuthority = {
  ownerId, issuer: 'https://issuer.example.test', subject: 'subject-b', authenticatedAt: '2026-09-25T10:00:00Z',
  authorizationId: 'authz_b' as OwnerAuthority['authorizationId'],
};

/** A different, equally authenticated owner: the peer human in the same room. */
export const peerAuthority: OwnerAuthority = {
  ownerId: 'owner_a' as OwnerId, issuer: 'https://issuer.example.test', subject: 'subject-a',
  authenticatedAt: '2026-09-25T10:00:00Z', authorizationId: 'authz_a' as OwnerAuthority['authorizationId'],
};

const content = (body: string) => encodeMessageContent({ v: 1, kind: 'text', body });

export function eventRef(eventId: string, body: string, room: RoomId = roomId): EventRef {
  return {
    v: 1, roomId: room, eventId: eventId as EventId, authorParticipantId: author, authorDeviceId: 'device_a' as DeviceId,
    contentDigest: sha256Digest(content(body)),
  };
}

export function approval(selection: readonly EventRef[], overrides: Partial<ApprovalCommand> = {}): ApprovalCommand {
  return {
    v: 1, commandId: 'approve-1' as CommandId, roomId, bindingId, expectedPolicyVersion: POLICY_VERSION,
    expectedBindingGeneration: binding.generation, selection: [...selection], issuedAt: '2026-09-25T10:01:00Z', ...overrides,
  };
}

/**
 * The listening-mode proof is outside this suite's boundary: the fake app-server
 * cannot prove a user-owned Codex mode, so the real adapter reports modes unknown.
 * The session port overlays a proven `sync` mode on what the adapter inspects, as
 * the KHA-134 composition test's session harness does, so the gate is exercised end
 * to end. Everything else the adapter reports and does is its own.
 */
function provenSync(capabilities: HarnessCapabilities): HarnessCapabilities {
  const proven = { status: 'proven', route: 'test-codex-sync', testedVersion: capabilities.version, evidenceRef: 'docs/evidence/codex.md', evidenceRevision: EVIDENCE, reason: null };
  return { ...capabilities, modes: { ...capabilities.modes, sync: proven } } as HarnessCapabilities;
}

export type HostedState = Readonly<{ state: string; storage: ConnectorStorage }>;

const opened: ConnectorStorage[] = [];
const dispatchers: Dispatcher[] = [];
const capabilitiesStarted: ConnectorCapability[] = [];
const scratch: string[] = [];

/** Closes every connector process and store this module opened. */
export async function closeHostedWorlds(): Promise<void> {
  await Promise.all(capabilitiesStarted.splice(0).map(capability => capability.stop().catch(() => undefined)));
  await Promise.all(dispatchers.splice(0).map(dispatcher => dispatcher.stop().catch(() => undefined)));
  await Promise.all(opened.splice(0).map(storage => storage.close().catch(() => undefined)));
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
}

export async function openStore(state: string, mode: 'create' | 'existing'): Promise<ConnectorStorage> {
  const storage = await openConnectorStorage({ directory: state, mode, limits });
  opened.push(storage);
  return storage;
}

/** A fresh owner ledger holding `pending` events for the binding. */
export async function seedLedger(events: readonly Readonly<{ ref: EventRef; body: string }>[]): Promise<HostedState> {
  const parent = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'kha138-hosted-'));
  scratch.push(parent);
  const state = path.join(parent, 'state');
  const storage = await openStore(state, 'create');
  await storage.ledger.transaction(tx => tx.putBinding(binding));
  await createConnectorDispatchStorage(storage).applyEffectivePolicy({
    binding,
    policy: {
      version: POLICY_VERSION, armedAt: POLICY_VERSION, paused: false, expiresAt: null,
      listening: { version: 1, requested: 'sync', effective: 'sync', evidenceRevision: EVIDENCE },
    },
  });
  for (const { ref, body } of events) {
    await storage.persistPending({
      key: { roomId: ref.roomId, eventId: ref.eventId, recipientBindingId: bindingId, recipientGeneration: binding.generation },
      event: ref, plaintext: content(body), receivedAt: '2026-09-25T09:59:00Z', streamId: 'stream_1',
    });
  }
  return { state, storage };
}

/** The existing Codex session: the fake app-server behind the real adapter. */
export type CodexSession = Readonly<{ server: FakeAppServer; hosts: FakeHosts; port: HarnessPort; notified: string[] }>;

/**
 * A Codex adapter instance over a session. Passing the `server` and `notified` of an
 * earlier instance reattaches a new adapter, as a restarted connector would, to the
 * same surviving user session.
 */
export function codexSession(
  workdir: string,
  overrides: Readonly<{ bindingOverride?: SessionBinding; server?: FakeAppServer; notified?: string[] }> = {},
): CodexSession {
  const server = overrides.server ?? new FakeAppServer();
  if (!overrides.server) {
    server.threadId = (overrides.bindingOverride ?? binding).sessionId;
    server.cwd = workdir;
  }
  const hosts = new FakeHosts({
    binding: overrides.bindingOverride ?? binding, workdir, cliVersion: '0.154.0',
    endpoint: { kind: 'unix', path: `/run/khala/codex/${bindingId}/exec.sock` },
  });
  const harness = createCodexHarness({
    client: server, hosts, codec: new FakeCodec(), clock: { now: () => new Date('2026-09-25T10:01:30Z') },
    evidence: { record: async () => undefined }, limits, deadlines: { callMs: 1_000, closeMs: 2_000 },
  });
  const notified = overrides.notified ?? [];
  const port: HarnessPort = {
    inspect: async target => provenSync(await harness.inspect(target)),
    notify: async (target, hint) => {
      notified.push(JSON.stringify({ target, hint }));
      await harness.notify(target, hint);
    },
    submit: input => harness.submit(input),
    reconcile: job => harness.reconcile(job),
    close: () => harness.close(),
  };
  return { server, hosts, port, notified };
}

export type ConnectorProcess = Readonly<{
  dispatcher: Dispatcher;
  capability: ConnectorCapability;
  errors: string[];
  /** The authenticated human request path. The authority comes from the session, never the body. */
  approve(body: unknown, authority?: OwnerAuthority): Promise<ApprovalResult>;
  preview(body: unknown, authority?: OwnerAuthority): Promise<PreviewOutcome>;
  stop(): Promise<void>;
}>;

/** One connector process over `storage`: dispatcher, review capability and protected-transport stand-in. */
export async function startConnector(
  storage: ConnectorStorage,
  session: CodexSession,
  options: Readonly<{ dropHandoff?: boolean; members?: readonly ParticipantId[] }> = {},
): Promise<ConnectorProcess> {
  const dispatchStorage = createConnectorDispatchStorage(storage);
  let ids = 0;
  const dispatcher = createDispatcher({
    ledger: dispatchStorage.ledger,
    limits: { maxJobsPerCausalRoot: 10, maxConcurrentJobs: 10, busy: 'queue' },
    harness: session.port,
    boundary: { await: async ({ job }) => ({ binding: job.binding, capabilities: await session.port.inspect(job.binding) }) },
    approvals: dispatchStorage.approvals,
    payloads: dispatchStorage.payloads,
    digest: async bytes => sha256Digest(bytes),
    clock: { now: () => new Date('2026-09-25T10:01:30Z') },
    newId: kind => `${kind}-${(ids += 1)}`,
    workerId: 'worker-1',
  });
  dispatchers.push(dispatcher);
  for (const releaseId of await dispatchStorage.reconciliationReleaseIds()) await dispatcher.reconcile(releaseId);

  let served: ReviewControlHandler | null = null;
  let releaseCounter = 0;
  const errors: string[] = [];
  const context: ConnectorCapabilityContext = {
    binding,
    ledger: { runtimeLedgerPort: true },
    dispatcher: { reconcilePending: async () => undefined, setEnabled: () => undefined, stop: async () => undefined },
    clock: () => 0,
    prerequisiteChanged: () => undefined,
  };
  const capability = registerReview({
    ...context,
    dependencies: {
      protectedTransport: {
        capability: 'review',
        serve(handler) {
          served = handler;
          return () => { served = null; };
        },
      },
      control: {
        storage,
        dispatchStorage,
        releases: options.dropHandoff
          ? { enqueue: async () => { throw new Error('process died before handoff'); } }
          : dispatcher,
        room: { members: async room => (room === roomId ? [...(options.members ?? [author, agent])] : null) },
        limits,
        newReleaseId: () => `release_${(releaseCounter += 1)}`,
        onError: code => { errors.push(code); },
      },
    },
  });
  await capability.start();
  capabilitiesStarted.push(capability);
  // The runtime starts a dispatch pass once the process is ready, so queued work held
  // by an earlier process (for example behind a pause since lifted) is considered again.
  dispatcher.wake();
  const handler = () => {
    if (served === null) throw new Error('review transport is not serving');
    return served;
  };
  return {
    dispatcher, capability, errors,
    approve: (body, authority = ownerAuthority) => handler().approve(authority, body),
    preview: (body, authority = ownerAuthority) => handler().preview(authority, body),
    async stop() {
      await capability.stop();
      await dispatcher.stop();
    },
  };
}

/** Everything the model session received, as one capture per surface. */
export function sessionCapture(session: CodexSession, capture: SurfaceCapture = createSurfaceCapture()): SurfaceCapture {
  capture.add('model:codex-app-server', JSON.stringify(session.server.calls));
  capture.add('model:notify', session.notified.join('\n'));
  return capture;
}

export type GatedRelease = Readonly<{
  pending: Canary;
  approved: Canary;
  capture: SurfaceCapture;
  state: HostedState;
  process: ConnectorProcess;
  session: CodexSession;
  pendingRef: EventRef;
  approvedRef: EventRef;
}>;

/** The review gate's positive control: two pending events, one approved, delivered once. */
export async function runGatedRelease(): Promise<GatedRelease> {
  const pending = mintCanary('pending');
  const approved = mintCanary('approved');
  const pendingRef = eventRef('event_pending', `withheld ${pending.text}`);
  const approvedRef = eventRef('event_approved', `chosen ${approved.text}`);
  const state = await seedLedger([
    { ref: pendingRef, body: `withheld ${pending.text}` },
    { ref: approvedRef, body: `chosen ${approved.text}` },
  ]);
  const session = codexSession(path.dirname(state.state));
  const process = await startConnector(state.storage, session);
  const result = await process.approve(approval([approvedRef]));
  if (!result.ok) throw new Error(`approval refused: ${result.code}`);
  await process.dispatcher.idle();
  const capture = sessionCapture(session);
  capture.add('connector:errors', process.errors.join('\n'));
  return { pending, approved, capture, state, process, session, pendingRef, approvedRef };
}

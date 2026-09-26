import fs from 'node:fs';
import path from 'node:path';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { DeviceId, EventId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import {
  type ConversionAccessPort, type ConversionAccessReadiness, type ConversionAgentBlock, type ConversionAgentIdentity,
  type ConversionBindingPort, type ConversionSessionCheck, type ConversionSessionPort, type ConversionVisibility,
  type HostedChannelCreated, type HostedChannelPort,
} from '@khala/contracts/messaging/externalization';
import { type ImportedHistoryLimits, decodeImportedHistoryLimits } from '@khala/contracts/messaging/imported-history';
import { ok, outcomeUnknown, rejected, unavailable } from '@khala/contracts/messaging/outcomes';
import type { ImportedHistoryPart, ImportedHistoryTransport, ImportedPartLookup } from '@khala/messaging/channels/history-import';
import type { HostedSignInOutcome, HostedSignInPort } from '../../web/make-external/ports';
import { type ChannelStore, type RegisteredParticipant, createChannelStore } from '../../store/channel-store';
import { createDiscoveryStore } from '../../store/discovery-store';
import { type InternalStoreHandle, openChannelStore } from '../../store/open';

// Test-only hosted side of Make external: channel creation, the access journal, inbox
// and activation, conversion-paused bindings, session re-verification, hosted sign-in
// and the imported-history transport. Every fault a test needs is a knob here, and
// imported parts are stored apart from the destination's live timeline, which is the
// only thing members (agents) are woken by.

export type LiveEvent = Readonly<{ roomId: string; body: string; origin: 'native' | 'imported' }>;

/**
 * `imported_as_live`: the wrong implementation that replays every imported record as a
 * live timeline event, so members wake on old history. Only tests set it.
 */
export type ProviderDefect = 'imported_as_live';

export class FakeHostedProvider
implements HostedChannelPort, ConversionAccessPort, ConversionBindingPort, ConversionSessionPort, HostedSignInPort, ImportedHistoryTransport {
  readonly channels = new Map<string, HostedChannelCreated>();
  readonly creates: HostedChannelCreated[] = [];
  readonly requests = new Map<string, { agent: ConversionAgentIdentity; destination: string; granted: number; operationId: string }>();
  readonly bindings = new Map<string, { paused: boolean }>();
  readonly withdrawn = new Set<string>();
  readonly parts = new Map<string, Readonly<{ partId: string; roomId: string; part: ImportedHistoryPart }>>();
  readonly live: LiveEvent[] = [];
  private readonly listeners = new Set<(event: LiveEvent) => void>();
  private signInSequence = 0;

  /** Create responses still to lose after the create took effect. */
  loseCreateResponses = 0;
  createUnavailable = false;
  /** Part puts whose acknowledgement is lost after the part was stored. */
  loseAck: (clientTxnId: string) => boolean = () => false;
  /** Runs before every part put, e.g. to keep writing to the source while history copies. */
  beforePut: (part: ImportedHistoryPart) => void = () => {};
  signInOutcome: HostedSignInOutcome = 'signed_in';
  readonly blocked = new Map<string, ConversionAgentBlock>();
  readonly withheld = new Set<string>();
  readonly releaseFails = new Set<string>();
  readonly sessionChecks = new Map<string, ConversionSessionCheck>();
  defect: ProviderDefect | null = null;

  constructor(private readonly origin = 'https://khala.test') {}

  destinationUrl = (channelId: string): string => `${this.origin}/channels/${encodeURIComponent(channelId)}`;

  // Hosted channel creation.
  async create(input: Readonly<{ idempotencyKey: string; title: string | null; visibility: ConversionVisibility }>) {
    if (this.createUnavailable) return unavailable();
    let created = this.channels.get(input.idempotencyKey);
    if (!created) {
      created = { idempotencyKey: input.idempotencyKey, destinationChannelId: `external-${this.channels.size + 1}`, visibility: input.visibility };
      this.channels.set(input.idempotencyKey, created);
      this.creates.push(created);
    }
    if (this.loseCreateResponses > 0) {
      this.loseCreateResponses -= 1;
      return outcomeUnknown(input.idempotencyKey);
    }
    return ok(created);
  }

  async reconcile(input: Readonly<{ idempotencyKey: string }>) {
    return ok(this.channels.get(input.idempotencyKey) ?? null);
  }

  // Access journal, inbox and activation.
  async request(input: Readonly<{ operationId: string; destinationChannelId: string; agent: ConversionAgentIdentity }>) {
    const existing = [...this.requests].find(([, request]) => request.operationId === input.operationId);
    if (existing) return ok({ requestHandle: existing[0] });
    const handle = `careq-${input.agent.participantId}-${this.requests.size + 1}`;
    this.requests.set(handle, { agent: input.agent, destination: input.destinationChannelId, granted: 0, operationId: input.operationId });
    return ok({ requestHandle: handle });
  }

  async grant(input: Readonly<{ requestHandle: string; operationId: string }>) {
    const request = this.requests.get(input.requestHandle);
    if (!request || this.withdrawn.has(input.requestHandle)) return rejected('not_found' as const);
    request.granted += 1;
    return ok({ requestHandle: input.requestHandle });
  }

  async readiness(handle: string): Promise<ConversionAccessReadiness> {
    const request = this.requests.get(handle);
    if (!request) return { kind: 'unavailable' };
    const block = this.blocked.get(request.agent.participantId);
    if (block) return { kind: 'blocked', block };
    if (request.granted === 0) return { kind: 'pending_owner' };
    if (this.withheld.has(request.agent.participantId)) return { kind: 'granted' };
    if (!this.bindings.has(handle)) this.bindings.set(handle, { paused: true });
    return { kind: 'ready' };
  }

  async withdraw(input: Readonly<{ requestHandle: string; operationId: string }>) {
    this.withdrawn.add(input.requestHandle);
    this.bindings.delete(input.requestHandle);
    return 'withdrawn' as const;
  }

  async release(input: Readonly<{ requestHandle: string; destinationChannelId: string; operationId: string }>) {
    const request = this.requests.get(input.requestHandle);
    const binding = this.bindings.get(input.requestHandle);
    if (!request || !binding || this.releaseFails.has(request.agent.participantId)) return 'unavailable' as const;
    binding.paused = false;
    return 'released' as const;
  }

  /** A paused binding neither publishes nor receives. */
  canExchange(participantId: string): boolean {
    return [...this.requests].some(([handle, request]) =>
      request.agent.participantId === participantId && this.bindings.get(handle)?.paused === false);
  }

  // Session re-verification.
  async verify(agent: ConversionAgentIdentity) {
    return this.sessionChecks.get(agent.participantId) ?? 'current';
  }

  // Hosted sign-in.
  async begin() {
    this.signInSequence += 1;
    return ok({ attempt: `signin-${this.signInSequence}`, verificationUrl: `${this.origin}/sign-in/${this.signInSequence}` });
  }

  async status(): Promise<HostedSignInOutcome> {
    return this.signInOutcome;
  }

  // Imported-history transport, stored apart from the live timeline.
  async putPart(input: Readonly<{ roomId: RoomId; clientTxnId: string; part: ImportedHistoryPart }>) {
    this.beforePut(input.part);
    const existing = this.parts.get(input.clientTxnId);
    const partId = existing?.partId ?? `part-${this.parts.size + 1}`;
    if (!existing) {
      this.parts.set(input.clientTxnId, { partId, roomId: input.roomId, part: structuredClone(input.part) });
      if (this.defect === 'imported_as_live' && input.part.kind === 'chunk') {
        for (const record of input.part.chunk.records) this.emit({ roomId: input.roomId, body: record.body, origin: 'imported' });
      }
    }
    return this.loseAck(input.clientTxnId) ? { kind: 'unknown' } as const : { kind: 'done', value: { partId } } as const;
  }

  async findPart(input: Readonly<{ roomId: RoomId; clientTxnId: string }>): Promise<ImportedPartLookup> {
    const found = this.parts.get(input.clientTxnId);
    return found && found.roomId === input.roomId ? { kind: 'found', partId: found.partId } : { kind: 'absent' };
  }

  async readParts(input: Readonly<{ roomId: RoomId; archiveId: string }>) {
    const parts = [...this.parts.values()].filter(entry => entry.roomId === input.roomId && entry.part.archiveId === input.archiveId);
    const manifest = parts.find(entry => entry.part.kind === 'manifest')?.part;
    const chunks = parts.flatMap(entry => entry.part.kind === 'chunk' ? [entry.part] : [])
      .sort((a, b) => a.index - b.index).map(part => part.chunk);
    return { kind: 'done', value: { manifest: manifest?.kind === 'manifest' ? manifest.manifest : null, chunks } } as const;
  }

  /** A new message in the destination's live timeline, as any member would send it. */
  sendLive(roomId: string, body: string): void {
    this.emit({ roomId, body, origin: 'native' });
  }

  /** Members of the destination hear only its live timeline. */
  onLive(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: LiveEvent): void {
    this.live.push(event);
    for (const listener of this.listeners) listener(event);
  }
}

export const IMPORT_LIMITS: ImportedHistoryLimits = (() => {
  const decoded = decodeImportedHistoryLimits({
    maxBodyBytes: 16 * 1024, maxAuthorLabelBytes: 255, maxRecordsPerChunk: 4, maxChunkBytes: 256 * 1024, maxChunks: 256,
    maxPageRecords: 20, maxPageBytes: 64 * 1024,
  });
  if (!decoded.ok) throw new Error('fixture import limits');
  return decoded.value;
})();

export const human: RegisteredParticipant = {
  participantId: 'participant-ada' as ParticipantId, ownerId: 'owner-ada' as OwnerId, kind: 'human', displayName: 'Ada',
};
export const humanDevice = 'device-ada' as DeviceId;
export const AGENT_IDS = ['agent-builder', 'agent-reviewer', 'agent-tester'] as const;

export type SeededChannel = Readonly<{
  root: string;
  handle: InternalStoreHandle;
  store: ChannelStore;
  channelId: RoomId;
  /** Sends one message as the human; false when the channel refuses writes. */
  send(body: string): boolean;
  count(): number;
  close(): void;
}>;

/** A real internal store with one human-owned channel, three bound agents and `messages` messages. */
export function seedInternalChannel(input: Readonly<{ root: string; messages?: readonly string[]; title?: string }>): SeededChannel {
  fs.chmodSync(input.root, 0o700);
  const handle = openChannelStore({ directory: path.join(input.root, 'state'), mode: 'create' });
  const store = createChannelStore(handle);
  const channelId = 'internal-planning' as RoomId;
  store.registerParticipant(human);
  store.registerDevice({ deviceId: humanDevice, participantId: human.participantId });
  store.createChannel({
    operationId: 'create-internal', channelId, title: input.title ?? 'Planning', creatorOwnerId: human.ownerId,
    creatorParticipantId: human.participantId, creatorDeviceId: humanDevice, createdAt: '2026-09-25T10:00:00.000Z',
  });
  const discovery = createDiscoveryStore(handle);
  AGENT_IDS.forEach((id, index) => {
    const participantId = id as ParticipantId;
    store.registerParticipant({ participantId, ownerId: human.ownerId, kind: 'agent', displayName: ['Builder', 'Reviewer', 'Tester'][index]! });
    store.registerDevice({ deviceId: `device-${id}` as DeviceId, participantId });
    store.setMembership({ channelId, participantId, membership: 'joined' });
    discovery.activate({
      operationKey: `activation-${id}`, channelId, sessionGeneration: 1, history: 'shared',
      binding: {
        v: 1, bindingId: `binding-${id}` as SessionBinding['bindingId'], ownerId: human.ownerId, agentParticipantId: participantId,
        deviceId: `device-${id}` as DeviceId, harness: 'codex', sessionId: `session-${id}`, generation: 1,
      },
    });
  });
  let sent = 0;
  const send = (body: string): boolean => {
    sent += 1;
    const stored = store.send({
      channelId, eventId: `event-${sent}` as EventId, authorParticipantId: human.participantId, authorDeviceId: humanDevice,
      clientTxnId: `txn-${sent}`, content: { v: 1, kind: 'text', body },
      receivedAt: new Date(Date.UTC(2026, 8, 25, 11, 0, sent)).toISOString(),
    });
    return stored.kind === 'stored';
  };
  for (const body of input.messages ?? []) if (!send(body)) throw new Error('fixture message');
  return {
    root: input.root, handle, store, channelId, send,
    count: () => handle.read(db => Number((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n)),
    close: () => handle.close(),
  };
}

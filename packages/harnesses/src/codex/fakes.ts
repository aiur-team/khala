// Test doubles for the Codex adapter. Not exported from `index.ts`. `FakeAppServer`
// models the KHA-104 native behaviour that matters here: a durable queue that does
// not deduplicate `clientUserMessageId`, and turns whose `userMessage.clientId`
// carries it once the executor consumes an entry.

import { createHash } from 'node:crypto';
import {
  type DeliveryLimits, type DeliveryReceipt, type ReleasedJob, type SessionBinding, decodeApprovalCommand,
  decodeDeliveryLimits,
  decodeSessionBinding, releaseFromApproval,
} from '@khala/contracts/delivery/index';
import type {
  CodexClientPort, CodexConnection, CodexEndpoint, CodexHost, CodexHostPort, CodexMethod, CodexRequestOutcome,
  ThreadStatus, TurnStatus,
} from './native';
import type { Clock, EvidenceSink } from './receipts';
import type { ReleaseCodecPort } from './transport';

const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 4, maxPayloadBytes: 4096 });
if (!decodedLimits.ok) throw new Error('fixture limits');
export const limits: DeliveryLimits = decodedLimits.value;
const digest = (c: string) => `sha256:${c.repeat(64)}`;

export function binding(overrides: Partial<Record<keyof SessionBinding, unknown>> = {}): SessionBinding {
  const decoded = decodeSessionBinding({
    v: 1, bindingId: 'bind-b-1', ownerId: 'owner-b', agentParticipantId: 'agent-b', deviceId: 'dev-b',
    harness: 'codex', sessionId: 'session-b', generation: 0, ...overrides,
  });
  if (!decoded.ok) throw new Error(`fixture binding: ${decoded.field}`);
  return decoded.value;
}

export const PLAINTEXT = 'released text: the quarterly numbers look fine';
export const payload = (text = PLAINTEXT) => new TextEncoder().encode(text);
const payloadDigest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** A verified release whose `payloadDigest` covers `bytes`. */
export function job(releaseId = 'rel-b-7', target: SessionBinding = binding(), bytes = payload()): ReleasedJob {
  const event = {
    v: 1, roomId: 'room-1', eventId: 'event-a-7', authorParticipantId: 'agent-a', authorDeviceId: 'dev-a',
    contentDigest: digest('f'),
  };
  const approval = decodeApprovalCommand({
    v: 1, commandId: 'approve-1', roomId: 'room-1', bindingId: target.bindingId, expectedPolicyVersion: 3,
    expectedBindingGeneration: target.generation, selection: [event], issuedAt: '2026-09-18T00:00:00Z',
  }, limits);
  if (!approval.ok) throw new Error(`fixture approval: ${approval.field}`);
  const released = releaseFromApproval({
    approval: approval.value, items: approval.value.selection, binding: target, policyVersion: 3,
    release: { releaseId, payloadRef: 'ledger-1', payloadDigest: payloadDigest(bytes), causalRootId: 'event-a-7' },
  } as Parameters<typeof releaseFromApproval>[0]);
  if (!released.ok) throw new Error(`fixture release: ${released.code}`);
  return released.value;
}

type Entry = { id: string; clientUserMessageId: string; text: string };
type Turn = { id: string; status: TurnStatus; clientIds: (string | null)[] };
type Override = (params: Record<string, unknown>) => CodexRequestOutcome | undefined;

export class FakeAppServer implements CodexClientPort {
  threadId = 'session-b';
  status: ThreadStatus = 'idle';
  queue: Entry[] = [];
  turns: Turn[] = [];
  reachable = true;
  pageSize = 50;
  readonly calls: { method: CodexMethod; params: Record<string, unknown> }[] = [];
  readonly endpoints: CodexEndpoint[] = [];
  opened = 0;
  closed = 0;
  /** One-shot overrides, consumed in order per method. */
  readonly overrides = new Map<CodexMethod, Override[]>();
  private nextId = 1;

  override(method: CodexMethod, fn: Override): this {
    this.overrides.set(method, [...(this.overrides.get(method) ?? []), fn]);
    return this;
  }

  /** The executor starts a turn for the oldest queued entry, as KHA-104 observed. */
  consumeNext(status: TurnStatus = 'completed'): void {
    const entry = this.queue.shift();
    if (entry) this.turns.push({ id: `turn-${this.nextId++}`, status, clientIds: [entry.clientUserMessageId] });
  }

  adds(): number {
    return this.calls.filter(call => call.method === 'thread/queue/add').length;
  }

  async connect(endpoint: CodexEndpoint): Promise<CodexConnection | null> {
    this.endpoints.push(endpoint);
    if (!this.reachable) return null;
    this.opened++;
    return {
      request: async (method, params) => this.request(method, params as Record<string, unknown>),
      close: async () => { this.closed++; },
    };
  }

  private request(method: CodexMethod, params: Record<string, unknown>): CodexRequestOutcome {
    this.calls.push({ method, params });
    const override = this.overrides.get(method)?.shift();
    const forced = override?.(params);
    if (forced) return forced;
    if (params.threadId !== this.threadId) return { status: 'remote_error', code: -32600 };
    switch (method) {
      case 'thread/read':
        return { status: 'response', result: { thread: this.thread(params.includeTurns === true) } };
      case 'thread/queue/list': {
        const start = typeof params.cursor === 'string' ? Number(params.cursor) : 0;
        const data = this.queue.slice(start, start + this.pageSize)
          .map(({ id, clientUserMessageId, text }) => ({ id, clientUserMessageId, input: [{ type: 'text', text }] }));
        const next = start + this.pageSize;
        return { status: 'response', result: { data, nextCursor: next < this.queue.length ? String(next) : null } };
      }
      case 'thread/queue/add': {
        const input = params.input as { type: string; text: string }[];
        const entry = { id: `q-${this.nextId++}`, clientUserMessageId: String(params.clientUserMessageId), text: input[0]!.text };
        this.queue.push(entry);
        return { status: 'response', result: { queuedSubmission: { ...entry, input } } };
      }
    }
  }

  private thread(includeTurns: boolean) {
    return {
      id: this.threadId, cwd: '/scratch', status: this.status === 'active' ? { type: 'active', activeFlags: [] } : { type: this.status },
      turns: includeTurns
        ? this.turns.map(turn => ({
          id: turn.id, status: turn.status,
          items: [
            ...turn.clientIds.map((clientId, i) => ({ type: 'userMessage', id: `${turn.id}-u${i}`, clientId, content: [] })),
            { type: 'agentMessage', id: `${turn.id}-a`, text: 'reply' },
          ],
        }))
        : [],
    };
  }
}

export class FakeHosts implements CodexHostPort {
  host: CodexHost | null;
  constructor(overrides: Partial<CodexHost> = {}) {
    this.host = {
      binding: binding(), endpoint: { kind: 'unix', path: '/run/khala/codex/bind-b-1/exec.sock' },
      endpointPrivate: true, cliVersion: '0.154.0', holdsWriter: true, ...overrides,
    };
  }

  async lookup(): Promise<CodexHost | null> {
    return this.host;
  }
}

export class FakeCodec implements ReleaseCodecPort {
  verdict: Awaited<ReturnType<ReleaseCodecPort['verify']>> | 'throw' = 'ok';
  async verify() {
    if (this.verdict === 'throw') throw new Error('codec unavailable');
    return this.verdict;
  }
}

export const clock: Clock = { now: () => new Date('2026-09-18T10:00:00.000Z') };

export class RecordingSink implements EvidenceSink {
  readonly receipts: DeliveryReceipt[] = [];
  fail = false;
  async record(receipt: DeliveryReceipt): Promise<void> {
    if (this.fail) throw new Error('store offline');
    this.receipts.push(receipt);
  }
}

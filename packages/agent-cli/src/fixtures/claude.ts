import { vi } from 'vitest';
import {
  decodeHarnessCapabilities, decodeSessionBinding, unknownModeSupportMap,
  type AcknowledgementSupport, type HarnessCapabilities, type SessionBinding,
} from '@khala/contracts/delivery/index';
import type { InboxBatch } from '../cli/inbox.js';
import type { ReadInput, ReadResult } from '../composition/read.js';
import type {
  BatchTokenScope, ClaudeBindingServices, ClaudeInstallationAuthenticator, ClaudeSessionDirectory,
  ClaudeSessionStatePort, EnvelopeStep,
} from '../composition/claude-session.js';

export const CREDENTIAL_A = 'A'.repeat(43);
export const CREDENTIAL_B = 'B'.repeat(43);

export function binding(sessionId: string, bindingId: string, generation = 1, ownerId = 'owner-a'): SessionBinding {
  const decoded = decodeSessionBinding({
    v: 1, bindingId, ownerId, agentParticipantId: `agent-${bindingId}`, deviceId: 'device-1',
    harness: 'claude', sessionId, generation,
  });
  if (!decoded.ok) throw new Error('invalid binding fixture');
  return decoded.value;
}

export function capabilities(acknowledgement: AcknowledgementSupport = 'batch_token_next_call'): HarnessCapabilities {
  const decoded = decodeHarnessCapabilities({
    v: 3, harness: 'claude', version: '2.1.282', adapterVersion: 'claude-session-adapter-1', support: 'experimental',
    existingSession: 'unknown', immediateNotification: 'unknown', busy: 'unknown', receiptEvidence: [],
    reconcileByReleaseId: 'unknown', limits: { maxPayloadBytes: 65536, maxSelectionEvents: 32 }, evidenceRef: null,
    modes: unknownModeSupportMap('claude-interactive-hooks', 'Idle agents receive messages only at their next turn.', '2.1.282'),
    acknowledgement,
  });
  if (!decoded.ok) throw new Error(`invalid capabilities fixture: ${decoded.field}`);
  return decoded.value;
}

export function batch(token: string, text = '{"body":"hello"}'): InboxBatch {
  const payload = new TextEncoder().encode(text);
  return {
    token,
    items: [{
      record: {
        v: 1, releaseId: `release-${text.length}`, bindingId: 'binding-x', generation: 1, events: [],
        payloadDigest: `sha256:${'a'.repeat(64)}`, payloadBase64: Buffer.from(payload).toString('base64'),
        receivedAt: '2026-09-25T00:00:00Z',
      },
      payload,
      nextOffset: 1,
    }],
  } as unknown as InboxBatch;
}

/** Two principals: A owns sessions s-1 and s-2 (same cwd), B owns s-3. */
export const BINDINGS = {
  's-1': binding('s-1', 'binding-1'),
  's-2': binding('s-2', 'binding-2'),
  's-3': binding('s-3', 'binding-3', 1, 'owner-b'),
} as const;

export function authenticator(): ClaudeInstallationAuthenticator {
  return {
    authenticate: async credential => credential === CREDENTIAL_A ? { principalId: 'principal-a' }
      : credential === CREDENTIAL_B ? { principalId: 'principal-b' } : null,
  };
}

export function directory(overrides: Partial<Record<string, SessionBinding>> = {}): ClaudeSessionDirectory {
  const owned: Record<string, readonly string[]> = { 'principal-a': ['s-1', 's-2'], 'principal-b': ['s-3'] };
  return {
    resolve: async (principal, claim) => {
      if (!owned[principal.principalId]?.includes(claim.sessionId)) return null;
      return overrides[claim.sessionId] ?? BINDINGS[claim.sessionId as keyof typeof BINDINGS];
    },
  };
}

export type FakeRead = Readonly<{
  port: ClaudeBindingServices['read'];
  calls: ReadInput[];
  next: ReadResult[];
}>;

export function fakeRead(next: ReadResult[] = []): FakeRead {
  const calls: ReadInput[] = [];
  return {
    calls,
    next,
    port: { read: vi.fn(async (input: ReadInput): Promise<ReadResult> => { calls.push(input); return next.shift() ?? { kind: 'empty' }; }) },
  };
}

export type FakeServices = Readonly<{
  reads: Map<string, FakeRead>;
  sends: Array<Readonly<{ bindingId: string; acknowledgeToken?: string }>>;
  modeSets: Array<Readonly<{ bindingId: string; acknowledgeToken?: string }>>;
  pending: { value: boolean };
  capabilities: { value: HarnessCapabilities };
  services(binding: SessionBinding): ClaudeBindingServices;
}>;

export function fakeServices(): FakeServices {
  const reads = new Map<string, FakeRead>();
  const sends: FakeServices['sends'] = [];
  const modeSets: FakeServices['modeSets'] = [];
  const pending = { value: false };
  const caps = { value: capabilities() };
  return {
    reads, sends, modeSets, pending, capabilities: caps,
    services(bound) {
      if (!reads.has(bound.bindingId)) reads.set(bound.bindingId, fakeRead());
      return {
        read: reads.get(bound.bindingId)!.port,
        async send(input) {
          sends.push({ bindingId: bound.bindingId, ...(input.acknowledgeToken === undefined ? {} : { acknowledgeToken: input.acknowledgeToken }) });
          return { value: { kind: 'accepted', clientTxnId: 'txn-12345678', eventId: 'event-1' }, batchToken: null };
        },
        async setMode(input) {
          modeSets.push({ bindingId: bound.bindingId, ...(input.acknowledgeToken === undefined ? {} : { acknowledgeToken: input.acknowledgeToken }) });
          return {
            value: {
              v: 1, commandId: input.commandId, bindingId: bound.bindingId, generation: bound.generation, outcome: 'applied',
              version: input.expectedVersion + 1, requested: input.requested, effective: null, reason: null,
            } as never,
            batchToken: null,
          };
        },
        readMode: async () => ({
          ok: true,
          view: { requested: 'sync', effective: null, version: 1 } as never,
        }),
        capabilities: async () => caps.value,
        pending: async () => ({ pending: pending.value }),
      };
    },
  };
}

/** An in-memory state port with the same linearization contract, for adapter tests. */
export function memoryState(): ClaudeSessionStatePort & { tokens: Map<string, string> } {
  const tokens = new Map<string, string>();
  let tail: Promise<unknown> = Promise.resolve();
  const key = (scope: BatchTokenScope) => JSON.stringify([scope.principalId, scope.bindingId, scope.generation]);
  return {
    tokens,
    envelope<T>(scope: BatchTokenScope, call: (retained: string | undefined) => Promise<EnvelopeStep<T>>) {
      const run = async () => {
        const retained = tokens.get(key(scope));
        tokens.delete(key(scope));
        const step = await call(retained);
        if (step.batchToken !== null) tokens.set(key(scope), step.batchToken);
        return step.value;
      };
      const next = tail.then(run, run);
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

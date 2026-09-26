import { vi } from 'vitest';
import {
  decodeHarnessCapabilities, decodeSessionBinding, unknownModeSupportMap,
  type AcknowledgementSupport, type HarnessCapabilities, type ListeningMode, type SessionBinding,
} from '@khala/contracts/delivery/index';
import { CliError } from '../cli/errors.js';
import type { InboxBatch } from '../cli/inbox.js';
import type { ReadInput, ReadResult } from '../composition/read.js';
import {
  nextRetained, type ClaudeBindingServices, type ClaudeInstallationAuthenticator, type ClaudeSessionDirectory,
  type ClaudeSessionStatePort, type EnvelopeStep, type RetainedToken, type SessionScope,
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
  /** The fence's idle-watcher window. */
  watch: { value: Readonly<{ seconds: number }> | null };
  /** The raw `listAgents` port result `roster` reports; `rosterCalls` records the binding each call served. */
  roster: { value: unknown };
  rosterCalls: string[];
  /** The effective mode `readMode` reports. */
  mode: { value: ListeningMode | null };
  /**
   * The versioned mode record behind `readMode` and `setMode`: a set applies only at the
   * current version and is otherwise a conflict, as the listening-mode store does.
   * `effectiveReason` is what the store derives while nothing is effective.
   */
  modeRecord: { requested: ListeningMode | null; version: number; effectiveReason: string | null };
  /** Every mode command the agent's calls reached, as issued. */
  modeCommands: Array<Readonly<{ bindingId: string; commandId: string; expectedVersion: number; requested: ListeningMode; issuedAt: string }>>;
  /** Piggyback batches the next send or mode-set calls select, in order. */
  piggyback: Array<InboxBatch | null>;
  services(binding: SessionBinding): ClaudeBindingServices;
}>;

export function fakeServices(): FakeServices {
  const reads = new Map<string, FakeRead>();
  const sends: FakeServices['sends'] = [];
  const modeSets: FakeServices['modeSets'] = [];
  const pending = { value: false };
  const caps = { value: capabilities() };
  const watch: FakeServices['watch'] = { value: { seconds: 3000 } };
  const roster: FakeServices['roster'] = { value: { kind: 'listed', roster: { v: 1, agents: [] } } };
  const rosterCalls: string[] = [];
  const mode: FakeServices['mode'] = { value: null };
  const modeRecord: FakeServices['modeRecord'] = { requested: 'sync', version: 1, effectiveReason: 'support_unknown' };
  const modeCommands: FakeServices['modeCommands'] = [];
  const piggyback: Array<InboxBatch | null> = [];
  return {
    reads, sends, modeSets, pending, capabilities: caps, watch, roster, rosterCalls, mode, modeRecord, modeCommands, piggyback,
    services(bound) {
      if (!reads.has(bound.bindingId)) reads.set(bound.bindingId, fakeRead());
      return {
        read: reads.get(bound.bindingId)!.port,
        async send(input) {
          sends.push({ bindingId: bound.bindingId, ...(input.acknowledgeToken === undefined ? {} : { acknowledgeToken: input.acknowledgeToken }) });
          return { value: { kind: 'accepted', clientTxnId: 'txn-12345678', eventId: 'event-1' }, batch: piggyback.shift() ?? null };
        },
        async setMode(input) {
          modeSets.push({ bindingId: bound.bindingId, ...(input.acknowledgeToken === undefined ? {} : { acknowledgeToken: input.acknowledgeToken }) });
          modeCommands.push({
            bindingId: bound.bindingId, commandId: input.commandId, expectedVersion: input.expectedVersion, requested: input.requested, issuedAt: input.issuedAt,
          });
          const applied = input.expectedVersion === modeRecord.version;
          if (applied) Object.assign(modeRecord, { requested: input.requested, version: modeRecord.version + 1 });
          return {
            value: {
              v: 1, commandId: input.commandId, bindingId: bound.bindingId, generation: bound.generation, outcome: applied ? 'applied' : 'conflict',
              version: modeRecord.version, requested: modeRecord.requested, effective: mode.value,
              reason: mode.value === null ? modeRecord.effectiveReason : null,
            } as never,
            batch: piggyback.shift() ?? null,
          };
        },
        readMode: async () => ({
          ok: true,
          view: {
            requested: modeRecord.requested, effective: mode.value, version: modeRecord.version,
            effectiveReason: mode.value === null ? modeRecord.effectiveReason : null,
          } as never,
        }),
        capabilities: async () => caps.value,
        pending: async () => ({ pending: pending.value }),
        watchWindow: async () => watch.value,
        roster: async () => { rosterCalls.push(bound.bindingId); return roster.value; },
      };
    },
  };
}

/** An in-memory state port with the same linearization and commit contract, for adapter tests. */
export function memoryState(): ClaudeSessionStatePort & { tokens: Map<string, readonly RetainedToken[]>; key(scope: SessionScope): string } {
  const tokens = new Map<string, readonly RetainedToken[]>();
  let tail: Promise<unknown> = Promise.resolve();
  const key = (scope: SessionScope) => JSON.stringify([scope.principalId, scope.bindingId]);
  return {
    tokens,
    key,
    envelope<T>(scope: SessionScope, call: (retained: readonly RetainedToken[]) => Promise<EnvelopeStep<T>>) {
      const run = async () => {
        const retained = tokens.get(key(scope)) ?? [];
        const step = await call(retained);
        const next = nextRetained(retained, step);
        if (next.length === 0) tokens.delete(key(scope)); else tokens.set(key(scope), next);
        return step.value;
      };
      const next = tail.then(run, run);
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

export type AcknowledgementOutcome = 'recorded' | 'duplicate' | 'stale_generation';

/**
 * Models the shared inbox's batch-token contract for one binding: at most one
 * outstanding batch per generation, replayed until acknowledged; a replaced
 * generation fences its token and requeues its release; a replayed acknowledgement
 * is `duplicate`. `log` is every acknowledgement the inbox saw, in order.
 */
export function fakeInbox(bodies: readonly string[]) {
  const queue = [...bodies];
  const acknowledged = new Set<string>();
  const log: Array<Readonly<{ token: string; outcome: AcknowledgementOutcome }>> = [];
  const calls: Array<ReadInput & { generation: number }> = [];
  let generation = 1;
  let issued = 0;
  let outstanding: { token: string; body: string } | null = null;

  function acknowledge(bound: number, token: string): void {
    if (bound !== generation) {
      log.push({ token, outcome: 'stale_generation' });
      throw new CliError('binding_not_held');
    }
    if (acknowledged.has(token)) { log.push({ token, outcome: 'duplicate' }); return; }
    if (outstanding?.token !== token) return;
    acknowledged.add(token);
    outstanding = null;
    log.push({ token, outcome: 'recorded' });
  }

  return {
    log,
    calls,
    get generation() { return generation; },
    /** The session was replaced: a new generation, and the unacknowledged release requeues. */
    replace() {
      generation += 1;
      if (outstanding !== null) queue.unshift(outstanding.body);
      outstanding = null;
    },
    acknowledge,
    port(bound: number): ClaudeBindingServices['read'] {
      return {
        read: async input => {
          calls.push({ ...input, generation: bound });
          if (input.acknowledgeToken !== undefined) acknowledge(bound, input.acknowledgeToken);
          if (bound !== generation) throw new CliError('binding_not_held');
          if (outstanding === null) {
            const body = queue.shift();
            if (body === undefined) return { kind: 'empty' };
            issued += 1;
            outstanding = { token: `fresh-token-${issued}`, body };
          }
          return { kind: 'batch', batch: batch(outstanding.token, outstanding.body) };
        },
      };
    },
  };
}

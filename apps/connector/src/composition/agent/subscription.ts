import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import { startSubscription, type SubscriptionHandle } from '@khala/connector/subscription/index';
import type { SubscriptionSource } from '@khala/connector/subscription/adapter';
import type { HostedSubscriptionDiagnostic } from '@khala/connector/subscription/diagnostic';
import type { ConnectorStorage } from '@khala/connector/storage/open';
import type { MatrixConnectorSubstrate } from '../../substrate/matrix';

type Guard = Readonly<{ kind: 'active' }> | Readonly<{
  kind: 'unavailable' | 'revoked';
  stage: 'local_guard' | 'mailbox_guard' | 'owner_device_guard';
}>;

/** Keeps source and owner-authority failures distinct without carrying room or event data. */
export function productionSubscriptionSource(input: Readonly<{
  matrix: Pick<MatrixConnectorSubstrate, 'source'>;
  guard(): Promise<Guard>;
  diagnostic?(event: HostedSubscriptionDiagnostic): void;
}>): SubscriptionSource {
  const report = (stage: HostedSubscriptionDiagnostic['stage'], result: HostedSubscriptionDiagnostic['result']) => {
    try { input.diagnostic?.({ stage, result }); } catch { /* Diagnostics cannot change intake. */ }
  };
  const guard = async () => {
    try { return await input.guard(); }
    catch (error) { report('guard_exception', 'unavailable'); throw error; }
  };
  return {
    async authorize(options) {
      const authority = await guard();
      if (authority.kind !== 'active') {
        report(authority.stage, authority.kind);
        return authority.kind === 'revoked' ? 'revoked' : 'unavailable';
      }
      try {
        const result = await input.matrix.source.authorize(options);
        if (result !== 'ok') report('matrix_authorize', result);
        return result;
      } catch (error) { report('matrix_authorize', 'unavailable'); throw error; }
    },
    listen(listener) {
      try { return input.matrix.source.listen({ hint: listener.hint,
        lost: () => { report('matrix_lost', 'unavailable'); listener.lost(); } }); }
      catch (error) { report('matrix_lost', 'unavailable'); throw error; }
    },
    async read(page, options) {
      const authority = await guard();
      if (authority.kind !== 'active') {
        report(authority.stage, authority.kind);
        return authority.kind === 'revoked' ? { kind: 'rejected' as const, code: 'authority_lost' as const }
          : { kind: 'unavailable' as const };
      }
      try {
        const result = await input.matrix.source.read(page, options);
        if (result.kind !== 'page') report('matrix_read', result.kind === 'unavailable' ? 'unavailable'
          : result.kind === 'gap' ? 'gap' : 'rejected');
        return result;
      } catch (error) { report('matrix_read', 'unavailable'); throw error; }
    },
  };
}

/**
 * Adapts the endpoint's authenticated Matrix cursor to the same durable ledger
 * used by owner review. A cursor never advances until all earlier plaintext or
 * unavailable placeholders are committed. No event is sent to a model here.
 */
export async function startProductionSubscription(input: Readonly<{
  binding: SessionBinding;
  roomId: RoomId;
  ownerParticipantId: ParticipantId;
  storage: ConnectorStorage;
  matrix: MatrixConnectorSubstrate;
  /** Server-checked current binding, owner membership and closure marker. */
  guard(): Promise<Guard>;
  diagnostic?(event: HostedSubscriptionDiagnostic): void;
  clock?: () => number;
}>): Promise<SubscriptionHandle> {
  let locked = false;
  const clock = input.clock ?? Date.now;
  const streamId = `matrix:${input.roomId}:${input.binding.deviceId}`;
  return startSubscription({ binding: input.binding, streamId, pageSize: 50 }, {
    source: productionSubscriptionSource(input),
    cursors: {
      async load(id) {
        try {
          const stored = await input.storage.readCursor(id);
          return { kind: 'loaded' as const, cursor: stored?.opaqueCursor ?? null, revision: stored?.revision ?? 0 };
        } catch { return { kind: 'failed' as const }; }
      },
      async commit(command) {
        try {
          const result = await input.storage.commitCursor(command);
          return result.kind === 'committed' ? { kind: 'committed' as const, revision: result.revision }
            : result.kind === 'conflict' ? { kind: 'conflict' as const } : { kind: 'failed' as const };
        } catch { return { kind: 'failed' as const }; }
      },
    },
    ingestion: {
      async accept({ binding, event, canonicalPayload }) {
        try {
          const result = await input.storage.persistPending({
            key: { roomId: event.roomId, eventId: event.eventId,
              recipientBindingId: binding.bindingId, recipientGeneration: binding.generation },
            event, plaintext: canonicalPayload, receivedAt: new Date(clock()).toISOString(), streamId,
          });
          if (result.kind === 'inserted' || result.kind === 'replaced') return 'stored';
          if (result.kind === 'duplicate' || result.kind === 'conflict_resolved') return 'duplicate';
          return 'blocked';
        } catch { return 'blocked'; }
      },
      async acceptUnavailable({ binding, ref, reason }) {
        try {
          const result = await input.storage.persistUnavailable({
            key: { roomId: ref.roomId, eventId: ref.eventId,
              recipientBindingId: binding.bindingId, recipientGeneration: binding.generation },
            ref, reason, receivedAt: new Date(clock()).toISOString(), streamId,
          });
          if (result.kind === 'inserted') return 'stored';
          if (result.kind === 'duplicate' || result.kind === 'conflict_resolved') return 'duplicate';
          return 'blocked';
        } catch { return 'blocked'; }
      },
    },
    provenance: {
      async participantForDevice({ roomId, deviceId }) {
        // The Matrix adapter emits decrypted events only from a crypto-verified
        // device belonging to the configured owner user. It filters the agent's
        // own sends before they enter this pipeline. Check the exact room here.
        if (roomId !== input.roomId || deviceId === input.binding.deviceId) return null;
        return input.ownerParticipantId;
      },
    },
    lock: {
      async acquire() {
        if (locked) return { kind: 'busy' as const };
        locked = true;
        return { kind: 'held' as const, release: async () => { locked = false; } };
      },
    },
    scheduler: {
      now: clock,
      setTimer(delayMs, run) { const timer = setTimeout(run, delayMs); return () => clearTimeout(timer); },
    },
    random: Math.random,
  });
}

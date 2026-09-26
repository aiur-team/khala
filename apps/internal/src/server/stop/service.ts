// Stop revokes a channel's agent bindings and ends Khala delivery to them. It
// never starts, signals, interrupts or waits on an agent CLI process: the user's
// CLI keeps running, and so do this server, the channel timeline and the
// browser view (executor decision 36). An agent reconnects only through the
// ordinary channel access request and a new human grant.
//
// Order per binding: bar it (no new commit can start), drop its live capability
// (no new request authenticates), wait for effects that were already committing,
// then revoke it durably. Only after that is the runtime descriptor's grant
// cleared and success reported. Any step that fails leaves the binding named in
// `remaining`; the barrier stays raised, so it still cannot commit.

import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { BindingKey, RevocationBarrier } from './barrier';

export type StopBindingView = Readonly<{
  bindingId: string;
  generation: number;
  harness: string;
  agentParticipantId: string;
}>;

/** One binding generation scoped to the channel, with its durable state. */
export type StopCandidate = Readonly<{
  binding: SessionBinding;
  status: 'active' | 'revoked';
  /** True when this is the newest registered generation of its binding ID. */
  latest: boolean;
}>;

/** An exact recorded target: one binding generation and the agent participant it was recorded for. */
export type StopTarget = BindingKey & Readonly<{ agentParticipantId: string }>;

export type StopRemainingReason = 'revoke_failed' | 'descriptor_pending';

export type StopResult =
  | Readonly<{ kind: 'stopped'; stopped: readonly StopBindingView[] }>
  | Readonly<{
    kind: 'partial';
    stopped: readonly StopBindingView[];
    remaining: readonly (StopBindingView & Readonly<{ reason: StopRemainingReason }>)[];
  }>
  | Readonly<{ kind: 'rejected'; code: 'stale_target' | 'participant_mismatch' }>
  | Readonly<{ kind: 'unavailable' }>;

export type GrantClearing = 'cleared' | 'absent' | 'failed';

export type BindingStopPorts = Readonly<{
  barrier: RevocationBarrier;
  /** Every binding generation scoped to the channel, or `unavailable` when the store cannot say. */
  candidates(channelId: string): readonly StopCandidate[] | 'unavailable';
  /** Durable revocation; `failed` when the write did not definitely commit. */
  revoke(key: BindingKey): 'revoked' | 'failed';
  /** Removes the binding's live capability from the running server. */
  dropCapability(key: BindingKey): void;
  /** Removes granted binding fields from the runtime descriptor when they name one of `bindingIds`. */
  clearGrant?(bindingIds: ReadonlySet<string>): GrantClearing;
}>;

export type BindingStopService = Readonly<{
  /** `targets: null` stops every active binding of the channel. */
  stop(channelId: string, targets: readonly StopTarget[] | null): Promise<StopResult>;
}>;

function view(binding: SessionBinding): StopBindingView {
  return {
    bindingId: binding.bindingId,
    generation: binding.generation,
    harness: binding.harness,
    agentParticipantId: binding.agentParticipantId,
  };
}

export function createBindingStopService(ports: BindingStopPorts): BindingStopService {
  // Stops of one channel run one at a time; a retry never interleaves with the first attempt.
  const queues = new Map<string, Promise<unknown>>();

  async function stopNow(channelId: string, targets: readonly StopTarget[] | null): Promise<StopResult> {
    let candidates: readonly StopCandidate[] | 'unavailable';
    try {
      candidates = ports.candidates(channelId);
    } catch {
      candidates = 'unavailable';
    }
    if (candidates === 'unavailable') return { kind: 'unavailable' };

    let selected = candidates;
    if (targets !== null) {
      // A recorded target must still be the newest generation of a binding in this channel, held by the
      // same agent participant. Every target is checked before anything is barred or revoked.
      const matched: StopCandidate[] = [];
      for (const target of targets) {
        const found = candidates.find(candidate => candidate.binding.bindingId === target.bindingId
          && candidate.binding.generation === target.generation);
        if (!found || !found.latest) return { kind: 'rejected', code: 'stale_target' };
        if (found.binding.agentParticipantId !== target.agentParticipantId) {
          return { kind: 'rejected', code: 'participant_mismatch' };
        }
        matched.push(found);
      }
      selected = matched;
    }
    // A binding already barred by an earlier partial Stop is retried even when its row still reads active.
    const active = selected.filter(candidate => candidate.status === 'active');

    for (const { binding } of active) {
      ports.barrier.raise(binding);
      ports.dropCapability(binding);
    }
    await Promise.all(active.map(({ binding }) => ports.barrier.drain(binding)));

    const stopped: StopBindingView[] = [];
    const remaining: (StopBindingView & Readonly<{ reason: StopRemainingReason }>)[] = [];
    for (const { binding } of active) {
      let outcome: 'revoked' | 'failed';
      try {
        outcome = ports.revoke(binding);
      } catch {
        outcome = 'failed';
      }
      if (outcome === 'revoked') stopped.push(view(binding));
      else remaining.push({ ...view(binding), reason: 'revoke_failed' });
    }

    if (ports.clearGrant) {
      // Every binding of the channel that is no longer active loses its descriptor grant.
      const failedIds = new Set(remaining.map(entry => entry.bindingId));
      const cleared = new Set(selected.map(candidate => candidate.binding.bindingId).filter(id => !failedIds.has(id)));
      let clearing: GrantClearing;
      try {
        clearing = cleared.size === 0 ? 'absent' : ports.clearGrant(cleared);
      } catch {
        clearing = 'failed';
      }
      if (clearing === 'failed') {
        // Revoked, but a descriptor may still carry its capability: never reported as stopped.
        for (const candidate of selected) {
          if (cleared.has(candidate.binding.bindingId) && candidate.latest) {
            remaining.push({ ...view(candidate.binding), reason: 'descriptor_pending' });
          }
        }
        const pending = new Set(remaining.map(entry => entry.bindingId));
        if (pending.size === 0) return { kind: 'unavailable' };
        return { kind: 'partial', stopped: stopped.filter(entry => !pending.has(entry.bindingId)), remaining };
      }
    }

    return remaining.length === 0 ? { kind: 'stopped', stopped } : { kind: 'partial', stopped, remaining };
  }

  return {
    stop(channelId, targets) {
      const previous = queues.get(channelId) ?? Promise.resolve();
      const next = previous.then(() => stopNow(channelId, targets), () => stopNow(channelId, targets));
      queues.set(channelId, next);
      void next.finally(() => {
        if (queues.get(channelId) === next) queues.delete(channelId);
      });
      return next;
    },
  };
}

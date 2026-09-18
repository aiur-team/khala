// U3: map native Codex observations to KHA-106 receipts. Each receipt is one
// independently observed fact with a stable ID; nothing is inferred from a socket
// write, a token counter or generated text.

import { createHash } from 'node:crypto';
import type {
  DeliveryReceipt, ReceiptErrorCode, ReceiptId, ReceiptKind, ReleasedJob, ReleaseId, SessionBinding,
} from '@khala/contracts/delivery/index';
import { isRecord } from './native';

export interface Clock {
  now(): Date;
}

/** Durable store for intermediate observations; KHA-115 owns the implementation. */
export interface EvidenceSink {
  record(receipt: DeliveryReceipt): Promise<void>;
}

/** Native fact each harness-sourced receipt kind is backed by. */
export const EVIDENCE = {
  queued: 'codex:thread/queue/add.queuedSubmission.clientUserMessageId',
  listed: 'codex:thread/queue/list.clientUserMessageId',
  consumed: 'codex:userMessage.clientId',
  completed: 'codex:turn/completed',
} as const;

type Target = Readonly<{ releaseId: ReleaseId; binding: SessionBinding }>;

/**
 * Same release and kind give the same ID, so a repeated observation deduplicates
 * downstream. The release ID is hashed to stay within the identifier limit.
 */
export function receiptIdFor(releaseId: ReleaseId, kind: ReceiptKind): ReceiptId {
  const digest = createHash('sha256').update(releaseId).digest('hex').slice(0, 32);
  return `codex-${kind}-${digest}` as ReceiptId;
}

export function makeReceipt(
  target: Target,
  kind: ReceiptKind,
  clock: Clock,
  detail: Readonly<{ source: 'connector' | 'harness'; evidenceRef?: string; errorCode?: ReceiptErrorCode }>,
): DeliveryReceipt {
  return {
    v: 1,
    receiptId: receiptIdFor(target.releaseId, kind),
    releaseId: target.releaseId,
    bindingId: target.binding.bindingId,
    generation: target.binding.generation,
    kind,
    observedAt: clock.now().toISOString(),
    source: detail.source,
    evidenceRef: detail.evidenceRef ?? null,
    errorCode: detail.errorCode ?? null,
  };
}

/** Records without letting a sink failure change the delivery outcome. */
export async function recordQuietly(sink: EvidenceSink, receipt: DeliveryReceipt): Promise<void> {
  try {
    await sink.record(receipt);
  } catch {
    // The returned receipt remains authoritative; a lost intermediate record is not a
    // reason to report failure after a possible native acceptance.
  }
}

export type NativeNotification = Readonly<{ method: string; params?: unknown }>;

export interface CodexReceiptTracker {
  /** Starts correlating native events for a submitted release. */
  track(job: ReleasedJob): void;
  /** Maps one native notification to zero or more new receipts. */
  observe(notification: NativeNotification): readonly DeliveryReceipt[];
}

/**
 * Correlates notifications from a connection on the host's listener. Consumption is
 * the `userMessage` item whose `clientId` is a tracked release ID; completion is the
 * `turn/completed` of that item's turn with status `completed`. Duplicate and
 * out-of-order notifications yield each receipt at most once. Other threads, untracked
 * client IDs and session exits yield nothing: a pending release stays for `reconcile`.
 */
export function createCodexReceiptTracker(binding: SessionBinding, clock: Clock): CodexReceiptTracker {
  const tracked = new Map<string, Target>();
  const turnRelease = new Map<string, string>();
  const completedTurns = new Set<string>();
  const emitted = new Set<string>();

  const emit = (out: DeliveryReceipt[], releaseId: string, kind: ReceiptKind, evidenceRef: string) => {
    const target = tracked.get(releaseId);
    if (!target) return;
    const receipt = makeReceipt(target, kind, clock, { source: 'harness', evidenceRef });
    if (emitted.has(receipt.receiptId)) return;
    emitted.add(receipt.receiptId);
    out.push(receipt);
  };

  return {
    track(job) {
      tracked.set(job.releaseId, { releaseId: job.releaseId, binding: job.binding });
    },
    observe({ method, params }) {
      const out: DeliveryReceipt[] = [];
      if (!isRecord(params) || params.threadId !== binding.sessionId) return out;
      if (method === 'item/started' || method === 'item/completed') {
        const { item, turnId } = params;
        if (!isRecord(item) || item.type !== 'userMessage' || typeof item.clientId !== 'string') return out;
        if (typeof turnId !== 'string' || !tracked.has(item.clientId)) return out;
        turnRelease.set(turnId, item.clientId);
        emit(out, item.clientId, 'context_consumed', EVIDENCE.consumed);
        if (completedTurns.has(turnId)) emit(out, item.clientId, 'completed', EVIDENCE.completed);
      } else if (method === 'turn/completed') {
        const turn = params.turn;
        if (!isRecord(turn) || typeof turn.id !== 'string' || turn.status !== 'completed') return out;
        completedTurns.add(turn.id);
        const releaseId = turnRelease.get(turn.id);
        if (releaseId !== undefined) emit(out, releaseId, 'completed', EVIDENCE.completed);
      }
      return out;
    },
  };
}

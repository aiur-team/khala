import {
  CHANNEL_ACCESS_REQUEST_LIFETIME_MS,
  type ChannelAccessDecisionRejection,
  type ChannelAccessMuteResult,
  type ChannelAccessNotification,
  type ChannelAccessOwnerOutcome,
  type ChannelAccessOwnerProjection,
  type ChannelAccessRequestHandle,
  type OperationResult,
  type OwnerId,
} from '@khala/contracts/messaging/index';
import type { ChannelAccessInboxPort, MuteRejection } from './ports';

/**
 * In-memory owner journal for tests and the browser harness only. It mirrors
 * the `channel-access-journal` rules the inbox depends on: a repeated decision
 * operation ID is answered idempotently before the revision check, decisions
 * and mutes are revision-checked, access mutes are requester/channel scoped
 * and need current channel ownership, creation mutes are requester/owner
 * scoped, a muted requester creates no row or notification, and only the
 * human owner's cookie authority can read or decide.
 */
export type FakeRequestInput = Readonly<{
  kind: 'access' | 'create';
  /** Channel title for access; the agent's proposed title for creation. */
  title: string;
  /** Any string; the fake derives a valid 43-character fingerprint from it. */
  fingerprint: string;
  harness?: string;
  displayLabel?: string | null;
  workspaceLabel?: string | null;
}>;

/** Who the fake thinks is calling. Only `owner` holds human-cookie authority for these requests. */
export type FakeCaller = 'owner' | 'other_owner' | 'binding_capability' | 'discovery_capability';

type Row = {
  handle: ChannelAccessRequestHandle;
  input: FakeRequestInput;
  fingerprint: string;
  outcome: ChannelAccessOwnerOutcome;
  revision: number;
  createdAt: number;
  deadline: number;
  ownerDecision: 'pending' | 'approved' | 'denied';
  decidedAt: number | null;
  decisionOperation: string | null;
};

type Mute = { muted: boolean; revision: number; operationId: string; action: 'mute' | 'unmute' };

export type FakeJournal = {
  port: ChannelAccessInboxPort;
  /** An agent submits a request. Returns null when a mute suppressed it. */
  submit(input: FakeRequestInput): ChannelAccessRequestHandle | null;
  /** The downstream connector moves an approved request along. */
  advance(handle: string, outcome: 'connecting' | 'connected' | 'repair_required' | 'revoked'): void;
  /** Another window decides a request. */
  decideElsewhere(handle: string, decision: 'approve' | 'deny'): void;
  /** Another window changes a request, bumping its revision. */
  bumpRevision(handle: string): void;
  /** The owner loses the access channel named `title`; access mutes for it become forbidden. */
  loseChannel(title: string): void;
  setCaller(caller: FakeCaller): void;
  advanceClock(ms: number): void;
  now(): number;
  /** Publishes a batch notification for `count` requests. */
  publishBatch(count: number): void;
  isMuted(kind: 'access' | 'create', fingerprint: string, title?: string): boolean;
  rows(): readonly ChannelAccessOwnerProjection[];
  calls: { decide: number; setMute: number; inbox: number };
  /** Results that replace the next call's outcome, per method. */
  failNext: { decide: Array<'unavailable' | 'unknown_after_commit' | ChannelAccessDecisionRejection>; setMute: Array<'unavailable' | 'unknown_after_commit' | MuteRejection>; inbox: Array<'unavailable'> };
};

export const FAKE_OWNER_ID = 'owner-a' as OwnerId;
export const FAKE_START = Date.parse('2026-09-25T12:00:00Z');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Deterministic 43-character base64url-shaped token for fixtures. */
export function fixtureDigest(seed: string): string {
  let hash = 2166136261;
  let out = '';
  for (let index = 0; out.length < 43; index += 1) {
    hash ^= seed.charCodeAt(index % Math.max(seed.length, 1)) + index;
    hash = Math.imul(hash, 16777619) >>> 0;
    out += ALPHABET[hash % 64];
  }
  return out;
}

const iso = (ms: number): string => new Date(ms).toISOString();
/** The journal's revision format (`carev_<n>`), used for rows, mutes, and notifications alike. */
const rev = (n: number): string => `carev_${n}`;

export function createFakeJournal(options: Readonly<{ delayMs?: number; start?: number }> = {}): FakeJournal {
  let clock = options.start ?? FAKE_START;
  let caller: FakeCaller = 'owner';
  let sequence = 0;
  let notificationSequence = 0;
  const rows = new Map<string, Row>();
  const mutes = new Map<string, Mute>();
  const lostChannels = new Set<string>();
  const listeners = new Set<(notification: unknown) => void>();
  const calls: FakeJournal['calls'] = { decide: 0, setMute: 0, inbox: 0 };
  const failNext: FakeJournal['failNext'] = { decide: [], setMute: [], inbox: [] };
  const delay = () => (options.delayMs ? new Promise(resolve => setTimeout(resolve, options.delayMs)) : Promise.resolve());

  function muteKey(row: Pick<Row, 'fingerprint'> & { input: Pick<FakeRequestInput, 'kind' | 'title'> }): string {
    return row.input.kind === 'access' ? `access:${row.fingerprint}:${row.input.title}` : `create:${row.fingerprint}:${FAKE_OWNER_ID}`;
  }

  function expire(): void {
    for (const row of rows.values()) {
      if ((row.outcome === 'pending_owner' || row.outcome === 'approved') && clock >= row.deadline) {
        row.outcome = 'expired';
        row.revision += 1;
      }
    }
  }

  function project(row: Row): ChannelAccessOwnerProjection {
    const mute = mutes.get(muteKey(row));
    const common = {
      v: 1 as const,
      requestHandle: row.handle,
      outcome: row.outcome,
      revision: rev(row.revision),
      requester: {
        sessionFingerprint: row.fingerprint,
        harness: row.input.harness ?? 'claude-code',
        displayLabel: row.input.displayLabel ?? null,
        workspaceLabel: row.input.workspaceLabel ?? null,
      },
      createdAt: iso(row.createdAt),
      deadline: iso(row.deadline),
      ownerDecision: row.ownerDecision,
      decidedAt: row.decidedAt === null ? null : iso(row.decidedAt),
      muted: mute?.muted ?? false,
      muteRevision: mute ? rev(mute.revision) : null,
    };
    return row.input.kind === 'access'
      ? { ...common, operationKind: 'access', detail: { kind: 'access', title: row.input.title, history: 'none' } }
      : { ...common, operationKind: 'create', detail: { kind: 'create', proposedTitle: row.input.title } };
  }

  function publish(notification: ChannelAccessNotification): void {
    for (const listener of listeners) listener(notification);
  }

  function applyDecision(row: Row, decision: 'approve' | 'deny', operationId: string): void {
    row.ownerDecision = decision === 'approve' ? 'approved' : 'denied';
    row.outcome = decision === 'approve' ? 'approved' : 'denied';
    row.decidedAt = clock;
    row.revision += 1;
    row.decisionOperation = operationId;
  }

  const authorized = () => caller === 'owner';

  const port: ChannelAccessInboxPort = {
    async inbox() {
      calls.inbox += 1;
      await delay();
      if (failNext.inbox.shift()) return { kind: 'unavailable', retryable: true };
      if (!authorized()) return { kind: 'rejected', code: 'forbidden' };
      expire();
      return { kind: 'ok', value: [...rows.values()].map(project) };
    },

    async decide(input): Promise<OperationResult<unknown, ChannelAccessDecisionRejection>> {
      calls.decide += 1;
      await delay();
      const failure = failNext.decide.shift();
      const row = rows.get(input.requestHandle);
      if (failure === 'unavailable') return { kind: 'unavailable', retryable: true };
      if (failure === 'unknown_after_commit') {
        // The journal records the decision, but the response is lost.
        if (row && row.outcome === 'pending_owner' && rev(row.revision) === input.expectedRevision) applyDecision(row, input.decision, input.operationId);
        return { kind: 'unavailable', retryable: true };
      }
      if (failure) return { kind: 'rejected', code: failure };
      if (!authorized()) return { kind: 'rejected', code: 'forbidden' };
      if (!row) return { kind: 'rejected', code: 'not_found' };
      expire();
      if (row.decisionOperation === input.operationId) {
        const same = row.ownerDecision === (input.decision === 'approve' ? 'approved' : 'denied');
        return same ? { kind: 'ok', value: project(row) } : { kind: 'rejected', code: 'decision_conflict' };
      }
      if (row.outcome === 'expired') return { kind: 'rejected', code: 'expired' };
      if (row.outcome === 'revoked') return { kind: 'rejected', code: 'revoked' };
      if (rev(row.revision) !== input.expectedRevision) return { kind: 'rejected', code: 'stale_revision' };
      if (row.outcome !== 'pending_owner') return { kind: 'rejected', code: 'decision_conflict' };
      applyDecision(row, input.decision, input.operationId);
      return { kind: 'ok', value: project(row) };
    },

    async setMute(input): Promise<OperationResult<ChannelAccessMuteResult, MuteRejection>> {
      calls.setMute += 1;
      await delay();
      const failure = failNext.setMute.shift();
      if (failure === 'unavailable') return { kind: 'unavailable', retryable: true };
      if (failure && failure !== 'unknown_after_commit') return { kind: 'rejected', code: failure };
      if (!authorized()) return { kind: 'rejected', code: 'forbidden' };
      const row = rows.get(input.requestHandle);
      if (!row) return { kind: 'rejected', code: 'not_found' };
      if (row.input.kind === 'access' && lostChannels.has(row.input.title)) return { kind: 'rejected', code: 'forbidden' };
      const key = muteKey(row);
      const current = mutes.get(key);
      if (current?.operationId === input.operationId) {
        return current.action === input.action
          ? { kind: 'ok', value: { v: 1, operationKind: row.input.kind, muted: current.muted, revision: rev(current.revision) } }
          : { kind: 'rejected', code: 'operation_mismatch' };
      }
      const currentRevision = current ? rev(current.revision) : null;
      if (currentRevision !== input.expectedRevision) return { kind: 'rejected', code: 'stale_revision' };
      const next: Mute = { muted: input.action === 'mute', revision: (current?.revision ?? 0) + 1, operationId: input.operationId, action: input.action };
      mutes.set(key, next);
      // The journal records the mute, but the response is lost.
      if (failure === 'unknown_after_commit') return { kind: 'outcome_unknown', operationId: input.operationId };
      return { kind: 'ok', value: { v: 1, operationKind: row.input.kind, muted: next.muted, revision: rev(next.revision) } };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  function mustGet(handle: string): Row {
    const row = rows.get(handle);
    if (!row) throw new Error(`unknown request ${handle}`);
    return row;
  }

  return {
    port,
    calls,
    failNext,
    submit(input) {
      const fingerprint = fixtureDigest(input.fingerprint);
      const key = muteKey({ fingerprint, input });
      if (mutes.get(key)?.muted) return null;
      sequence += 1;
      const handle = `careq_${fixtureDigest(`request-${sequence}`)}` as ChannelAccessRequestHandle;
      rows.set(handle, {
        handle,
        input,
        fingerprint,
        outcome: 'pending_owner',
        revision: 1,
        createdAt: clock,
        deadline: clock + CHANNEL_ACCESS_REQUEST_LIFETIME_MS,
        ownerDecision: 'pending',
        decidedAt: null,
        decisionOperation: null,
      });
      notificationSequence += 1;
      publish({ v: 1, notificationId: `notice-${handle}`, revision: rev(notificationSequence), ownerId: FAKE_OWNER_ID, kind: 'request', requestHandle: handle, count: 1 });
      // Keep later requests strictly ordered by creation time.
      clock += 1000;
      return handle;
    },
    advance(handle, outcome) {
      const row = mustGet(handle);
      row.outcome = outcome;
      row.revision += 1;
    },
    decideElsewhere(handle, decision) {
      applyDecision(mustGet(handle), decision, `elsewhere-${handle}`);
    },
    bumpRevision(handle) {
      mustGet(handle).revision += 1;
    },
    loseChannel(title) {
      lostChannels.add(title);
    },
    setCaller(next) {
      caller = next;
    },
    advanceClock(ms) {
      clock += ms;
    },
    now: () => clock,
    publishBatch(count) {
      notificationSequence += 1;
      publish({ v: 1, notificationId: 'notice-batch', revision: rev(notificationSequence), ownerId: FAKE_OWNER_ID, kind: 'batch', requestHandle: null, count });
    },
    isMuted(kind, fingerprint, title = '') {
      return mutes.get(muteKey({ fingerprint: fixtureDigest(fingerprint), input: { kind, title } }))?.muted ?? false;
    },
    rows: () => [...rows.values()].map(project),
  };
}

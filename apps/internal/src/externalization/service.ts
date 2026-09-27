import {
  type ConversionAccessPort, type ConversionAgentBlock, type ConversionAgentState, type ConversionBindingPort,
  type ConversionOwner, type ConversionSessionPort, type ConversionState, type ConversionVisibility, type HistoryMode,
  type HistoryTransferPhase, type HistoryTransferPort, type HostedChannelCreated, type HostedChannelPort, decodeConversionStart,
} from '@khala/contracts/messaging/externalization';
import {
  type ConversionFailure, type ConversionHistoryProgress, EMPTY_HISTORY_PROGRESS,
} from '@khala/contracts/messaging/make-external';
import { type OperationResult, ok, rejected, unavailable } from '@khala/contracts/messaging/outcomes';
import type { ConversionChange, ConversionEntry, ConversionJournal } from './journal';

// Start-fresh conversion of an internal channel into a fresh external channel.
//
// Only the owner of the source channel may start a conversion, and the journal records
// that owner and acting participant. Every later call must come from the same pair.
//
// The human confirms a snapshot (channel, visibility, selected agents). The service
// creates the hosted channel once, reconciling a lost create response by its
// idempotency key, and only then makes one channel-access request per selected agent.
// Agents join the destination only through those individual requests: the human
// grants exactly those requests (one batch action is one grant per request),
// activation reports each request ready while its destination binding stays
// conversion-paused, and nothing here ever binds an agent directly.
//
// Commit needs every agent ready or explicitly skipped. It pauses source writes, then
// one link transaction makes the source read-only and journals the activation intent.
// A failure before that link resumes the source; after it, recovery only releases the
// remaining paused bindings forward. Start-fresh copies no message.
//
// Carry-history copies the source history into the destination before any access
// request exists: one copy, at most three catch-up rounds while the internal channel
// keeps working, then a final delta under a short write pause. When catch-up does not
// converge the conversion waits in `drain_required` until the human confirms a paused
// drain. The write pause the final step takes holds until the link commit or until a
// cancel or failure resumes the internal channel. A drain that exceeds its ceiling, or
// a source that no longer matches what was copied, fails the conversion.

export type ConversionView = Readonly<{
  conversionId: string;
  owner: ConversionOwner;
  sourceChannelId: string;
  state: ConversionState;
  revision: number;
  historyMode: HistoryMode;
  visibility: ConversionVisibility;
  destinationChannelId: string | null;
  agents: readonly ConversionAgentState[];
  /** Every agent is ready or skipped and the conversion is waiting for the human to commit. */
  canCommit: boolean;
  /** A created destination left behind by a cancelled or failed conversion, for cleanup. */
  orphanDestinationChannelId: string | null;
  /** Carry-history progress; null for start-fresh. */
  history: ConversionHistoryProgress | null;
  /** Why a `failed` conversion stopped; the internal channel is writable again. */
  failure: ConversionFailure | null;
}>;

export type ConversionServiceRejection =
  | 'invalid_request' | 'unsupported' | 'not_found' | 'invalid_selection' | 'conflict' | 'wrong_state' | 'not_ready' | 'forbidden';

export type ConversionDecision = Readonly<{
  /** Every request the human's one batch action approves. */
  requestHandles: readonly string[];
  operationId: string;
}>;

export type ConversionDecisionResult = Readonly<{
  view: ConversionView;
  granted: readonly string[];
  /** Handles that are not a pending request of this conversion's selected agents; never granted. */
  refused: readonly string[];
}>;

export type ConversionServiceDeps = Readonly<{
  journal: ConversionJournal;
  hosted: HostedChannelPort;
  sessions: ConversionSessionPort;
  access: ConversionAccessPort;
  bindings: ConversionBindingPort;
  /** History transfer for carry-history; without it only start-fresh is supported. */
  history?: HistoryTransferPort;
  /** Test seam, run after the write pause and before the link; throwing here fails the commit. */
  beforeLink?: () => void | Promise<void>;
}>;

type Result<T> = Promise<OperationResult<T, ConversionServiceRejection>>;

/**
 * Every call names the signed-in owner. `start` refuses one who does not own the source
 * channel; every other call refuses anyone but the owner and participant that started it.
 */
export interface ConversionService {
  start(owner: ConversionOwner, input: unknown): Result<ConversionView>;
  /** Advances whatever needs no human: create, requests, readiness, or forward release. */
  resume(owner: ConversionOwner, conversionId: string): Result<ConversionView>;
  decide(owner: ConversionOwner, conversionId: string, decision: ConversionDecision): Result<ConversionDecisionResult>;
  /** Withdraws a blocked agent's request and re-invites it with a new one, after re-verifying its exact session. */
  retry(owner: ConversionOwner, conversionId: string, participantId: string): Result<ConversionView>;
  /** Withdraws the agent's request, if any, and leaves it out of the destination. */
  skip(owner: ConversionOwner, conversionId: string, participantId: string): Result<ConversionView>;
  /** The human's confirmation, in `drain_required`, to pause the internal channel and drain the rest of its history. */
  confirmDrain(owner: ConversionOwner, conversionId: string): Result<ConversionView>;
  commit(owner: ConversionOwner, conversionId: string): Result<ConversionView>;
  cancel(owner: ConversionOwner, conversionId: string): Result<ConversionView>;
  view(owner: ConversionOwner, conversionId: string): Result<ConversionView>;
}

const PRE_COMMIT: readonly ConversionState[] = [
  'preparing', 'external_created', 'history_copying', 'history_catching_up', 'drain_required', 'agents_pending',
];

const settled = (agent: ConversionAgentState): boolean => agent.status === 'ready' || agent.status === 'skipped';

function viewOf(entry: ConversionEntry): ConversionView {
  const state = entry.record.state;
  const destinationChannelId = entry.destination?.destinationChannelId ?? null;
  const carry = entry.record.historyMode === 'carry_history';
  return {
    conversionId: entry.record.conversionId,
    owner: entry.snapshot.owner,
    sourceChannelId: entry.snapshot.sourceChannelId,
    state,
    revision: entry.record.revision,
    historyMode: entry.record.historyMode,
    visibility: entry.snapshot.visibility,
    destinationChannelId,
    agents: entry.agents,
    canCommit: state === 'agents_pending' && entry.agents.every(settled),
    orphanDestinationChannelId: state === 'cancelled' || state === 'failed' ? destinationChannelId : null,
    history: carry ? entry.history ?? EMPTY_HISTORY_PROGRESS : null,
    failure: state === 'failed' ? entry.history?.blocked ?? 'commit_failed' : null,
  };
}

/** The history step after the last completed one: copy, up to three catch-up rounds, then the final drain. */
function nextHistoryStep(progress: ConversionHistoryProgress): Readonly<{ phase: HistoryTransferPhase; round: number }> {
  if (progress.phase === null) return { phase: 'copy', round: 0 };
  if (progress.phase === 'copy') return { phase: 'catch_up', round: 1 };
  if (progress.phase === 'catch_up' && progress.outcome === 'more') return { phase: 'catch_up', round: progress.round + 1 };
  return { phase: 'final_drain', round: 0 };
}

const withAgent = (
  agents: readonly ConversionAgentState[], participantId: string, change: Partial<ConversionAgentState>,
): readonly ConversionAgentState[] => agents.map(agent => agent.participantId === participantId ? { ...agent, ...change } : agent);

class Halt {
  constructor(readonly result: OperationResult<never, ConversionServiceRejection>) {}
}

export function createConversionService(deps: ConversionServiceDeps): ConversionService {
  /** Conversions whose commit is running in this process, between the write pause and the link. */
  const committing = new Set<string>();

  async function read(conversionId: string): Promise<ConversionEntry> {
    const found = await deps.journal.entry(conversionId);
    if (found.kind === 'ok') return found.value;
    throw new Halt(found.kind === 'rejected' ? rejected('not_found') : unavailable());
  }

  /** The conversion, only for the owner and participant that started it. */
  async function load(owner: ConversionOwner, conversionId: string): Promise<ConversionEntry> {
    const entry = await read(conversionId);
    const started = entry.snapshot.owner;
    if (started.ownerId !== owner.ownerId || started.participantId !== owner.participantId) throw new Halt(rejected('forbidden'));
    return entry;
  }

  /** One journaled step; the operation ID is deterministic, so a replay of the same step is idempotent. */
  async function record(entry: ConversionEntry, label: string, change: Omit<ConversionChange, 'conversionId' | 'operationId' | 'expectedRevision'>): Promise<ConversionEntry> {
    const conversionId = entry.record.conversionId;
    const result = await deps.journal.change({
      conversionId, operationId: `${conversionId}.r${entry.record.revision}.${label}`, expectedRevision: entry.record.revision, ...change,
    });
    if (result.kind === 'ok') return result.value;
    if (result.kind === 'rejected') throw new Halt(rejected(result.code === 'not_found' ? 'not_found' : 'conflict'));
    throw new Halt(unavailable());
  }

  const identityOf = (entry: ConversionEntry, participantId: string) =>
    entry.snapshot.agents.find(agent => agent.participantId === participantId)!;

  /** Re-verifies one agent's exact selected session; null when current. */
  async function verify(entry: ConversionEntry, participantId: string): Promise<ConversionAgentBlock | null | 'unavailable'> {
    const check = await deps.sessions.verify(identityOf(entry, participantId));
    return check === 'current' ? null : check;
  }

  async function createDestination(entry: ConversionEntry): Promise<HostedChannelCreated | null> {
    const idempotencyKey = `${entry.record.conversionId}.destination`;
    const created = await deps.hosted.create({ idempotencyKey, title: entry.snapshot.title, visibility: entry.snapshot.visibility });
    if (created.kind === 'ok') return created.value;
    if (created.kind === 'rejected') throw new Halt(rejected(created.code === 'forbidden' ? 'forbidden' : 'conflict'));
    // The response was lost or the call failed: whatever that key created is the destination.
    const found = await deps.hosted.reconcile({ idempotencyKey });
    if (found.kind === 'rejected') throw new Halt(rejected('forbidden'));
    return found.kind === 'ok' ? found.value : null;
  }

  async function preparing(entry: ConversionEntry): Promise<ConversionEntry> {
    let agents = entry.agents;
    for (const agent of entry.agents) {
      if (agent.status !== 'verifying') continue;
      const block = await verify(entry, agent.participantId);
      if (block === 'unavailable') return entry;
      if (block) agents = withAgent(agents, agent.participantId, { status: 'blocked', block });
    }
    const destination = await createDestination(entry);
    if (!destination) return agents === entry.agents ? entry : record(entry, 'verified', { agents });
    return record(entry, 'created', { to: 'external_created', destination, agents });
  }

  /** One individual journal request per verifying agent; only ever after the destination exists. */
  async function request(entry: ConversionEntry): Promise<ReadonlyArray<ConversionAgentState>> {
    let agents = entry.agents;
    for (const agent of entry.agents) {
      if (agent.status !== 'verifying') continue;
      const made = await deps.access.request({
        operationId: `${entry.record.conversionId}.access.${agent.participantId}.${agent.attempt}`,
        destinationChannelId: entry.destination!.destinationChannelId,
        agent: identityOf(entry, agent.participantId),
      });
      if (made.kind === 'ok') {
        agents = withAgent(agents, agent.participantId, { status: 'requested', requestHandle: made.value.requestHandle, block: null });
      } else if (made.kind === 'rejected') {
        agents = withAgent(agents, agent.participantId, { status: 'blocked', block: 'request_failed' });
      }
    }
    return agents;
  }

  async function pending(entry: ConversionEntry): Promise<ConversionEntry> {
    let agents = await request(entry);
    for (const agent of agents) {
      if (agent.status !== 'requested' || agent.requestHandle === null) continue;
      const readiness = await deps.access.readiness(agent.requestHandle);
      if (readiness.kind === 'ready') agents = withAgent(agents, agent.participantId, { status: 'ready' });
      else if (readiness.kind === 'blocked') agents = withAgent(agents, agent.participantId, { status: 'blocked', block: readiness.block });
    }
    return JSON.stringify(agents) === JSON.stringify(entry.agents) ? entry : record(entry, 'agents', { agents });
  }

  /** After the link: release every remaining paused binding, then finish. Never reopens the source. */
  async function activating(entry: ConversionEntry): Promise<ConversionEntry> {
    let current = entry;
    for (const agent of entry.agents) {
      if (agent.status !== 'ready' || agent.released) continue;
      const released = await deps.bindings.release({
        requestHandle: agent.requestHandle!,
        destinationChannelId: entry.destination!.destinationChannelId,
        operationId: `${entry.record.conversionId}.release.${agent.participantId}.${agent.attempt}`,
      });
      if (released !== 'released') return current;
      current = await record(current, `released.${agent.participantId}`, {
        agents: withAgent(current.agents, agent.participantId, { released: true }),
      });
    }
    return record(current, 'externalized', { to: 'externalized' });
  }

  /**
   * Runs the next history step and journals its progress. A lost or unavailable step
   * changes nothing, so the next resume repeats it; the transfer's own acknowledgements
   * keep that repeat from copying anything twice.
   */
  async function transfer(entry: ConversionEntry): Promise<ConversionEntry> {
    const progress = entry.history ?? EMPTY_HISTORY_PROGRESS;
    if (entry.record.state === 'drain_required' && !progress.drainConfirmed) return entry;
    const { phase, round } = nextHistoryStep(progress);
    const stepped = await deps.history!.step({
      v: 1, conversionId: entry.record.conversionId, operationId: entry.record.operationId, phase, round,
      afterChunk: progress.acknowledgedChunks,
    });
    if (stepped.kind === 'rejected') {
      if (stepped.code === 'ceiling_exceeded' || stepped.code === 'source_changed') {
        return record(entry, 'history_blocked', { to: 'failed', history: { ...progress, blocked: stepped.code } });
      }
      throw new Halt(rejected(stepped.code === 'forbidden' ? 'forbidden' : 'conflict'));
    }
    if (stepped.kind !== 'ok') return entry;
    const step = stepped.value;
    const history: ConversionHistoryProgress = {
      ...progress, phase, round, outcome: step.outcome, acknowledgedChunks: step.lastAckChunk, chunkCount: step.chunkCount,
      manifestDigest: phase === 'final_drain' ? step.manifestDigest : null,
    };
    const label = `history.${phase}.${round}`;
    if (phase === 'copy') return record(entry, label, { to: 'history_catching_up', history });
    if (phase === 'catch_up' && step.outcome === 'drain_required') return record(entry, label, { to: 'drain_required', history });
    if (phase === 'final_drain') return record(entry, label, { to: 'agents_pending', history, agents: await request(entry) });
    return record(entry, label, { history });
  }

  async function fail(entry: ConversionEntry): Promise<ConversionEntry> {
    return record(entry, 'failed', { to: 'failed' });
  }

  /** Withdraws the agent's current request, if it has one, before the journal forgets it. */
  async function withdraw(entry: ConversionEntry, agent: ConversionAgentState): Promise<void> {
    if (agent.requestHandle === null) return;
    const withdrawn = await deps.access.withdraw({
      requestHandle: agent.requestHandle,
      operationId: `${entry.record.conversionId}.withdraw.${agent.participantId}.${agent.attempt}`,
    });
    if (withdrawn !== 'withdrawn') throw new Halt(unavailable());
  }

  async function drive(start: ConversionEntry): Promise<ConversionEntry> {
    let entry = start;
    for (;;) {
      const before = entry.record.revision;
      switch (entry.record.state) {
        case 'preparing': entry = await preparing(entry); break;
        case 'external_created':
          entry = entry.record.historyMode === 'carry_history'
            ? await record(entry, 'history_copying', { to: 'history_copying', history: EMPTY_HISTORY_PROGRESS })
            : await record(entry, 'agents_pending', { to: 'agents_pending', agents: await request(entry) });
          break;
        case 'history_copying':
        case 'history_catching_up':
        case 'drain_required': entry = await transfer(entry); break;
        case 'agents_pending': entry = await pending(entry); break;
        // A commit that stopped between the write pause and the link never linked: resume the source.
        // One still running in this process is left to finish.
        case 'committing':
          if (committing.has(entry.record.conversionId)) return entry;
          entry = await fail(entry);
          break;
        case 'activating': entry = await activating(entry); break;
        default: return entry;
      }
      if (entry.record.revision === before || entry.record.state === 'agents_pending') return entry;
    }
  }

  async function guarded<T>(body: () => Promise<T>): Promise<OperationResult<T, ConversionServiceRejection>> {
    try {
      return ok(await body());
    } catch (error) {
      if (error instanceof Halt) return error.result;
      return unavailable();
    }
  }

  const wrongState = (): never => {
    throw new Halt(rejected('wrong_state'));
  };

  async function agentAction(
    owner: ConversionOwner, conversionId: string, participantId: string,
    act: (entry: ConversionEntry, agent: ConversionAgentState) => Promise<ConversionEntry>,
  ) {
    return guarded(async () => {
      const entry = await load(owner, conversionId);
      if (entry.record.state !== 'agents_pending') wrongState();
      const agent = entry.agents.find(candidate => candidate.participantId === participantId);
      if (!agent) throw new Halt(rejected('not_found'));
      return viewOf(await act(entry, agent));
    });
  }

  return {
    start(owner, input) {
      return guarded(async () => {
        const decoded = decodeConversionStart(input);
        if (!decoded.ok) throw new Halt(rejected('invalid_request'));
        if (decoded.value.historyMode === 'carry_history' && !deps.history) throw new Halt(rejected('unsupported'));
        const started = await deps.journal.start(owner, decoded.value);
        if (started.kind === 'rejected') {
          throw new Halt(rejected(started.code === 'operation_mismatch' ? 'conflict' : started.code));
        }
        if (started.kind !== 'ok') throw new Halt(unavailable());
        return viewOf(await drive(await load(owner, decoded.value.conversionId)));
      });
    },

    resume(owner, conversionId) {
      return guarded(async () => viewOf(await drive(await load(owner, conversionId))));
    },

    decide(owner, conversionId, decision) {
      return guarded(async () => {
        let entry = await load(owner, conversionId);
        if (entry.record.state !== 'agents_pending') wrongState();
        const granted: string[] = [];
        const refused: string[] = [];
        let agents = entry.agents;
        for (const handle of new Set(decision.requestHandles)) {
          const agent = entry.agents.find(candidate => candidate.status === 'requested' && candidate.requestHandle === handle);
          if (!agent) {
            refused.push(handle);
            continue;
          }
          const grant = await deps.access.grant({ requestHandle: handle, operationId: `${decision.operationId}.${handle}` });
          if (grant.kind === 'ok') granted.push(handle);
          else if (grant.kind === 'rejected' && grant.code !== 'operation_mismatch' && grant.code !== 'not_found') {
            agents = withAgent(agents, agent.participantId, { status: 'blocked', block: grant.code });
          } else refused.push(handle);
        }
        if (agents !== entry.agents) entry = await record(entry, `decided.${decision.operationId}`, { agents });
        return { view: viewOf(await drive(entry)), granted, refused };
      });
    },

    retry(owner, conversionId, participantId) {
      return agentAction(owner, conversionId, participantId, async (entry, agent) => {
        if (agent.status !== 'blocked') wrongState();
        const block = await verify(entry, participantId);
        if (block === 'unavailable') throw new Halt(unavailable());
        if (!block) await withdraw(entry, agent);
        const change: Partial<ConversionAgentState> = block
          ? { block }
          : { status: 'verifying', block: null, requestHandle: null, attempt: agent.attempt + 1 };
        return drive(await record(entry, `retry.${participantId}`, { agents: withAgent(entry.agents, participantId, change) }));
      });
    },

    skip(owner, conversionId, participantId) {
      return agentAction(owner, conversionId, participantId, async (entry, agent) => {
        if (agent.status === 'skipped') return entry;
        await withdraw(entry, agent);
        return record(entry, `skip.${participantId}`, {
          agents: withAgent(entry.agents, participantId, { status: 'skipped', block: null, requestHandle: null }),
        });
      });
    },

    confirmDrain(owner, conversionId) {
      return guarded(async () => {
        const entry = await load(owner, conversionId);
        if (entry.record.state !== 'drain_required') wrongState();
        const progress = entry.history ?? EMPTY_HISTORY_PROGRESS;
        const confirmed = progress.drainConfirmed ? entry : await record(entry, 'drain_confirmed', { history: { ...progress, drainConfirmed: true } });
        return viewOf(await drive(confirmed));
      });
    },

    commit(owner, conversionId) {
      return guarded(async () => {
        let entry = await drive(await load(owner, conversionId));
        if (entry.record.state !== 'agents_pending') wrongState();
        if (!entry.agents.every(settled)) throw new Halt(rejected('not_ready'));
        // The exact selected sessions must still be the ones that became ready.
        let agents = entry.agents;
        for (const agent of entry.agents) {
          if (agent.status !== 'ready') continue;
          const block = await verify(entry, agent.participantId);
          if (block === 'unavailable') throw new Halt(unavailable());
          if (block) agents = withAgent(agents, agent.participantId, { status: 'blocked', block });
        }
        if (agents !== entry.agents) {
          await record(entry, 'commit_verified', { agents });
          throw new Halt(rejected('not_ready'));
        }
        committing.add(conversionId);
        try {
          entry = await record(entry, 'committing', { to: 'committing' });
          try {
            await deps.beforeLink?.();
            entry = await record(entry, 'linked', { to: 'activating' });
          } catch (error) {
            if (error instanceof Halt && error.result.kind === 'unavailable') throw error;
            return viewOf(await fail(await read(conversionId)));
          }
        } finally {
          committing.delete(conversionId);
        }
        return viewOf(await drive(entry));
      });
    },

    cancel(owner, conversionId) {
      return guarded(async () => {
        const entry = await load(owner, conversionId);
        if (entry.record.state === 'cancelled') return viewOf(entry);
        if (!PRE_COMMIT.includes(entry.record.state)) wrongState();
        return viewOf(await record(entry, 'cancelled', { to: 'cancelled' }));
      });
    },

    view(owner, conversionId) {
      return guarded(async () => viewOf(await load(owner, conversionId)));
    },
  };
}

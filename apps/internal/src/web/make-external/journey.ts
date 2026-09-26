import { createHash } from 'node:crypto';
import type { ConversionOwner, ConversionState } from '@khala/contracts/messaging/externalization';
import type {
  MakeExternalAction, MakeExternalConversion, MakeExternalJourneyView, MakeExternalRejection, MakeExternalSignIn,
} from '@khala/contracts/messaging/make-external';
import { type OperationResult, ok, rejected, unavailable } from '@khala/contracts/messaging/outcomes';
import type { ConversionEntry, ConversionJournal } from '../../externalization/journal';
import type { ConversionService, ConversionServiceRejection, ConversionView } from '../../externalization/service';
import type { MakeExternalJourneyPort } from '../../server/make-external';
import type { InternalStoreHandle } from '../../store/open';
import type { HostedSignInPort } from './ports';
import { displayNames, readRoster } from './roster';

// The Make-external journey for one internal channel. Before the human confirms,
// the only state is this server's sign-in draft: entering, signing in and cancelling
// change nothing durable. Confirming starts a journaled conversion, and from then on
// the conversion journal is the only source of truth: a reload, a lost response or a
// restarted server reads it back by the channel's conversion lock or, once the
// conversion ended, by the channel's durable latest-conversion pointer, so the browser can
// always resume the same conversion.
//
// Every step that reaches the hosted service needs a completed hosted sign-in. A
// restarted server has forgotten it, so the human signs in again and the journey
// continues the same conversion. Cancelling needs no sign-in and never reaches the
// hosted service; a destination it leaves behind is reported for explicit cleanup.

export type JourneyHuman = ConversionOwner;

export type MakeExternalJourneyDeps = Readonly<{
  handle: InternalStoreHandle;
  journal: ConversionJournal;
  service: ConversionService;
  signIn: HostedSignInPort;
  /** Where the human opens an external channel, or null when the hosted origin is unknown. */
  destinationUrl: (destinationChannelId: string) => string | null;
}>;

export interface MakeExternalJourney extends MakeExternalJourneyPort {
  /** The human whose hosted sign-in is complete, for the history transfer's owner check. */
  signedIn(): JourneyHuman | null;
}

type Draft = {
  human: JourneyHuman;
  signIn: MakeExternalSignIn;
  attempt: string | null;
};

const ENDED: readonly ConversionState[] = ['cancelled', 'failed'];
const NEEDS_SIGN_IN = new Set<MakeExternalAction['kind']>(['start', 'resume', 'grant', 'retry', 'skip', 'drain', 'commit']);

const SIGNED_OUT: MakeExternalSignIn = { status: 'signed_out', verificationUrl: null, failure: null };

/** A retried confirmation names the same conversion, so a lost response never starts a second one. */
export function conversionIdFor(channelId: string, operationId: string): string {
  return `conv_${createHash('sha256').update(`${channelId}\n${operationId}`).digest('base64url').slice(0, 32)}`;
}

export function createMakeExternalJourney(deps: MakeExternalJourneyDeps): MakeExternalJourney {
  const drafts = new Map<string, Draft>();

  function draftFor(human: JourneyHuman, channelId: string): Draft {
    let draft = drafts.get(channelId);
    if (!draft || draft.human.ownerId !== human.ownerId || draft.human.participantId !== human.participantId) {
      draft = { human, signIn: SIGNED_OUT, attempt: null };
      drafts.set(channelId, draft);
    }
    return draft;
  }

  /** Asks the hosted service how a pending sign-in ended; an unreachable service leaves it pending. */
  async function refreshSignIn(draft: Draft): Promise<void> {
    if (draft.signIn.status !== 'pending' || draft.attempt === null) return;
    const outcome = await deps.signIn.status(draft.attempt);
    if (outcome === 'signed_in') draft.signIn = { status: 'signed_in', verificationUrl: null, failure: null };
    else if (outcome === 'denied' || outcome === 'expired') {
      draft.signIn = { status: 'failed', verificationUrl: null, failure: outcome };
      draft.attempt = null;
    }
  }

  function conversionOf(view: ConversionView, entry: ConversionEntry): MakeExternalConversion {
    const names = displayNames(deps.handle, entry.snapshot.agents.map(agent => agent.participantId));
    const destination = view.destinationChannelId;
    return {
      conversionId: view.conversionId,
      state: view.state,
      historyMode: view.historyMode,
      visibility: view.visibility,
      destinationChannelId: destination,
      destinationUrl: destination === null ? null : deps.destinationUrl(destination),
      agents: view.agents.map(agent => {
        const identity = entry.snapshot.agents.find(selected => selected.participantId === agent.participantId)!;
        return {
          participantId: agent.participantId,
          displayName: names.get(agent.participantId) ?? agent.participantId,
          harness: identity.harness,
          sessionId: identity.sessionId,
          generation: identity.generation,
          status: agent.status,
          block: agent.block,
          requestHandle: agent.requestHandle,
          released: agent.released,
        };
      }),
      history: view.history,
      canCommit: view.canCommit,
      orphanDestinationChannelId: view.orphanDestinationChannelId,
      failure: view.failure,
    };
  }

  type Built = OperationResult<MakeExternalJourneyView, 'not_found' | 'forbidden'>;

  async function build(human: JourneyHuman, channelId: string): Promise<Built> {
    const roster = readRoster(deps.handle, human, channelId);
    if (roster === 'not_found' || roster === 'forbidden') return rejected(roster);
    const draft = draftFor(human, channelId);
    await refreshSignIn(draft);
    const lock = await deps.journal.sourceLock(channelId);
    const latest = await deps.journal.latest(channelId);
    if (lock.kind !== 'ok' || latest.kind !== 'ok') return unavailable();
    // The lock names a conversion under way or linked; after a cancel or failure only the
    // durable latest pointer still names it, so its orphan survives a restart.
    const conversionId = lock.value?.conversionId ?? latest.value;
    let conversion: MakeExternalConversion | null = null;
    if (conversionId !== null) {
      const viewed = await deps.service.view(human, conversionId);
      if (viewed.kind === 'rejected' && viewed.code === 'forbidden') return rejected('forbidden');
      if (viewed.kind !== 'ok' && viewed.kind !== 'rejected') return unavailable();
      const entry = await deps.journal.entry(conversionId);
      if (viewed.kind === 'ok' && entry.kind === 'ok') conversion = conversionOf(viewed.value, entry.value);
      else if (entry.kind === 'unavailable') return unavailable();
    }
    const open = conversion === null || ENDED.includes(conversion.state);
    return ok({
      v: 1,
      channelId,
      title: roster.title,
      sourceWrite: lock.value?.write ?? 'open',
      signIn: draft.signIn,
      roster: open ? roster.agents : [],
      conversion,
    });
  }

  /** Runs one action and reports its refusal, if any; the caller always gets the resulting view. */
  async function perform(draft: Draft, channelId: string, action: MakeExternalAction, current: MakeExternalConversion | null)
    : Promise<MakeExternalRejection | null | 'unavailable'> {
    const human = draft.human;
    const active = current !== null && !ENDED.includes(current.state) ? current : null;
    if (NEEDS_SIGN_IN.has(action.kind) && draft.signIn.status !== 'signed_in') return 'sign_in_required';
    const settle = (result: OperationResult<unknown, ConversionServiceRejection>): MakeExternalRejection | null | 'unavailable' =>
      result.kind === 'ok' ? null : result.kind === 'rejected' ? result.code : 'unavailable';
    switch (action.kind) {
      case 'sign_in': {
        if (draft.signIn.status === 'signed_in') return null;
        const begun = await deps.signIn.begin({ journeyId: channelId, operationId: action.operationId });
        if (begun.kind === 'ok') {
          draft.attempt = begun.value.attempt;
          draft.signIn = { status: 'pending', verificationUrl: begun.value.verificationUrl, failure: null };
          return null;
        }
        draft.attempt = null;
        draft.signIn = { status: 'failed', verificationUrl: null, failure: begun.kind === 'rejected' ? 'denied' : 'unavailable' };
        return null;
      }
      case 'cancel':
        if (active === null) {
          // Nothing was created: cancelling forgets the draft and changes nothing else.
          if (current === null) drafts.delete(channelId);
          return null;
        }
        return settle(await deps.service.cancel(human, active.conversionId));
      case 'dismiss': {
        if (current === null || active !== null) return 'wrong_state';
        const dismissed = await deps.journal.dismiss(channelId, current.conversionId);
        return dismissed.kind === 'ok' ? null : dismissed.kind === 'rejected' ? dismissed.code : 'unavailable';
      }
      case 'start': {
        if (active !== null) return 'wrong_state';
        const conversionId = conversionIdFor(channelId, action.operationId);
        const started = await deps.service.start(human, {
          v: 1, conversionId, operationId: action.operationId, sourceChannelId: channelId, historyMode: action.historyMode,
          visibility: action.visibility, agents: action.agents,
        });
        return settle(started);
      }
      default:
        break;
    }
    if (active === null) return 'wrong_state';
    const id = active.conversionId;
    switch (action.kind) {
      case 'resume': return settle(await deps.service.resume(human, id));
      case 'grant': return settle(await deps.service.decide(human, id, { requestHandles: action.requestHandles, operationId: action.operationId }));
      case 'retry': return settle(await deps.service.retry(human, id, action.participantId));
      case 'skip': return settle(await deps.service.skip(human, id, action.participantId));
      case 'drain': return settle(await deps.service.confirmDrain(human, id));
      case 'commit': return settle(await deps.service.commit(human, id));
    }
  }

  return {
    view: build,

    async act(human, channelId, action) {
      const before = await build(human, channelId);
      if (before.kind === 'rejected') return before;
      if (before.kind !== 'ok') return { kind: 'unavailable' };
      const outcome = await perform(draftFor(human, channelId), channelId, action, before.value.conversion);
      if (outcome === 'unavailable') return { kind: 'unavailable' };
      const after = await build(human, channelId);
      if (after.kind === 'rejected') return after;
      if (after.kind !== 'ok') return { kind: 'unavailable' };
      return { kind: 'ok', view: after.value, rejection: outcome };
    },

    signedIn() {
      for (const draft of drafts.values()) if (draft.signIn.status === 'signed_in') return draft.human;
      return null;
    },
  };
}

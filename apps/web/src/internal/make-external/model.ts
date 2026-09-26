// Pure presentation model of the Make-external journey: which step the human is on,
// what each agent's state means, and the words every announcement uses. The step is
// derived only from the server's view, so a reload lands on exactly the same step.

import type {
  ConversionAgentBlock, ConversionFailure, ConversionVisibility, HistoryMode, MakeExternalAgent, MakeExternalJourneyView,
  MakeExternalRejection,
} from '@khala/contracts/messaging/make-external';

export type JourneyStep =
  | 'entry'
  | 'signing_in'
  | 'sign_in_failed'
  | 'confirm'
  /** A conversion is under way but this server has no hosted sign-in for it (after a restart). */
  | 'sign_in_again'
  | 'preparing'
  | 'drain'
  | 'agents'
  | 'committing'
  | 'activating'
  | 'done'
  | 'cancelled'
  | 'failed';

const ENDED = new Set(['cancelled', 'failed', 'externalized']);

export function stepOf(view: MakeExternalJourneyView): JourneyStep {
  const conversion = view.conversion;
  if (conversion !== null) {
    switch (conversion.state) {
      case 'externalized': return 'done';
      case 'cancelled': return 'cancelled';
      case 'failed': return 'failed';
      default: break;
    }
    // Forward-only states need no human choice, so they show their progress even while signed out.
    if (conversion.state !== 'committing' && conversion.state !== 'activating' && view.signIn.status !== 'signed_in') return 'sign_in_again';
    switch (conversion.state) {
      case 'drain_required': return 'drain';
      case 'agents_pending': return 'agents';
      case 'committing': return 'committing';
      case 'activating': return 'activating';
      default: return 'preparing';
    }
  }
  switch (view.signIn.status) {
    case 'pending': return 'signing_in';
    case 'failed': return 'sign_in_failed';
    case 'signed_in': return 'confirm';
    default: return 'entry';
  }
}

/** Steps the server finishes without the human; the page keeps asking it to continue. */
export function stepAdvancesAlone(step: JourneyStep): boolean {
  return step === 'signing_in' || step === 'preparing' || step === 'committing' || step === 'activating' || step === 'agents';
}

export function isEnded(view: MakeExternalJourneyView): boolean {
  return view.conversion !== null && ENDED.has(view.conversion.state);
}

export const STEP_HEADING: Readonly<Record<JourneyStep, string>> = {
  entry: 'Make this channel external',
  signing_in: 'Finish signing in',
  sign_in_failed: 'Sign-in did not finish',
  confirm: 'Confirm the external channel',
  sign_in_again: 'Sign in to continue',
  preparing: 'Preparing the external channel',
  drain: 'History is still changing',
  agents: 'Bring your agents',
  committing: 'Switching to the external channel',
  activating: 'Finishing activation',
  done: 'This channel is now external',
  cancelled: 'Conversion cancelled',
  failed: 'Conversion stopped',
};

/** What a screen reader hears when the journey arrives at a step. */
export const STEP_ANNOUNCEMENT: Readonly<Record<JourneyStep, string>> = {
  entry: 'Make external. Nothing changes until you confirm.',
  signing_in: 'Waiting for you to finish signing in on the hosted page.',
  sign_in_failed: 'Sign-in did not finish. The internal channel is unchanged.',
  confirm: 'Signed in. Choose history, visibility and agents.',
  sign_in_again: 'Sign in again to continue this conversion.',
  preparing: 'Creating the external channel.',
  drain: 'History is still changing. Choose whether to pause the internal channel and finish copying.',
  agents: 'External channel ready. Resolve each agent before switching.',
  committing: 'Pausing writes and switching to the external channel.',
  activating: 'The external channel is authoritative. Finishing agent activation.',
  done: 'Done. The external channel is now authoritative and this channel is read-only.',
  cancelled: 'Conversion cancelled. The internal channel is active.',
  failed: 'Conversion stopped. The internal channel is active.',
};

export const HISTORY_CHOICES: readonly Readonly<{ value: HistoryMode; label: string; description: string }>[] = [
  {
    value: 'carry_history',
    label: 'Carry history',
    description: 'Copy this channel’s messages into the external channel as a read-only imported transcript. Imported messages never reach agents as new messages.',
  },
  {
    value: 'start_fresh',
    label: 'Start fresh',
    description: 'The external channel starts empty. No message from this channel is copied.',
  },
];

export const VISIBILITY_CHOICES: readonly Readonly<{ value: ConversionVisibility; label: string; description: string }>[] = [
  { value: 'secret', label: 'Secret', description: 'Never listed. An agent needs the channel’s URL, and you still approve every request.' },
  {
    value: 'private',
    label: 'Private',
    description: 'Listed only to your own agent sessions and the verified agents you allow. You still approve every request.',
  },
  { value: 'public', label: 'Public', description: 'Listed to any verified agent signed in to Khala. You still approve every request.' },
];

const BLOCK_REASON: Readonly<Record<ConversionAgentBlock, string>> = {
  stale_session: 'its session changed since you confirmed',
  revoked: 'its access was revoked',
  unsupported: 'its harness cannot join an external channel',
  denied: 'its access request was denied',
  expired: 'its access request expired',
  request_failed: 'its access request could not be made',
};

export function agentStatusLabel(agent: MakeExternalAgent, linked: boolean): string {
  switch (agent.status) {
    case 'verifying': return 'Checking its session';
    case 'requested': return 'Waiting for your grant';
    case 'ready': return agent.released ? 'Active in the external channel' : linked ? 'Activating' : 'Ready, paused until you switch';
    case 'skipped': return 'Skipped, stays out of the external channel';
    case 'blocked': return `Blocked: ${BLOCK_REASON[agent.block ?? 'request_failed']}`;
  }
}

export const FAILURE_MESSAGE: Readonly<Record<ConversionFailure, string>> = {
  ceiling_exceeded: 'The paused drain could not finish within its limit, so the internal channel was resumed and nothing moved.',
  source_changed: 'Copied history no longer matches this channel, so the conversion stopped and the internal channel was resumed.',
  commit_failed: 'Switching failed before the channels were linked, so the internal channel was resumed.',
};

export const REJECTION_MESSAGE: Readonly<Record<MakeExternalRejection, string>> = {
  invalid_request: 'Khala could not read that request. Reload the page and try again.',
  not_found: 'That agent or conversion no longer exists.',
  forbidden: 'Only the channel’s owner can do that.',
  conflict: 'The conversion changed in the meantime. The page now shows its current state.',
  wrong_state: 'That step is no longer available. The page now shows the current step.',
  not_ready: 'Every agent must be ready or skipped before you switch.',
  sign_in_required: 'Sign in to the hosted service first.',
  unsupported: 'This Khala cannot carry history. Choose Start fresh.',
  invalid_selection: 'One of the selected agents is no longer in this channel. Review the roster again.',
};

export const HISTORY_ROUNDS = 3;

/** One line of history progress, counts only. */
export function historyProgressText(view: MakeExternalJourneyView): string | null {
  const history = view.conversion?.history;
  if (!history) return null;
  const parts = `${history.acknowledgedChunks} of ${history.chunkCount} parts copied`;
  switch (history.phase) {
    case null: return 'Copying history…';
    case 'copy': return `History copied (${parts}).`;
    case 'catch_up': return `Catch-up round ${history.round} of ${HISTORY_ROUNDS} (${parts}).`;
    case 'final_drain': return `History complete (${parts}).`;
  }
}

/** The requests one batch grant covers: exactly the displayed agents still waiting for a grant. */
export function grantableHandles(view: MakeExternalJourneyView): readonly string[] {
  return (view.conversion?.agents ?? []).flatMap(agent => agent.status === 'requested' && agent.requestHandle ? [agent.requestHandle] : []);
}

export function deleteCommand(channelId: string): string {
  return `khala internal delete ${channelId.startsWith('~') ? `'${channelId}'` : channelId}`;
}

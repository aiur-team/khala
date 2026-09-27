import {
  EMPTY_HISTORY_PROGRESS, type MakeExternalAgent, type MakeExternalConversion, type MakeExternalJourneyView,
  type MakeExternalRosterAgent,
} from '@khala/contracts/messaging/make-external';

// Journey views for tests and the browser harness. Each is a value the server can
// return, built from the same contract types.

export const ROSTER: readonly MakeExternalRosterAgent[] = [
  { participantId: 'agent-builder', displayName: 'Builder', harness: 'codex', sessionId: 'session-builder', generation: 1 },
  { participantId: 'agent-reviewer', displayName: 'Reviewer', harness: 'claude', sessionId: 'session-reviewer', generation: 2 },
  { participantId: 'agent-tester', displayName: 'Tester', harness: 'opencode', sessionId: 'session-tester', generation: 1 },
];

export const baseView: MakeExternalJourneyView = {
  v: 1,
  channelId: 'internal-planning',
  title: 'Planning',
  sourceWrite: 'open',
  signIn: { status: 'signed_out', verificationUrl: null, failure: null },
  roster: ROSTER,
  conversion: null,
};

export const signedIn = (over: Partial<MakeExternalJourneyView> = {}): MakeExternalJourneyView => ({
  ...baseView, signIn: { status: 'signed_in', verificationUrl: null, failure: null }, ...over,
});

export const agentOf = (roster: MakeExternalRosterAgent, over: Partial<MakeExternalAgent> = {}): MakeExternalAgent => ({
  ...roster, status: 'requested', block: null, requestHandle: `careq-${roster.participantId}`, released: false, ...over,
});

export function conversionView(over: Partial<MakeExternalConversion> = {}, view: Partial<MakeExternalJourneyView> = {}): MakeExternalJourneyView {
  return signedIn({
    roster: [],
    conversion: {
      conversionId: 'conv_1',
      state: 'agents_pending',
      historyMode: 'carry_history',
      visibility: 'secret',
      destinationChannelId: 'external-1',
      destinationUrl: 'https://khala.test/channels/external-1',
      agents: ROSTER.map(agent => agentOf(agent)),
      history: { ...EMPTY_HISTORY_PROGRESS, phase: 'final_drain', outcome: 'converged', acknowledgedChunks: 3, chunkCount: 3, manifestDigest: 'sha256:m' },
      canCommit: false,
      orphanDestinationChannelId: null,
      failure: null,
      ...over,
    },
    ...view,
  });
}

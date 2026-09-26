import {
  CHANNEL_ACCESS_SENSITIVE_RETENTION_MS,
  MAX_CHANNEL_ACCESS_OWNER_PENDING,
  type ChannelAccessOwnerOutcome,
  type ChannelAccessOwnerProjection,
  type ChannelAccessRequestHandle,
} from '@khala/contracts/messaging/index';
import type { DecisionFact, DecisionPrompt, DecisionStatus } from '../approval-decision/model';

export type OwnerRequest = ChannelAccessOwnerProjection;

/** The hard owner maximum; the navigation indicator never shows more. */
export const PENDING_INDICATOR_MAX = MAX_CHANNEL_ACCESS_OWNER_PENDING;

/** Exact pending count for the navigation entry, capped at the owner maximum. */
export function pendingIndicator(requests: readonly OwnerRequest[]): number {
  return Math.min(requests.filter(request => request.outcome === 'pending_owner').length, PENDING_INDICATOR_MAX);
}

const TERMINAL: ReadonlySet<ChannelAccessOwnerOutcome> = new Set(['connected', 'denied', 'expired', 'revoked']);

export function isTerminal(request: OwnerRequest): boolean {
  return TERMINAL.has(request.outcome);
}

/**
 * When the request's sensitive context stops being shown: 30 days after it
 * ended. A denial ends at its decision. Every other terminal outcome (connected,
 * expired, revoked) ends no later than the request deadline, and the
 * projection carries no exact end time, so the deadline is the bound that never
 * hides a row the journal still returns. The journal purges on its own
 * schedule; this keeps an open page from outliving that by more than the
 * request lifetime.
 */
export function retentionEndsAt(request: OwnerRequest): number | null {
  if (!isTerminal(request)) return null;
  const endedAt = Date.parse(request.outcome === 'denied' && request.decidedAt !== null ? request.decidedAt : request.deadline);
  return endedAt + CHANNEL_ACCESS_SENSITIVE_RETENTION_MS;
}

export function isRetained(request: OwnerRequest, now: number): boolean {
  const ends = retentionEndsAt(request);
  return ends === null || now < ends;
}

/** Pending requests oldest first, so the longest wait is at the top. */
export function pendingRequests(requests: readonly OwnerRequest[]): readonly OwnerRequest[] {
  return requests
    .filter(request => request.outcome === 'pending_owner')
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Everything else, most recent first. */
export function recentRequests(requests: readonly OwnerRequest[]): readonly OwnerRequest[] {
  return requests
    .filter(request => request.outcome !== 'pending_owner')
    .sort((a, b) => Date.parse(b.decidedAt ?? b.createdAt) - Date.parse(a.decidedAt ?? a.createdAt));
}

export function operationLabel(request: OwnerRequest): string {
  return request.operationKind === 'access' ? 'Channel access request' : 'Channel creation request';
}

/** The channel as the owner knows it. A proposed title is the agent's text and is not used here. */
export function subjectLabel(request: OwnerRequest): string {
  return request.detail.kind === 'access' ? `Join “${request.detail.title}”` : 'Create a new secret channel';
}

const DECISION_LABEL: Readonly<Record<OwnerRequest['ownerDecision'], string>> = {
  pending: 'Waiting for you',
  approved: 'Approved',
  denied: 'Denied',
};

export function decisionLabel(request: OwnerRequest): string {
  if (request.outcome === 'expired') return 'Expired before a decision';
  if (request.outcome === 'revoked' && request.ownerDecision === 'pending') return 'Closed before a decision';
  return DECISION_LABEL[request.ownerDecision];
}

/**
 * The agent's connector reports readiness separately from the owner's
 * decision. Approval alone never reads as connected.
 */
export function connectionLabel(request: OwnerRequest): string {
  switch (request.outcome) {
    case 'pending_owner':
      return 'Not started. Nothing happens until you decide.';
    case 'approved':
      return 'Waiting for the agent’s connector to pick up your approval';
    case 'connecting':
      return 'Connecting';
    case 'connected':
      return 'Connected';
    case 'repair_required':
      return 'Repair required on the agent’s connector';
    case 'denied':
      return 'Not connected';
    case 'expired':
      return 'Not connected. The request expired.';
    case 'revoked':
      return 'Not connected. The request was closed because the channel or agent changed.';
  }
}

const ACCESS_CAPABILITIES: readonly DecisionFact[] = [
  { label: 'Messages', value: 'Read new messages and send messages in this channel' },
  { label: 'history', value: 'none' },
  { label: 'Admits', value: 'Only the requesting agent session' },
];

const CREATE_CAPABILITIES: readonly DecisionFact[] = [
  { label: 'Creates', value: 'One new secret channel that you own' },
  { label: 'Messages', value: 'Read new messages and send messages in that channel' },
  { label: 'history', value: 'none' },
  { label: 'Admits', value: 'Only the requesting agent session' },
];

/** The operation adapter for the shared decision dialog. */
export function toDecisionPrompt(request: OwnerRequest): DecisionPrompt {
  const verified: DecisionFact[] = [
    { label: 'Harness', value: request.requester.harness },
    { label: 'Session fingerprint', value: request.requester.sessionFingerprint, code: true },
  ];
  if (request.detail.kind === 'access') verified.push({ label: 'Channel', value: request.detail.title });
  verified.push({ label: 'Requested', value: request.createdAt }, { label: 'Expires', value: request.deadline });

  const untrusted: DecisionFact[] = [];
  if (request.requester.displayLabel !== null) untrusted.push({ label: 'Name', value: request.requester.displayLabel });
  if (request.requester.workspaceLabel !== null) untrusted.push({ label: 'Workspace', value: request.requester.workspaceLabel });
  if (request.detail.kind === 'create') untrusted.push({ label: 'Proposed channel title', value: request.detail.proposedTitle });

  const access = request.operationKind === 'access';
  return {
    kind: operationLabel(request),
    question: access ? `Let this agent session join “${request.detail.kind === 'access' ? request.detail.title : ''}”?` : 'Create a secret channel for this agent session?',
    verified,
    untrusted,
    capabilities: access ? ACCESS_CAPABILITIES : CREATE_CAPABILITIES,
    notices: [
      access
        ? 'The agent sees no earlier messages, members, or activity.'
        : 'Approving creates exactly one secret channel and authorizes admission only for the requesting session. Nobody else can find it.',
      'Your approval is recorded first. The agent connects only when its own connector picks it up, and this page shows that separately.',
    ],
    progress: [
      { label: 'Your decision', value: decisionLabel(request) },
      { label: 'Agent connection', value: connectionLabel(request) },
    ],
    approveLabel: access ? 'Approve access' : 'Approve and create',
    denyLabel: 'Deny',
  };
}

export type MuteScope = 'requester_channel' | 'requester_owner';

export function muteScope(request: OwnerRequest): MuteScope {
  return request.operationKind === 'access' ? 'requester_channel' : 'requester_owner';
}

export function muteActionLabel(request: OwnerRequest): string {
  const verb = request.muted ? 'Unmute' : 'Mute';
  return request.operationKind === 'access'
    ? `${verb} this agent’s requests for this channel`
    : `${verb} this agent’s channel-creation requests`;
}

/** A toast-style, non-modal notice. It links to the inbox and never opens a decision. */
export type InboxNotice = Readonly<{
  notificationId: string;
  revision: string;
  requestHandle: ChannelAccessRequestHandle | null;
  count: number;
}>;

export type InboxStatus =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'muted'; muted: boolean; operationKind: OwnerRequest['operationKind'] }>
  | Readonly<{ kind: 'mute_refreshed' }>
  | Readonly<{ kind: 'mute_failed'; code: 'forbidden' | 'not_found' | 'operation_mismatch' | 'unavailable' | 'unknown' }>
  | Readonly<{ kind: 'authority_lost' }>
  | Readonly<{ kind: 'refresh_failed' }>;

export type DialogState = Readonly<{
  handle: ChannelAccessRequestHandle;
  /** The last safe projection shown; kept even if a refresh drops the row. */
  request: OwnerRequest;
  status: DecisionStatus;
}>;

export type InboxView = Readonly<{
  phase: 'loading' | 'ready' | 'load_failed';
  /** Decoded, retained requests from the latest successful read. */
  requests: readonly OwnerRequest[];
  /** Projections the decoder refused; shown only as a count. */
  rejectedCount: number;
  readOnly: boolean;
  /** The row a notification or direct navigation pointed at. */
  selected: ChannelAccessRequestHandle | null;
  /** Increments on every selection so the same row can be revisited. */
  selectionSequence: number;
  dialog: DialogState | null;
  notices: readonly InboxNotice[];
  muting: ChannelAccessRequestHandle | null;
  status: InboxStatus;
}>;

export const INITIAL_INBOX_VIEW: InboxView = {
  phase: 'loading',
  requests: [],
  rejectedCount: 0,
  readOnly: false,
  selected: null,
  selectionSequence: 0,
  dialog: null,
  notices: [],
  muting: null,
  status: { kind: 'idle' },
};

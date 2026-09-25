/**
 * Shared owner-decision prompt. Each adapter (channel access, channel
 * creation, pairing) turns its own safe projection into this shape; the
 * dialog shell renders it and owns keyboard, focus, and status behavior.
 *
 * Every field is plain text. Nothing here can carry markup, links, or
 * controls, so agent-supplied text can never become an action.
 */

/** A server-derived fact the owner can rely on. */
export type DecisionFact = Readonly<{
  label: string;
  value: string;
  /** Monospace rendering for fingerprints and other opaque identifiers. */
  code?: boolean;
}>;

export type DecisionPrompt = Readonly<{
  /** Names the kind of request, for example "Channel access request". */
  kind: string;
  /** The decision the owner is asked to make. */
  question: string;
  /** Verified identity first: harness, fingerprint, and similar server facts. */
  verified: readonly DecisionFact[];
  /** Requester-supplied labels. Always rendered as unverified. */
  untrusted: readonly DecisionFact[];
  /** Fixed, server-derived capabilities approval grants. Never requester text. */
  capabilities: readonly DecisionFact[];
  /** Plain-language consequences of approving, shown before the actions. */
  notices: readonly string[];
  /**
   * Owner decision and downstream readiness, kept as separate rows so an
   * approval is never read as "connected".
   */
  progress: readonly DecisionFact[];
  approveLabel: string;
  denyLabel: string;
}>;

export type DecisionChoice = 'approve' | 'deny';

export type DecisionStatus =
  | Readonly<{ kind: 'idle' }>
  /** The request changed and was reloaded; the owner reviews it and decides again. */
  | Readonly<{ kind: 'refreshed'; message: string }>
  | Readonly<{ kind: 'submitting'; decision: DecisionChoice }>
  /** Nothing is known to be recorded. `retry` resends the same decision. */
  | Readonly<{ kind: 'retryable'; decision: DecisionChoice; message: string }>
  /** The request changed or can no longer be decided; the owner can close or review again. */
  | Readonly<{ kind: 'blocked'; message: string }>
  /** The decision was recorded. */
  | Readonly<{ kind: 'decided'; message: string }>;

export function isDecidable(status: DecisionStatus): boolean {
  return status.kind === 'idle' || status.kind === 'refreshed';
}

/** One sentence for the dialog's live region. */
export function statusAnnouncement(status: DecisionStatus, prompt: DecisionPrompt): string {
  switch (status.kind) {
    case 'idle':
      return '';
    case 'submitting':
      return status.decision === 'approve' ? `Sending: ${prompt.approveLabel}…` : `Sending: ${prompt.denyLabel}…`;
    case 'refreshed':
    case 'retryable':
    case 'blocked':
    case 'decided':
      return status.message;
  }
}

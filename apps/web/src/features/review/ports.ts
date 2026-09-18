// Injected dependencies for the review feature. Live composition (KHA-134)
// supplies a real `ReviewUiPort` adapter backed by authenticated human
// composition; tests supply synthetic ones. This file imports no SDK, storage
// or network code.
//
// `approve` accepts only an `ApprovalCommand` (KHA-106). It never accepts an
// `OwnerAuthority` object from browser state — only trusted server/owner-
// endpoint composition constructs one (KTD2); this port's implementation is
// responsible for attaching it out of band.

import type { ApprovalCommand, ApprovalErrorCode } from '@khala/contracts/delivery/index';
import type { CommandId, ReleaseId } from '@khala/contracts/delivery/ids';
import type { ReviewView } from './model';

/**
 * Browser-local approval outcome. `outcome_unknown` covers interrupted
 * waiting for the request itself (e.g. the connection dropped); it carries the
 * same `commandId` the caller already holds so the caller can reconcile it,
 * never issue a fresh command to make a spinner disappear (KTD2, U3).
 */
export type ApprovalUiResult =
  | Readonly<{ kind: 'accepted'; releaseIds: readonly ReleaseId[] }>
  | Readonly<{ kind: 'rejected'; code: ApprovalErrorCode }>
  | Readonly<{ kind: 'outcome_unknown'; commandId: CommandId }>;

export interface ReviewUiPort {
  /** Cached-safe: returns the current `ReviewView` synchronously. */
  snapshot(): ReviewView;
  /** Notifies on any `ReviewView` change. Registration is released when `signal` aborts. */
  subscribe(listener: () => void, signal: AbortSignal): () => void;
  /** Submits one approval command. Aborting `signal` does not cancel a write already in flight. */
  approve(command: ApprovalCommand, signal: AbortSignal): Promise<ApprovalUiResult>;
}

export interface ReviewPorts {
  review: ReviewUiPort;
}

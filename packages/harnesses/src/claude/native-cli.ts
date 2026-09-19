// Native Claude facts and the delivery seam selected by KHA-145. The proof did
// not validate either candidate route, so the adapter injects this port but does
// not call it until a later evidence document can support a route.

import type { ReleasedJob } from '@khala/contracts/delivery/index';

/** `not_owned`: the session exists but not under the owner this connector runs as. */
export type ClaudeSessionState = 'present' | 'absent' | 'not_owned';

export interface ClaudeNativeProbe {
  /** The installed Claude Code version as the native binary reports it, or null. */
  installedVersion(): Promise<string | null>;
  /** Looks up the bound session without resuming it or reading its transcript. */
  session(sessionId: string): Promise<ClaudeSessionState>;
}

export type ClaudeRouteSubmission = Readonly<{
  job: ReleasedJob;
  /** Released bytes. A route must keep them out of argv, environment, errors and logs. */
  payload: Uint8Array;
}>;

export type ClaudeNativeRouteOutcome =
  | Readonly<{ status: 'not_sent' }>
  | Readonly<{ status: 'lost'; written: boolean; cause: 'disconnected' | 'timeout' }>
  | Readonly<{ status: 'accepted'; evidenceRef: string }>;

/** One replaceable route seam; neither rejected KHA-145 candidate is hard-coded here. */
export interface ClaudeNativeRoutePort {
  submit(input: ClaudeRouteSubmission): Promise<ClaudeNativeRouteOutcome>;
}

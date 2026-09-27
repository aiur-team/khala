import type { CallOptions, OperationResult } from '@khala/contracts/messaging/outcomes';

// What the Make-external journey needs from the hosted service besides the conversion
// ports. Sign-in is a new hosted sign-in for this conversion: the human completes it on
// a hosted page in another tab and the loopback server asks for its outcome. Nothing
// hosted ever calls back into the loopback server, which stays loopback-only.

export type HostedSignInAttempt = Readonly<{
  /** Opaque handle of this sign-in attempt; never a credential. */
  attempt: string;
  /** Hosted page the human completes the sign-in on. */
  verificationUrl: string;
}>;

export type HostedSignInOutcome = 'pending' | 'signed_in' | 'denied' | 'expired' | 'unavailable';

export interface HostedSignInPort {
  /** Starts a new hosted sign-in for one journey; idempotent by `operationId`. */
  begin(
    input: Readonly<{ journeyId: string; operationId: string }>, options?: CallOptions,
  ): Promise<OperationResult<HostedSignInAttempt, 'forbidden'>>;
  status(attempt: string, options?: CallOptions): Promise<HostedSignInOutcome>;
}

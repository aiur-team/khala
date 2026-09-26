import type { CallOptions, OperationResult, PairingDecisionRequest } from '@khala/contracts/messaging/index';

export type PairingInspectRejection = 'signed_out' | 'forbidden' | 'not_found' | 'feature_unavailable';
export type PairingDecideRejection =
  | 'invalid_request'
  | 'signed_out'
  | 'forbidden'
  | 'stale_claim'
  | 'decision_conflict'
  | 'expired'
  | 'feature_unavailable';

/**
 * The signed-in owner's side of the pairing control routes
 * (`/api/human/pairing/request` GET and `/api/human/pairing/decision`), already
 * bound to the authenticated human by the host composition.
 *
 * Results are `unknown` on purpose: the controller decodes every projection
 * through the contract decoders before rendering any of it.
 */
export interface PairingApprovalPort {
  inspect(requestHandle: string, options?: CallOptions): Promise<OperationResult<unknown, PairingInspectRejection>>;
  decide(input: PairingDecisionRequest, options?: CallOptions): Promise<OperationResult<unknown, PairingDecideRejection>>;
}

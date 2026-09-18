// Public surface of exact approval release (KHA-119). Pure policy: callers inject
// verified authority and trusted snapshots; KHA-134 commits the decision.

export {
  type DigestResult, type EncodeResult, type ReleasePayloadInput, RELEASE_ENCODING_V1, encodeReleasePayload,
} from './codec';
export { evaluateApproval } from './evaluate';
export { DECISION_FINGERPRINT_V1, decisionFingerprint } from './handoff';
export type {
  EvaluateInput, Evaluation, PendingRecord, RejectionReason, ReleaseContent, ReleaseDecision, ReleaseIdentity,
  ReleaseRejection, ReleaseRejectionCode, RoomScope, UnavailableReleaseContent,
} from './types';

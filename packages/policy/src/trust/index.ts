// Public surface of the trust policy module (KHA-120). Pure decisions only:
// trust-controls composition persists state with compare-and-set and delivers the
// returned effects; storage, dispatch and delivery own their own receipts.

export {
  type AutomationConfig, type BindingStatus, type ConnectorObservation, type JournalEntry, type PolicyActor, type PolicyChangeOutcome,
  type PolicyChangeRejection, type PolicyMode, type PolicyRevision, type PublishPolicyEffect, type TrustState,
  type TrustView,
} from './types';
export {
  type AckIgnoredReason, type AckOutcome, type AckTransition, type PolicyChange, type RebindOutcome,
  applyPolicyAck, applyRebind, evaluatePolicyChange, initialTrustState, trustView,
} from './transitions';
export {
  type AutomaticReleaseDecision, type AutomaticReleaseInput, type AutomaticReleaseSpec, type HoldReason,
  type PolicyFreshness,
  evaluateAutomaticRelease,
} from './automatic';

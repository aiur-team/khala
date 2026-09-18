// Public surface of the connector retention module (KHA-130). KHA-133 schedules
// `sweepRetention` and binds the ports; this module starts nothing on its own.

export {
  type ClaimStatus, type DeferReason, type DeleteReason, type RetentionAction, type RetentionDecision,
  type RetentionPolicy, type RetentionRecord,
  decodeRetentionPolicy, evaluateRecord,
} from './eligibility';
export {
  type CryptoMaintenanceOutcome, type FailureReason, type RefusalReason, type RetentionLimit, type RetentionReason,
  type RetentionReport, type SweepOutcome, RETENTION_LIMITS,
} from './report';
export {
  type ActiveClaimPort, type ApplyResult, type Clock, type RecordPage, type RetentionOperation, type RetentionPorts,
  type RetentionRecordPort, type SupportedCryptoMaintenancePort, type SweepCursor, type SweepInput,
  retentionOperationId, sweepRetention,
} from './sweep';

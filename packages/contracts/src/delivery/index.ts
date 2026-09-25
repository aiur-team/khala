// Public surface of the default-free delivery contract checkpoint (KHA-106).
// This domain mirrors messaging scalars independently and imports no messaging,
// policy, connector or harness implementation.

export {
  type Decoded, type DeliveryDecodeError, type DeliveryDecodeErrorCode, type DeliveryLimits,
  MAX_IDENTIFIER_BYTES, decodeDeliveryLimits,
} from './decode';
export {
  type AuthorizationId, type BindingId, type CausalRootId, type CommandId, type DeviceId,
  type EventId, type Id, type IdKind, type OperationId, type OwnerId, type ParticipantId,
  type ReceiptId, type ReleaseId, type RoomId,
  decodeAuthorizationId, decodeBindingId, decodeCausalRootId, decodeCommandId,
  decodeDeviceId, decodeEventId, decodeOperationId, decodeOwnerId, decodeParticipantId,
  decodeReceiptId, decodeReleaseId, decodeRoomId,
} from './ids';
export {
  type EventRef, decodeEventRef, sameEventIdentity, sameEventRef,
} from './events';
export {
  type SessionBinding, decodeSessionBinding, sameSessionBinding,
} from './binding';
export {
  type ReleaseApproval, type ReleaseEnvelope, type ReleaseRejectionCode, type Released, type ReleasedJob,
  type UnverifiedReleasedJob,
  decodeReleasedJob, releaseFromApproval, validatePayloadBytes, verifyReleasedJob,
} from './jobs';
export {
  type ApprovalCommand, type ApprovalErrorCode, type ApprovalPort, type ApprovalResult,
  type OwnerAuthority, type PolicyAck, type PolicyAckErrorCode, type PolicySetCommand,
  decodeApprovalCommand, decodeApprovalResult, decodePolicyAck, decodePolicySetCommand,
  sameApprovalCommandInput, samePolicySetCommandInput,
} from './commands';
export {
  type DeliveryReceipt, type ReceiptErrorCode, type ReceiptKind, RECEIPT_ERROR_CODES, RECEIPT_KINDS,
  decodeDeliveryReceipt,
} from './receipts';
export {
  type AcknowledgementSupport, type ListeningMode, type ListeningModeCommand, type ListeningModeResult,
  type ModeSupport, type ModeSupportMap, type OwnerRouteGrantCommand, type RouteGrant,
  ACKNOWLEDGEMENT_SUPPORT, LISTENING_MODES, LISTENING_MODE_RESULT_OUTCOMES, MODE_SUPPORT_STATUSES,
  OWNER_ROUTE_GRANT_COMMAND_KINDS,
  decodeListeningMode, decodeListeningModeCommand, decodeListeningModeResult, decodeModeSupport,
  decodeModeSupportMap, decodeOwnerRouteGrantCommand, initialListeningMode, routeGrantMatches,
  unknownModeSupport, unknownModeSupportMap,
} from './listening-mode';
export {
  type Clock, type EvidenceSink, type HarnessCapabilities, type HarnessPort, BUSY_BEHAVIORS,
  EXISTING_SESSION_SUPPORT, HARNESS_SUPPORT, IMMEDIATE_NOTIFICATION_SUPPORT, RECONCILE_SUPPORT,
  decodeHarnessCapabilities,
} from './harness';
export {
  type AppHarness, type AppHarnessBoundaries, type AppHarnessIdentity, type AppHarnessRecord,
  type AppHarnessShape, type AppHookBoundary,
  APP_HARNESSES, APP_HARNESS_SHAPES, APP_HOOK_BOUNDARIES,
  decodeAppHarnessRecord, sameAppHarnessIdentity,
} from './app-harness';

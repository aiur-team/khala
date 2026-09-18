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
  type ReleasedJob, decodeReleasedJob, validatePayloadBytes,
} from './jobs';
export {
  type ApprovalCommand, type ApprovalErrorCode, type ApprovalPort, type ApprovalResult,
  type OwnerAuthority, type PolicyAck, type PolicyAckErrorCode, type PolicySetCommand,
  decodeApprovalCommand, decodePolicyAck, decodePolicySetCommand,
  sameApprovalCommandInput, samePolicySetCommandInput,
} from './commands';
export {
  type DeliveryReceipt, type ReceiptKind, RECEIPT_KINDS, decodeDeliveryReceipt,
} from './receipts';
export {
  type HarnessCapabilities, type HarnessPort, decodeHarnessCapabilities,
} from './harness';

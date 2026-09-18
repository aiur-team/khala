// Public surface of the messaging contract domain. Contract data and interfaces
// only: no SDK, storage or delivery-domain imports. Test fixtures are not exported.

export {
  type ContentLimits, type DecodeError, type DecodeErrorCode, type Decoded, MAX_IDENTIFIER_BYTES,
} from './decode';
export {
  type CallOptions, type Disposer, type GenerationTagged, type OperationResult,
  isCurrentGeneration, ok, outcomeUnknown, rejected, unavailable,
} from './outcomes';
export {
  type AuthPrincipal, type IdentityPort, type IdentityState, type ParticipantView, type SessionBinding, type SignInIntent,
  decodeAuthPrincipal, decodeParticipantView, decodeSessionBinding, isSameOriginReturnPath, sameProviderIdentity,
  sameSessionBinding,
} from './identity';
export {
  type EventRef, type MessageContent, type TimelineItem, MESSAGE_ENCODING_V1,
  decodeEventRef, decodeMessageContent, decodeTimelineItem, digestMessageContent, encodeMessageContent,
  isContentDigest, sameEventRef, verifyContentDigest,
} from './events';
export {
  type IntroBatch, type RoomMembership, type RoomPort, type RoomRejection, type RoomSnapshot, type RoomSummary,
  type SendState, type TimelinePage,
  decodeRoomSnapshot, decodeRoomSummary, decodeSendState, decodeTimelinePage,
} from './rooms';
export {
  type DevicePort, type DeviceReason, type DeviceRejection, type DeviceState, type DeviceView,
  DEVICE_REASONS, decodeDeviceView,
} from './devices';
export {
  type Admission, type AdmissionPort, type AdmissionRejection, type InviteState, type ShareGrant,
  decodeAdmission, decodeInviteState, decodeShareGrant,
} from './admission';
export {
  type RevocationPort, type RevocationProgress, type RevocationRejection, type RevocationRequest, type RevocationTarget,
  decodeRevocationProgress, decodeRevocationRequest,
} from './revocation';
export {
  type ProvideRecoverySecret, type RecoveryCapabilities, type RecoveryFailureReason, type RecoveryPort,
  type RecoveryRejection, type RecoveryState, type RecoveryStatus, type RecoveryUnavailableReason,
  RECOVERY_FAILURE_REASONS, RECOVERY_UNAVAILABLE_REASONS, decodeRecoveryCapabilities, decodeRecoveryStatus,
} from './recovery';
export {
  type CompareAndSetInput, type ControlRead, type ControlRecord, type ControlStore, type JsonValue,
  type ResolveResult, type TrustedClock, type WriteResult,
  decodeControlRecord, isRecordLive, sameJsonValue,
} from './control-store';

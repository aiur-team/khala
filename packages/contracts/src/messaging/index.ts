// Public surface of the messaging contract domain. Contract data and interfaces
// only: no SDK, storage or delivery-domain imports. Test fixtures are not exported.

export {
  type ContentLimits, type DecodeError, type DecodeErrorCode, type Decoded, MAX_IDENTIFIER_BYTES, decodeContentLimits,
} from './decode';
export {
  type BindingId, type DeviceId, type EventId, type Id, type IdKind, type OwnerId, type ParticipantId, type RoomId,
  decodeBindingId, decodeDeviceId, decodeEventId, decodeOwnerId, decodeParticipantId, decodeRoomId,
} from './ids';
export {
  type CallOptions, type Disposer, type GenerationTagged, type OperationResult,
  isCurrentGeneration, ok, outcomeUnknown, rejected, unavailable,
} from './outcomes';
export {
  type AuthPrincipal, type IdentityPort, type IdentityState, type ParticipantView, type SessionBinding, type SignInIntent,
  MAX_RETURN_PATH_BYTES, decodeAuthPrincipal, decodeParticipantView, decodeSessionBinding, isSameOriginReturnPath, sameProviderIdentity,
  sameSessionBinding,
} from './identity';
export {
  type DigestResult, type EventRef, type MessageContent, type TimelineContent, type TimelineItem,
  type UnavailableContent, type UnavailableEventRef, type UnavailableReason, MESSAGE_ENCODING_V1, UNAVAILABLE_REASONS,
  decodeEventRef, decodeMessageContent, decodeTimelineContent, decodeTimelineItem, decodeUnavailableContent,
  decodeUnavailableEventRef, digestMessageContent, encodeMessageContent, isContentDigest, sameEventRef, verifyContentDigest,
} from './events';
export {
  type ChannelMembership, type ChannelPort, type ChannelRejection, type ChannelSnapshot, type ChannelSummary,
  type IntroBatch, type RoomMembership, type RoomPort, type RoomRejection, type RoomSnapshot, type RoomSummary,
  type SendState, type TimelinePage,
  decodeChannelSnapshot, decodeChannelSummary, decodeRoomSnapshot, decodeRoomSummary, decodeSendState, decodeTimelinePage,
  readChannelSummary, readRoomSummary,
} from './channels';
export {
  type DevicePort, type DeviceReason, type DeviceRejection, type DeviceState, type DeviceView,
  DEVICE_REASONS, decodeDeviceView,
} from './devices';
export {
  type Admission, type AdmissionPolicy, type AdmissionPort, type AdmissionRejection, type InviteState, type ShareGrant,
  decodeAdmission, decodeInviteState, decodeShareGrant,
} from './admission';
export {
  type RevocationPort, type RevocationProgress, type RevocationRejection, type RevocationRequest, type RevocationSubject,
  type RevocationTarget,
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
  MAX_JSON_DEPTH, decodeControlRecord, isRecordLive, sameJsonValue,
} from './control-store';
export {
  type PairingApprovalResult, type PairingClaimProjection, type PairingClaimRequest, type PairingCreateRequest,
  type PairingDecisionRequest, type PairingFailure, type PairingFailureCode, type PairingFailureRoute, type PairingGrantRedemptionRequest,
  type PairingOwnerProjection, type PairingResultRequest,
  PAIRING_FAILURE_CODES, decodePairingApprovalResult, decodePairingClaimRequest, decodePairingCreateRequest, decodePairingFailure,
  decodePairingDecisionRequest, decodePairingGrantRedemptionRequest, decodePairingOwnerProjection,
  decodePairingResultRequest, readCanonicalCode, readCanonicalOrigin,
} from './pairing';

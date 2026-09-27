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
  type AccessRequestOutcome, type AccessRequestStatus, type AdmissionGrantExchangePort, type AuthorizedChannelRef,
  type ChannelAccessRequest, type ChannelCreateAdapterPort, type ChannelCreateIntent, type ChannelCreateOutcome,
  type ChannelCreateReconciliation,
  type ChannelDiscoveryPort, type ChannelDiscoveryRejection, type ChannelListQuery, type ChannelListing,
  type ChannelListingPage, type ChannelPrivateEligibilityPort, type ChannelServiceKind, type ChannelUrlAccessRequest,
  type ChannelVisibility, type DiscoveryCredential, type DiscoveryCredentialValidity, type DiscoveryRequester,
  type DiscoveryScope, type Ed25519ProofKey, type GrantExchangeBinding, type GrantExchangeBindingMatch,
  type GrantExchangeRejection, type GrantExchangeRequest, type GrantExchangeValidation,
  type ChannelAccessReadiness, type HumanAuthorizedWorkflowContext, type KeyThumbprintResult, type ListingRefAccessRequest, type PrivateEligibilityMutation,
  type SealedGrantEnvelope, type SealedGrantPayload, type SealedGrantPayloadValidity, type StableAgentPrincipal,
  type ValidatedGrantExchangeRequest, type X25519EncryptionKey,
  ACCESS_REQUEST_OUTCOMES, CHANNEL_ACCESS_ENVELOPE_RECOVERY_MS, CHANNEL_ACCESS_GRANT_LIFETIME_MS, CHANNEL_CREATE_OUTCOMES, CHANNEL_DISCOVERY_SCOPES, CHANNEL_SEALED_BOX_ALGORITHM,
  MAX_CHANNEL_LIST_PAGE_SIZE,
  MAX_CHANNEL_TITLE_BYTES, MAX_CHANNEL_URL_BYTES, MAX_SEALED_GRANT_BYTES, classifyGrantExchangeBinding,
  deriveOkpKeyThumbprint,
  decodeAccessRequestStatus, decodeChannelAccessReadiness, decodeChannelAccessRequest, decodeChannelCreateIntent, decodeChannelCreateReconciliation,
  decodeChannelListQuery,
  decodeChannelListing, decodeChannelListingPage, decodeDiscoveryCredential, decodeGrantExchangeRequest,
  decodeSealedGrantEnvelope, decodeSealedGrantPayload, validateDiscoveryCredential, validateGrantExchangeRequest,
  validateSealedGrantPayload,
} from './discovery';
export {
  type ChannelAccessAuthorization, type ChannelAccessDecisionCommand, type ChannelAccessDecisionPort,
  type ChannelAccessDecisionRejection, type ChannelAccessFulfillmentClaim, type ChannelAccessFulfillmentPort,
  type ChannelAccessFulfillmentRejection, type ChannelAccessFulfillmentUpdate, type ChannelAccessMuteCommand,
  type ChannelAccessMuteResult, type ChannelAccessNotification, type ChannelAccessNotificationPort,
  type ChannelAccessOperationKind, type ChannelAccessOwnerOutcome, type ChannelAccessOwnerProjection,
  type ChannelAccessOwnershipResult, type ChannelAccessRequesterCheck, type ChannelAccessRequesterContext,
  type ChannelAccessRequesterProjection, type ChannelAccessRequestHandle, type ChannelAccessRequestJournalPort,
  type ChannelAccessResolutionPort, type ChannelAccessResolutionResult, type ChannelAccessResolvedTarget,
  type ChannelAccessRevalidationResult, type ChannelAccessStatusQuery, type ChannelCreateAuthorization,
  type ChannelCreateResolutionResult, type ChannelCreateResolvedTarget, type ChannelCreateRevalidationResult,
  CHANNEL_ACCESS_COOLDOWN_MS, CHANNEL_ACCESS_OWNER_OUTCOMES, CHANNEL_ACCESS_REQUEST_LIFETIME_MS,
  CHANNEL_ACCESS_SENSITIVE_RETENTION_MS, MAX_CHANNEL_ACCESS_LABEL_BYTES, MAX_CHANNEL_ACCESS_NOTIFICATIONS_PER_MINUTE,
  MAX_CHANNEL_ACCESS_OWNER_PENDING, MAX_CHANNEL_ACCESS_REQUESTER_PENDING, decodeChannelAccessDecisionCommand,
  decodeChannelAccessFulfillmentClaim, decodeChannelAccessFulfillmentUpdate, decodeChannelAccessMuteCommand,
  decodeChannelAccessNotification, decodeChannelAccessOwnerProjection, decodeChannelAccessRequesterContext,
  decodeChannelAccessStatusQuery,
} from './channel-access';
export {
  type PairingApprovalResult, type PairingClaimProjection, type PairingClaimRequest, type PairingClaimResult,
  type PairingCreateRequest, type PairingCreateResult, type PairingDecisionRequest, type PairingDecisionResult,
  type PairingFailure, type PairingFailureCode, type PairingFailureRoute, type PairingGrantRedemptionRequest,
  type PairingOwnerProjection, type PairingOwnerResult, type PairingResultRequest,
  PAIRING_FAILURE_CODES, decodePairingApprovalResult, decodePairingClaimRequest, decodePairingClaimResult,
  decodePairingCreateRequest, decodePairingCreateResult, decodePairingDecisionRequest, decodePairingDecisionResult,
  decodePairingFailure, decodePairingGrantRedemptionRequest, decodePairingOwnerProjection, decodePairingOwnerResult,
  decodePairingResultRequest, readCanonicalCode, readCanonicalOrigin,
} from './pairing';
export {
  type ConversionAdvance, type ConversionCreate, type ConversionJournalPort, type ConversionJournalRejection,
  type ConversionRecord, type ConversionState, type HistoryMode, type HistoryTransferPhase, type HistoryTransferPort,
  type HistoryTransferProgress, type HistoryTransferRejection, type HistoryTransferStep,
  type ConversionAccessPort, type ConversionAccessReadiness, type ConversionAccessRequest, type ConversionAgentBlock,
  type ConversionAgentIdentity, type ConversionAgentState, type ConversionAgentStatus, type ConversionBindingPort,
  type ConversionGrantRejection, type ConversionOwner, type ConversionSessionCheck, type ConversionSessionPort,
  type ConversionSnapshot,
  type ConversionStart, type ConversionVisibility, type HostedChannelCreate, type HostedChannelCreated, type HostedChannelPort,
  CONVERSION_AGENT_BLOCKS, CONVERSION_AGENT_STATUSES, CONVERSION_STATES, CONVERSION_TRANSITIONS, CONVERSION_VERSION,
  DEFAULT_CONVERSION_VISIBILITY, decodeConversionStart,
  decodeConversionAdvance, decodeConversionCreate, decodeConversionRecord,
  decodeHistoryTransferProgress, decodeHistoryTransferStep, isAllowedTransition,
} from './externalization';
export {
  type ImportedHistoryActor, type ImportedHistoryChunk, type ImportedHistoryChunkEntry, type ImportedHistoryLimits,
  type ImportedHistoryManifest, type ImportedHistoryRecord, type ImportedHistoryRecordInput, type ImportedHistorySource,
  type ImportedOriginalAuthor, type SealImportedHistoryInput, type SealedImportedHistory, type VerifiedImportedHistory,
  IMPORTED_CHUNK_ENCODING_V1, IMPORTED_MANIFEST_ENCODING_V1, IMPORTED_RECORD_ENCODING_V1, decodeImportedHistoryChunk,
  decodeImportedHistoryLimits, digestImportedHistoryManifest, encodeImportedHistoryManifest,
  decodeImportedHistoryManifest, encodeImportedHistoryChunk, encodeImportedRecord, openImportedHistory, sealImportedHistory,
} from './imported-history';

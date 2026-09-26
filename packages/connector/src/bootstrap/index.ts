// Public surface of the connector bootstrap (KHA-114). KHA-133 composes it with
// real storage, harness adapters and the owner's device; see README.md.

export {
  type BlockedCode, type BootstrapInput, type BootstrapResult, BLOCKED_CODES, bootstrapAgent, operationFingerprint,
} from './orchestrator';
export { type AdapterAction, type AdapterCapability, ADAPTER_CAPABILITIES } from './ports';
export type {
  AdmissionOutcome, BootstrapAdmissionPort, BootstrapOperationStore, BootstrapPorts, ConnectorDevicePort, DeviceActivation,
  DeviceReservation, DeviceStatus, DiscoveryPort, OperationRead, OperationRecord, OperationWrite, OwnershipGrant,
  OwnershipOutcome, OwnershipPort, SessionClaim, SessionInspection, SessionInspectionPort, VerifiedSession,
} from './ports';
export {
  type DiscoveryOptions, type DiscoveryRejection, type DiscoveryResult, createDiscovery,
} from './discovery';
export {
  type BootstrapDescriptor, type OwnershipMethod, AUTHORIZE_PATH, DESCRIPTOR_PATH, OWNERSHIP_METHODS, REDEEM_PATH, TOKEN_PATH,
  decodeDescriptor,
} from './descriptor';
export { type HttpAdmissionOptions, type LoopbackOwnershipOptions, createHttpAdmission, createLoopbackOwnership } from './loopback';
export { type ProofSigner, createProofSigner } from './proof';
export {
  type ChannelDiscoveryAuthorizationOutcome,
  type ChannelDiscoveryAuthorizeInput,
  type ChannelDiscoveryCredentialClient,
  type ChannelDiscoveryCredentialClientOptions,
  type ChannelDiscoveryRefreshOutcome,
  type DiscoveryBootstrapRejection,
  CHANNEL_DISCOVERY_AUTHORIZE_PATH,
  CHANNEL_DISCOVERY_TOKEN_PATH,
  DEFAULT_CHANNEL_DISCOVERY_TIMEOUT_MS,
  createChannelDiscoveryCredentialClient,
} from './channel-discovery';
export {
  type ActivationPhase,
  type ActivationPolling,
  type ActivationRead,
  type ActivationRecord,
  type ActivationResult,
  type ActivationWrite,
  type ChannelAccessActivationPorts,
  type ChannelAccessActivationStore,
  type ChannelAccessExchangeClient,
  type ChannelAccessRedeemPort,
  type ChannelAccessStatusPort,
  type ClosedOutcome,
  type ExchangeOutcome,
  type JournalRequestInput,
  type ReadinessOutcome,
  type RecoveryKeyWrite,
  type RepairReason,
  type ReviewTrustPort,
  type TrustInitialization,
  ACTIVATION_PHASES,
  CLOSED_OUTCOMES,
  DEFAULT_ACTIVATION_POLLING,
  REPAIR_REASONS,
  activateChannelAccess,
  decodeActivationRecord,
  journalChannelAccessRequest,
  resumeChannelAccessActivations,
} from './channel-access-activation';
export {
  type ChannelAccessHttpOptions,
  CHANNEL_ACCESS_EXCHANGE_PATH,
  CHANNEL_ACCESS_READY_PATH,
  CHANNEL_ACCESS_STATUS_PATH,
  createHttpChannelAccessClient,
  createHttpChannelAccessStatus,
} from './channel-access-http';

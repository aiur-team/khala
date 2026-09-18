// Public surface of the revocation module (KHA-128). Composition roots bind the ports.

export {
  type CapabilityBoundary, type ControlBoundary, type EndpointBoundary, type ExcludedDevice, type OperationState,
  type ProtocolRefusal, type RemovalBoundary, type RevocationLimitation, type RevocationStatus, type RotationBoundary,
} from './operation';
export {
  type AcknowledgmentOutcome, type DeviceRemovalResult, type DeviceStatusResult, type EndpointAcknowledgment,
  type ProtocolRevocationPort, type SessionRotationResult,
} from './reconcile';
export {
  type AcknowledgmentReceiver, type AcknowledgmentReceiverDeps, type CapabilityRevocationResult, type DisableResult,
  type RevocationControlPort, type RevocationService, type RevocationServiceDeps, type RevocationTargets, type TargetLookup,
  createAcknowledgmentReceiver, createRevocationService,
} from './service';

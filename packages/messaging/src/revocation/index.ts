// Public surface of the revocation module (KHA-128). Composition roots bind the ports.

export {
  type ControlBoundary, type EndpointBoundary, type OperationState, type ProtocolBoundary, type ProtocolRefusal,
  type RevocationLimitation, type RevocationStatus,
} from './operation';
export {
  type AcknowledgmentOutcome, type DeviceRemovalResult, type DeviceStatusResult, type EndpointAcknowledgment,
  type ProtocolRevocationPort,
} from './reconcile';
export {
  type DisableResult, type RevocationControlPort, type RevocationService, type RevocationServiceDeps, type RevocationTargets,
  type TargetLookup, createRevocationService,
} from './service';

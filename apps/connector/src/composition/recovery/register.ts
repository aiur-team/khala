import {
  unavailableCapability,
  type ConnectorCapability,
  type ConnectorCapabilityContext,
} from '../../runtime/capabilities';

export interface RecoveryProtectedTransportPort {
  readonly capability: 'recovery';
}

export type RecoveryCapabilityDependencies = Readonly<{
  protectedTransport?: RecoveryProtectedTransportPort;
}>;

export type RecoveryCapabilityContext = ConnectorCapabilityContext & Readonly<{
  dependencies: RecoveryCapabilityDependencies;
}>;

export function registerRecovery(context: RecoveryCapabilityContext): ConnectorCapability {
  void context;
  return unavailableCapability('recovery');
}

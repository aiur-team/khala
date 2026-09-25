import {
  unavailableCapability,
  type ConnectorCapability,
  type ConnectorCapabilityContext,
} from '../../runtime/capabilities';

export interface ControlsProtectedTransportPort {
  readonly capability: 'controls';
}

export type ControlsCapabilityDependencies = Readonly<{
  protectedTransport?: ControlsProtectedTransportPort;
}>;

export type ControlsCapabilityContext = ConnectorCapabilityContext & Readonly<{
  dependencies: ControlsCapabilityDependencies;
}>;

export function registerControls(context: ControlsCapabilityContext): ConnectorCapability {
  void context;
  return unavailableCapability('controls');
}

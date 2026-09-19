import {
  unavailableCapability,
  type ConnectorCapability,
  type ConnectorCapabilityContext,
} from '../../runtime/capabilities';

export function registerControls(context: ConnectorCapabilityContext): ConnectorCapability {
  void context;
  return unavailableCapability('controls');
}

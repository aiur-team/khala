import {
  unavailableCapability,
  type ConnectorCapability,
  type ConnectorCapabilityContext,
} from '../../runtime/capabilities';

export function registerRecovery(context: ConnectorCapabilityContext): ConnectorCapability {
  void context;
  return unavailableCapability('recovery');
}

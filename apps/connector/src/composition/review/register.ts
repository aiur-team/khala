import {
  unavailableCapability,
  type ConnectorCapability,
  type ConnectorCapabilityContext,
} from '../../runtime/capabilities';

export function registerReview(context: ConnectorCapabilityContext): ConnectorCapability {
  void context;
  return unavailableCapability('review');
}

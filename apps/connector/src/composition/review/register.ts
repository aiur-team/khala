import {
  unavailableCapability,
  type ConnectorCapability,
  type ConnectorCapabilityContext,
} from '../../runtime/capabilities';

export interface ReviewProtectedTransportPort {
  readonly capability: 'review';
}

export type ReviewCapabilityDependencies = Readonly<{
  protectedTransport?: ReviewProtectedTransportPort;
}>;

export type ReviewCapabilityContext = ConnectorCapabilityContext & Readonly<{
  dependencies: ReviewCapabilityDependencies;
}>;

export function registerReview(context: ReviewCapabilityContext): ConnectorCapability {
  void context;
  return unavailableCapability('review');
}

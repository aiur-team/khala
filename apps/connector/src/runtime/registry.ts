import { registerControls, type ControlsCapabilityDependencies } from '../composition/controls/register';
import { registerRecovery, type RecoveryCapabilityDependencies } from '../composition/recovery/register';
import { registerReview, type ReviewCapabilityDependencies } from '../composition/review/register';
import {
  type ConnectorCapability,
  type ConnectorCapabilityContext,
  validateCapabilityRegistry,
} from './capabilities';

export { validateCapabilityRegistry } from './capabilities';

export type ConnectorCapabilityDependencies = Readonly<{
  review: ReviewCapabilityDependencies;
  controls: ControlsCapabilityDependencies;
  recovery: RecoveryCapabilityDependencies;
}>;

export function registerConnectorCapabilities(
  context: ConnectorCapabilityContext,
  dependencies: ConnectorCapabilityDependencies,
): readonly ConnectorCapability[] {
  return validateCapabilityRegistry([
    registerReview({ ...context, dependencies: dependencies.review }),
    registerControls({ ...context, dependencies: dependencies.controls }),
    registerRecovery({ ...context, dependencies: dependencies.recovery }),
  ]);
}

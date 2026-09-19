import { registerControls } from '../composition/controls/register';
import { registerRecovery } from '../composition/recovery/register';
import { registerReview } from '../composition/review/register';
import {
  type ConnectorCapability,
  type ConnectorCapabilityContext,
  validateCapabilityRegistry,
} from './capabilities';

export { validateCapabilityRegistry } from './capabilities';

export function registerConnectorCapabilities(
  context: ConnectorCapabilityContext,
): readonly ConnectorCapability[] {
  return validateCapabilityRegistry([
    registerReview(context),
    registerControls(context),
    registerRecovery(context),
  ]);
}

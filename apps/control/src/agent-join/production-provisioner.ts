import type { ProductionHumanRuntime } from '../composition/human/production';
import { createAgentProvisioner } from './provision';

export function createProductionAgentProvisioner(active: ProductionHumanRuntime, fetch?: typeof globalThis.fetch) {
  return createAgentProvisioner({
    homeserverOrigin: active.env.publicHomeserverOrigin, serverName: active.env.matrixServerName,
    registrationSharedSecret: active.env.matrixRegistrationSharedSecret,
    registrationIngressToken: active.env.matrixRegistrationIngressToken,
    passwordDerivationSecret: active.env.matrixPasswordDerivationSecret,
    joinSecret: active.env.invitationHmacSecret, ...(fetch ? { fetch } : {}),
  });
}

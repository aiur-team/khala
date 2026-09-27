import type { RouteRegistration } from '../runtime/handler';
import { createInviteEvidenceReader } from './agent/invite-evidence';
import { createProductionBootstrapRoutes, type ProductionBootstrapDependencies } from './agent/production-bootstrap';
import { registerAgentHandlers } from './agent/handlers';
import { registerHumanHandlers } from './human/handlers';
import { createProductionHumanRuntimeLoader } from './human/production';

export type HostedProductionOptions = Omit<ProductionBootstrapDependencies, 'admissionPolicy'>;

/**
 * The generated Netlify function calls this exact composition root. The
 * product's visible owner-consent choice is still pending: absence or any
 * unrecognized mode leaves bootstrap and device attestation unavailable.
 */
export function registerHostedProductionRoutes(
  options: HostedProductionOptions = {},
): readonly RouteRegistration[] {
  const env = options.env ?? process.env;
  if (env.KHALA_ADMISSION_MODE !== 'explicit_browser_consent') {
    return Object.freeze([...registerHumanHandlers(), ...registerAgentHandlers()]);
  }
  const runtime = createProductionHumanRuntimeLoader(options);
  const bootstrap = createProductionBootstrapRoutes({
    ...options,
    admissionPolicy: async ({ principal, inviteRef, session }) => {
      if (!session.harness || !session.sessionId || !Number.isSafeInteger(session.generation)) return 'deny';
      try {
        const active = runtime();
        const evidence = await createInviteEvidenceReader({
          store: active.store, secret: active.env.invitationHmacSecret, clock: active.clock,
        })(principal, inviteRef);
        return evidence === null ? 'deny' : 'allow';
      } catch { return 'deny'; }
    },
  });
  return Object.freeze([
    ...registerHumanHandlers({ bootstrap: () => bootstrap.human, ownerMailbox: () => bootstrap.ownerMailbox.human }),
    ...registerAgentHandlers({
      bootstrap: () => bootstrap.agent,
      deviceAttestation: () => bootstrap.deviceAttestation,
      ownerMailbox: () => bootstrap.ownerMailbox.agent,
    }),
  ]);
}

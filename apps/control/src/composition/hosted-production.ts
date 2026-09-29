import type { RouteRegistration } from '../runtime/handler';
import { registerClosureHandlers } from '../channel-closure/production';
import { createInviteEvidenceReader } from './agent/invite-evidence';
import { createProductionBootstrapRoutes, type ProductionBootstrapDependencies } from './agent/production-bootstrap';
import { registerAgentHandlers } from './agent/handlers';
import { registerHumanHandlers, unavailableChannelAccessRoutes } from './human/handlers';
import { createProductionHumanRuntimeLoader } from './human/production';
import { createHostedChannelAccessInbox } from './human/hosted-channel-access';
import { createHostedChannelAccessRoutes, type HostedChannelAccessPorts } from './human/hosted-channel-access-routes';

export type HostedProductionOptions = Omit<ProductionBootstrapDependencies, 'admissionPolicy'> & Readonly<{
  /** Supplied only after the exact native-session authority is available. */
  channelAccess?: HostedChannelAccessPorts;
}>;

/**
 * The generated Netlify function calls this exact composition root. The
 * The production Khala site has opted into explicit browser consent. Other
 * origins still require the exact mode; an explicit invalid mode fails closed.
 */
export function registerHostedProductionRoutes(
  options: HostedProductionOptions = {},
): readonly RouteRegistration[] {
  const env = options.env ?? process.env;
  const admissionMode = env.KHALA_ADMISSION_MODE
    ?? (env.PUBLIC_APP_ORIGIN === 'https://khala.aiur.team' ? 'explicit_browser_consent' : undefined);
  if (admissionMode !== 'explicit_browser_consent') {
    return Object.freeze([...registerHumanHandlers(), ...registerClosureHandlers(), ...registerAgentHandlers()]);
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
  const access = options.channelAccess ? createHostedChannelAccessRoutes(options, options.channelAccess) : null;
  return Object.freeze([
    ...registerHumanHandlers({ bootstrap: () => bootstrap.human, ownerMailbox: () => bootstrap.ownerMailbox.human,
      channelAccess: () => [createHostedChannelAccessInbox(options), ...(access?.human ?? unavailableChannelAccessRoutes.slice(1))],
      ownerDeviceProof: () => bootstrap.ownerDeviceProof.human, revocation: () => bootstrap.revocation,
      roomSend: () => bootstrap.roomSend.human, deviceAdmission: () => bootstrap.deviceAdmission }),
    ...registerClosureHandlers(),
    ...registerAgentHandlers({
      bootstrap: () => bootstrap.agent,
      ...(access ? { channelAccess: () => access.agent } : {}),
      ...(access?.exchange.length ? { channelAccessExchange: () => access.exchange } : {}),
      deviceAttestation: () => bootstrap.deviceAttestation,
      ownerMailbox: () => bootstrap.ownerMailbox.agent,
      ownerDeviceProof: () => bootstrap.ownerDeviceProof.agent,
      revocationCleanup: () => bootstrap.revocationCleanup,
      roomSend: () => bootstrap.roomSend.agent,
    }),
  ]);
}

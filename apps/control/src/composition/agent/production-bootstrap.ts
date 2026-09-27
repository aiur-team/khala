import { randomBytes } from 'node:crypto';
import {
  createAgentBootstrapHandlers, type AdmissionPolicy, type AgentAdmissionPort, type AgentDeviceSessionPort,
} from '../../agent-bootstrap/handler';
import { createAdmissionService } from '../../invitations';
import {
  createProductionHumanRuntimeLoader,
  type ProductionHumanDependencies,
} from '../human/production';
import { createLazyBootstrapRoutes } from './bootstrap-routes';
import { createDeviceAttestationRoutes, createLazyDeviceAttestationRoutes } from './device-attestation';
import { createInviteEvidenceReader } from './invite-evidence';
import { createMatrixAgentAdmission } from './matrix-admission';
import { createLazyOwnerMailboxRoutes, createOwnerMailboxRoutes } from '../owner-mailbox/routes';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type ProductionBootstrapDependencies = ProductionHumanDependencies & Readonly<{
  /** A substrate adapter that verifies the exact agent participant before admission. */
  /** Tests may supply a controlled provider; production constructs the Matrix adapter. */
  agents?: AgentAdmissionPort;
  agentDeviceSession?: AgentDeviceSessionPort;
  /** Explicit G-ADMISSION choice; there is deliberately no silent default. */
  admissionPolicy: AdmissionPolicy;
}>;

/** Parse only the canonical share URL, without accepting an arbitrary same-origin path. */
export function inviteFromShareLink(url: URL, origin: string): string | null {
  if (url.origin !== origin || url.username || url.password || url.search || url.hash
    || !url.pathname.startsWith('/join/')) return null;
  const encoded = url.pathname.slice('/join/'.length);
  if (!encoded || encoded.includes('/')) return null;
  try {
    const invite = decodeURIComponent(encoded);
    return /^[A-Za-z0-9_-]{8,256}$/u.test(invite) ? invite : null;
  } catch {
    return null;
  }
}

/**
 * Bind the existing one-use bootstrap protocol to the same production OIDC,
 * Matrix and Blobs adapters that serve signed-in human invitation requests.
 * The Matrix adapter checks the exact owner/session/link before changing room
 * membership; its DPoP-bound device attestation stays separate from admission.
 */
export function createProductionBootstrapRoutes(dependencies: ProductionBootstrapDependencies) {
  const runtime = createProductionHumanRuntimeLoader(dependencies);
  const ingressToken = (dependencies.env ?? process.env).MATRIX_REGISTRATION_INGRESS_TOKEN;
  const compose = () => {
    const active = runtime();
    const matrixAgents = createMatrixAgentAdmission({
      homeserverOrigin: active.env.publicHomeserverOrigin,
      serverName: active.env.matrixServerName,
      registrationSharedSecret: active.env.matrixRegistrationSharedSecret,
      passwordDerivationSecret: active.env.matrixPasswordDerivationSecret,
      invitationHmacSecret: active.env.invitationHmacSecret,
      ...(ingressToken ? { registrationIngressToken: ingressToken } : {}),
      store: active.store,
      clock: active.clock,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    });
    const admissionFor = (ownerRequest: Request) => createAdmissionService({
      store: active.store,
      identity: active.auth.identityFor(ownerRequest),
      authority: active.matrix.authority,
      gateway: active.matrix.gateway,
      clock: active.clock,
      origin: active.env.publicAppOrigin,
      allowedOrigins: [active.env.publicAppOrigin],
      secret: active.env.invitationHmacSecret,
      inviteLifetimeMs: INVITE_TTL_MS,
    });
    const bootstrap = createAgentBootstrapHandlers({
      origin: active.env.publicAppOrigin,
      store: active.store,
      clock: active.clock,
      random: dependencies.random ?? (bytes => randomBytes(bytes)),
      authenticate: ownerRequest => active.auth.authenticateRequest(ownerRequest),
      inviteFromLink: url => inviteFromShareLink(url, active.env.publicAppOrigin),
      admissionFor,
      inviteEvidenceFor: createInviteEvidenceReader({
        store: active.store,
        secret: active.env.invitationHmacSecret,
        clock: active.clock,
      }),
      admissionPolicy: dependencies.admissionPolicy,
      agents: dependencies.agents ?? matrixAgents.agents,
      agentDeviceSession: dependencies.agentDeviceSession ?? matrixAgents.deviceSession,
      inspectOwnerMembership: active.matrix.inspectOwnerMembership,
      legacyMigrationWritesEnabled: false,
    });
    const attestation = createDeviceAttestationRoutes({
      origin: active.env.publicAppOrigin,
      store: active.store,
      capabilities: bootstrap.capabilities,
      publishedFingerprint: binding => matrixAgents.publishedDeviceFingerprint(binding),
      clock: active.clock,
      ...(dependencies.random ? { random: dependencies.random } : {}),
    });
    const ownerMailbox = createOwnerMailboxRoutes({
      auth: active.auth, gateway: active.matrix.gateway, store: active.store,
      capabilities: bootstrap.capabilities, clock: active.clock,
      authoritySecret: active.env.invitationHmacSecret,
      inspectOwnerMembership: active.matrix.inspectOwnerMembership,
    });
    return { bootstrap, attestation, ownerMailbox };
  };
  const bootstrap = createLazyBootstrapRoutes(() => compose().bootstrap);
  return {
    ...bootstrap,
    deviceAttestation: createLazyDeviceAttestationRoutes(() => compose().attestation),
    ownerMailbox: createLazyOwnerMailboxRoutes(() => compose().ownerMailbox),
  };
}

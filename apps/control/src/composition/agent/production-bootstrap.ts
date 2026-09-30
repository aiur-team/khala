import { randomBytes } from 'node:crypto';
import {
  createAgentBootstrapHandlers, type AdapterCapabilities, type AdmissionPolicy, type AgentAdmissionPort, type AgentDeviceSessionPort,
} from '../../agent-bootstrap/handler';
import { createAdmissionService } from '../../invitations';
import { inviteFromShareLink } from '../../invitations/link';
import {
  createProductionHumanRuntimeLoader,
  type ProductionHumanDependencies,
} from '../human/production';
import { createLazyBootstrapRoutes } from './bootstrap-routes';
import { createDeviceAttestationRoutes, createLazyDeviceAttestationRoutes } from './device-attestation';
import { createInviteEvidenceReader } from './invite-evidence';
import { agentMatrixIdentity, createMatrixAgentAdmission } from './matrix-admission';
import { createLazyOwnerMailboxRoutes, createOwnerMailboxRoutes } from '../owner-mailbox/routes';
import { createLazyOwnerDeviceProofRoutes, createMatrixBrowserDeviceVerifier, createOwnerDeviceProofRoutes } from './owner-device-proof';
import { createOwnerRevocationRoutes, createLazyOwnerRevocationRoutes } from '../human/revocation';
import { createAgentRevocationCleanupRoutes, createCleanupProtocolPort, createLazyAgentRevocationCleanupRoutes } from '../human/revocation-cleanup';
import { createLazyRoomSendRoutes, createMatrixBrowserSenderVerifier, createRoomSendRoutes } from '../human/room-send-routes';
import { localOidcEnabled } from '../../auth/local-oidc';
import { createDeviceAdmissionRoutes, createLazyDeviceAdmissionRoutes } from '../human/device-admission-routes';
import { senderIdFor } from '../human/room-send-fence';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { AGENT_PARTICIPANTS_PATH, createAgentParticipantDirectoryRoute } from './participant-directory';
import type { PairingGrantPort } from '../../pairing/store';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type ProductionBootstrapDependencies = ProductionHumanDependencies & Readonly<{
  /** A substrate adapter that verifies the exact agent participant before admission. */
  /** Tests may supply a controlled provider; production constructs the Matrix adapter. */
  agents?: AgentAdmissionPort;
  agentDeviceSession?: AgentDeviceSessionPort;
  /** One-use channel-access grants from the hosted exchange. */
  externalGrants?: PairingGrantPort;
  /** Explicit G-ADMISSION choice; there is deliberately no silent default. */
  admissionPolicy: AdmissionPolicy;
}>;

export { inviteFromShareLink };

/**
 * Bind the existing one-use bootstrap protocol to the same production OIDC,
 * Matrix and Blobs adapters that serve signed-in human invitation requests.
 * The Matrix adapter checks the exact owner/session/link before changing room
 * membership; its DPoP-bound device attestation stays separate from admission.
 */
export function createProductionBootstrapRoutes(dependencies: ProductionBootstrapDependencies) {
  const runtime = createProductionHumanRuntimeLoader(dependencies);
  const ingressToken = (dependencies.env ?? process.env).MATRIX_REGISTRATION_INGRESS_TOKEN;
  const localAuth = localOidcEnabled(dependencies.env ?? process.env);
  const compose = () => {
    const active = runtime();
    const matrixAgents = createMatrixAgentAdmission({
      homeserverOrigin: active.env.publicHomeserverOrigin,
      allowInsecureLoopback: localAuth,
      serverName: active.env.matrixServerName,
      registrationSharedSecret: active.env.matrixRegistrationSharedSecret,
      passwordDerivationSecret: active.env.matrixPasswordDerivationSecret,
      invitationHmacSecret: active.env.invitationHmacSecret,
      ...(ingressToken ? { registrationIngressToken: ingressToken } : {}),
      store: active.store,
      clock: active.clock,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    });
    const revocationBindings = createAgentBindingStore({ store: active.store });
    async function exactRevokedBinding(input: { bindingId: string; roomId: string; deviceId: string;
      expectedGeneration: number; revokedGeneration: number }) {
      const located = await revocationBindings.locateBinding(input.bindingId);
      return located.kind === 'found' && located.address.roomId === input.roomId
        && located.record.binding.deviceId === input.deviceId
        && located.record.binding.generation === input.expectedGeneration
        && located.record.revokedGeneration === input.revokedGeneration
        ? located.record.binding : null;
    }
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
      allowInsecureLoopback: localAuth,
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
      ...(dependencies.externalGrants ? { pairingGrants: dependencies.externalGrants } : {}),
      inspectOwnerMembership: active.matrix.inspectOwnerMembership,
      legacyMigrationWritesEnabled: false,
    });
    const attestation = createDeviceAttestationRoutes({
      origin: active.env.publicAppOrigin,
      allowInsecureLoopback: localAuth,
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
      async lookupAgentDevice(binding) {
        const registered = await attestation.lookup(binding);
        if (!registered) return null;
        const identity = agentMatrixIdentity(binding.ownerId, binding, active.env.matrixServerName);
        return identity.participantId === binding.agentParticipantId
          ? { userId: identity.userId, deviceId: binding.deviceId, fingerprint: registered.fingerprint } : null;
      },
    });
    const ownerDeviceProof = createOwnerDeviceProofRoutes({
      auth: active.auth, gateway: active.matrix.gateway, store: active.store,
      capabilities: bootstrap.capabilities, clock: active.clock,
      inspectOwnerMembership: active.matrix.inspectOwnerMembership,
      verifyBrowserDevice: createMatrixBrowserDeviceVerifier({
        homeserverOrigin: active.env.publicHomeserverOrigin, serverName: active.env.matrixServerName,
        allowInsecureLoopback: localAuth,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }),
    });
    const participantDirectory = createAgentParticipantDirectoryRoute({
      store: active.store, capabilities: bootstrap.capabilities, sessions: active.matrix.sessions,
    });
    const revocation = createOwnerRevocationRoutes({
      auth: active.auth, store: active.store, capabilities: bootstrap.capabilities,
      deviceIdentityKey: binding => matrixAgents.publishedDeviceIdentityKey(binding),
      inspectOwnerMembership: active.matrix.inspectOwnerMembership,
      async inspectRoomSenderDevices(ownerId, roomId) {
        const roster = await active.matrix.inspectRoomSenderDevices(ownerId, roomId);
        return roster.kind === 'ok' ? { kind: 'ok' as const, senders: roster.senders.map(sender => ({
          senderId: senderIdFor(sender.matrixUserId, sender.deviceId), deviceId: sender.deviceId,
          deviceKey: sender.curve25519,
        })) } : { kind: 'unavailable' as const };
      },
      protocolFor: ownerId => createCleanupProtocolPort(active.store, ownerId, {
        async remove(input) {
          const binding = await exactRevokedBinding(input);
          return binding?.ownerId === ownerId
            ? matrixAgents.removePublishedDeviceWithUIA(binding, input.deviceKey) : 'unavailable';
        },
        async status(input) {
          const binding = await exactRevokedBinding(input);
          return binding?.ownerId === ownerId
            ? matrixAgents.inspectPublishedDevice(binding, input.deviceKey) : 'unavailable';
        },
      }),
    });
    const revocationCleanup = createAgentRevocationCleanupRoutes({
      store: active.store, capabilities: bootstrap.capabilities,
    });
    const roomSend = createRoomSendRoutes({
      store: active.store, auth: active.auth, capabilities: bootstrap.capabilities,
      inspectOwnerMembership: active.matrix.inspectOwnerMembership,
      verifyBrowserSender: createMatrixBrowserSenderVerifier({
        homeserverOrigin: active.env.publicHomeserverOrigin, serverName: active.env.matrixServerName,
        allowInsecureLoopback: localAuth,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }),
      async agentSender(binding) {
        const deviceKey = await matrixAgents.publishedDeviceIdentityKey(binding);
        return deviceKey ? { matrixUserId: agentMatrixIdentity(binding.ownerId, binding,
          active.env.matrixServerName).userId, deviceKey } : null;
      },
    });
    const deviceAdmission = createDeviceAdmissionRoutes({
      store: active.store, auth: active.auth,
      verifyBrowserSender: createMatrixBrowserSenderVerifier({
        homeserverOrigin: active.env.publicHomeserverOrigin, serverName: active.env.matrixServerName,
        allowInsecureLoopback: localAuth,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }),
      // G-ADMISSION, a trusted replacement binding/generation, room event position,
      // and verified key distribution are not yet composed. Keep this route closed.
      bindingFor: async () => null,
      authorize: async () => 'refused',
      currentPosition: async () => null,
      distributionReady: async () => false,
    });
    return { bootstrap, attestation, ownerMailbox, ownerDeviceProof, participantDirectory,
      revocation, revocationCleanup, roomSend, deviceAdmission };
  };
  const bootstrap = createLazyBootstrapRoutes(() => compose().bootstrap);
  return {
    ...bootstrap,
    // Resume uses the same durable binding/capability store as ordinary bootstrap.
    bindings: {
      resumeAdapterCapability: (input: Parameters<AdapterCapabilities['resumeAdapterCapability']>[0]) =>
        compose().bootstrap.capabilities.resumeAdapterCapability(input),
    },
    deviceAttestation: createLazyDeviceAttestationRoutes(() => compose().attestation),
    ownerMailbox: createLazyOwnerMailboxRoutes(() => compose().ownerMailbox),
    ownerDeviceProof: createLazyOwnerDeviceProofRoutes(() => compose().ownerDeviceProof),
    participantDirectory: [{ path: AGENT_PARTICIPANTS_PATH, methods: ['POST'],
      handle: (request: Request) => compose().participantDirectory.handle(request) }],
    revocation: createLazyOwnerRevocationRoutes(() => compose().revocation),
    revocationCleanup: createLazyAgentRevocationCleanupRoutes(() => compose().revocationCleanup),
    roomSend: {
      human: createLazyRoomSendRoutes(() => compose().roomSend).filter(route => route.path.startsWith('/api/human/')),
      agent: createLazyRoomSendRoutes(() => compose().roomSend).filter(route => route.path.startsWith('/api/agent/')),
    },
    deviceAdmission: createLazyDeviceAdmissionRoutes(() => compose().deviceAdmission),
  };
}

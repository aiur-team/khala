import path from 'node:path';
import { createHash } from 'node:crypto';
import { createChannelDiscoveryCredentialClient,
  activateChannelAccess, createHttpChannelAccessClient, createHttpChannelAccessRedeem, createHttpChannelAccessStatus,
  journalChannelAccessRequest, type BootstrapPorts, type ChannelAccessActivationPorts,
  type ChannelDiscoveryCredentialClient,
  type ProofSigner, type SessionClaim, type SessionInspectionPort } from '@khala/connector/bootstrap/index';
import { decodeAccessRequestStatus } from '@khala/contracts/messaging/index';
import type { MatrixDeviceSession } from '@khala/connector/bootstrap/ports';
import { sameSessionBinding, type SessionBinding } from '@khala/contracts/delivery/index';
import type { HarnessCapabilities } from '@khala/contracts/delivery/index';
import type { AgentClientPort, CliDependencies } from '../cli/types.js';
import { parseAccessTarget } from '../cli/channels/access.js';
import type { OpenGenerationInbox } from './delivering-inbox.js';
import type { HarnessSession } from './session-grant.js';
import { createConnectorBootstrapClient } from './bootstrap.js';
import { claudeProofKeyLabelInspection, codexMcpSessionInspection } from './hosted-session-inspection.js';
import { createHttpChannelListing } from './channel-listing.js';
import { createHttpChannelAccess } from './channel-access.js';
import { createProofKeyCandidateClient } from './proof-key-candidate.js';

export const CANONICAL_APP_ORIGIN = 'https://khala.aiur.team';

/** A preview override is an exact HTTPS origin, never an arbitrary link. */
export function hostedAppOrigin(value: string | undefined): string {
  if (value === undefined) return CANONICAL_APP_ORIGIN;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('invalid hosted origin'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== value || parsed.username || parsed.password) {
    throw new Error('invalid hosted origin');
  }
  return value;
}

type OpenProductionConnectorInput = Readonly<{
  stateDirectory: string;
  appOrigin: string;
  browserBundleDirectory: string;
  chromiumExecutablePath?: string;
  session: SessionClaim;
  sessionInspection: (generationFor: (claim: SessionClaim) => Promise<number | null>) => SessionInspectionPort;
  inspectHostedCodexHooks(): Promise<HarnessCapabilities | null>;
  resolveCodexExecutable(): Promise<string | null>;
  openBrowser(url: string): Promise<void>;
  openInbox: OpenGenerationInbox;
  /** Test transport and credential seam; production uses the owned discovery client and fetch. */
  fetch?: typeof fetch;
  credentialClient?: ChannelDiscoveryCredentialClient;
}>;
type ProductionConnector = Readonly<{
  ports: BootstrapPorts;
  proofSigner?: ProofSigner;
  channelAccess?: Pick<ChannelAccessActivationPorts, 'journal' | 'devices' | 'trust'> & Readonly<{
    admitted(operationId: string, value: Readonly<{ binding: SessionBinding; matrixSession: MatrixDeviceSession }>): Promise<void>;
    recovered(operationId: string): Promise<Readonly<{ binding: SessionBinding; matrixSession: MatrixDeviceSession }> | null>;
  }>;
  send: AgentClientPort['send'];
  status: AgentClientPort['status'];
  listChannels: AgentClientPort['listChannels'];
  listAgents: AgentClientPort['listAgents'];
  listeningMode?: AgentClientPort['listeningMode'];
  listeningModeControl?: AgentClientPort['listeningModeControl'];
  inbox: OpenGenerationInbox;
  close(): Promise<void>;
}>;
export type OpenProductionConnector = (input: OpenProductionConnectorInput) => Promise<ProductionConnector>;

/** Binds a caller-supplied local session label to one production connector instance. */
export function hostedSessionFactory(options: Readonly<{
  openConnector: OpenProductionConnector;
  stateDirectory: string;
  appOrigin: string;
  browserBundleDirectory: string;
  chromiumExecutablePath?: string;
  workdir: string;
  readVersion(): Promise<string | null>;
  readClaudeVersion?(): Promise<string | null>;
  inspectHooks(): Promise<HarnessCapabilities | null>;
  resolveCodexExecutable(): Promise<string | null>;
  openBrowser(url: string): Promise<void>;
  openInbox: OpenGenerationInbox;
  fetch?: typeof fetch;
  credentialClient?: ChannelDiscoveryCredentialClient;
}>): NonNullable<CliDependencies['hostedSession']> {
  return async (session: HarnessSession) => {
    const claim = { ...session, workdir: path.resolve(options.workdir) };
    const connector = await options.openConnector({
      stateDirectory: options.stateDirectory,
      appOrigin: options.appOrigin,
      browserBundleDirectory: options.browserBundleDirectory,
      ...(options.chromiumExecutablePath === undefined ? {} : { chromiumExecutablePath: options.chromiumExecutablePath }),
      session: claim,
      sessionInspection: generationFor => codexMcpSessionInspection({
        session, workdir: claim.workdir, readVersion: options.readVersion,
        generation: named => generationFor({ ...named, workdir: claim.workdir }),
      }),
      inspectHostedCodexHooks: async () => session.harness === 'codex' ? options.inspectHooks() : null,
      resolveCodexExecutable: async () => session.harness === 'codex' ? options.resolveCodexExecutable() : null,
      openBrowser: options.openBrowser,
      openInbox: options.openInbox,
    });
    const requestSessions = session.harness === 'claude' && options.readClaudeVersion
      ? claudeProofKeyLabelInspection({ session, workdir: claim.workdir, readVersion: options.readClaudeVersion })
      : connector.ports.sessions;
    const discovery = options.credentialClient ?? (connector.proofSigner ? createChannelDiscoveryCredentialClient({
      signer: connector.proofSigner, sessions: requestSessions,
      trustedOrigins: [options.appOrigin], openBrowser: options.openBrowser,
      allowProofKeyLocalLabel: true,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }) : null);
    const access = discovery && connector.proofSigner ? createHttpChannelAccess({
      credentials: discovery, signer: connector.proofSigner, session: claim,
      trustedOrigins: [options.appOrigin], defaultOrigin: options.appOrigin,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      beforeChannelRequest: async (input, credential) => {
        if (!connector.channelAccess || !connector.proofSigner) return false;
        return await journalChannelAccessRequest({ operationId: input.operationId,
          requester: credential.requester.principal, origin: input.origin,
          sessionGeneration: credential.requester.sessionGeneration },
        { journal: connector.channelAccess.journal, signer: connector.proofSigner }) === 'journaled';
      },
      candidate: createProofKeyCandidateClient({
        signer: connector.proofSigner, sessions: requestSessions,
        origin: options.appOrigin, openBrowser: options.openBrowser,
      }),
    }) : null;
    const listChannels = discovery && connector.proofSigner ? createHttpChannelListing({
      credentials: discovery, signer: connector.proofSigner, session: claim,
      trustedOrigins: [options.appOrigin], defaultOrigin: options.appOrigin,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }) : connector.listChannels;
    const redeem = discovery && connector.proofSigner && connector.channelAccess ? createHttpChannelAccessRedeem({
      signer: connector.proofSigner, trustedOrigins: [options.appOrigin], credential: () => discovery.current(),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }) : null;
    const activationPorts: ChannelAccessActivationPorts | null = discovery && connector.proofSigner && connector.channelAccess && redeem ? {
      ...connector.channelAccess,
      status: createHttpChannelAccessStatus({ signer: connector.proofSigner,
        trustedOrigins: [options.appOrigin], credential: () => discovery.current(),
        ...(options.fetch ? { fetch: options.fetch } : {}) }),
      exchange: createHttpChannelAccessClient({ signer: connector.proofSigner,
        trustedOrigins: [options.appOrigin], credential: () => discovery.current(),
        ...(options.fetch ? { fetch: options.fetch } : {}) }),
      redeem: {
        async redeem(input) {
          const recovered = await connector.channelAccess!.recovered(input.operationId);
          if (recovered) {
            const resumed = await redeem.resume({ ...input, bindingId: recovered.binding.bindingId });
            return resumed.kind === 'admitted' && sameSessionBinding(resumed.binding, recovered.binding)
              ? { ...resumed, matrixSession: recovered.matrixSession }
              : { kind: 'refused', code: 'binding_conflict' };
          }
          const admitted = await redeem.redeem(input);
          if (admitted.kind === 'admitted' && !admitted.matrixSession) return { kind: 'refused', code: 'admission_denied' };
          if (admitted.kind === 'admitted' && admitted.matrixSession) {
            await connector.channelAccess!.admitted(input.operationId,
              { binding: admitted.binding, matrixSession: admitted.matrixSession });
          }
          return admitted;
        },
        async resume(input) {
          const recovered = await connector.channelAccess!.recovered(input.operationId);
          const resumed = await redeem.resume(input);
          return resumed.kind === 'admitted' && recovered && sameSessionBinding(resumed.binding, recovered.binding)
            ? { ...resumed, matrixSession: recovered.matrixSession }
            : resumed.kind === 'admitted' ? { kind: 'refused', code: 'binding_conflict' } : resumed;
        },
      },
      signer: connector.proofSigner,
      polling: { baseMs: 100, maxMs: 1_000, maxAttempts: 1 },
    } : null;
    async function advance(operationId: string, origin: string) {
      const credential = discovery?.current();
      if (!activationPorts || !credential || credential.requester.origin !== origin) return null;
      const journaled = await journalChannelAccessRequest({ operationId,
        requester: credential.requester.principal, origin,
        sessionGeneration: credential.requester.sessionGeneration }, activationPorts);
      return journaled === 'journaled' ? activateChannelAccess(operationId, activationPorts) : null;
    }
    async function nativeReady(binding: SessionBinding): Promise<boolean> {
      try {
        const status = await connector.status();
        return status.connected && status.binding !== null
          && sameSessionBinding(status.binding, binding) && status.readiness?.phase === 'ready';
      } catch { return false; }
    }
    const requestChannelAccess: AgentClientPort['requestChannelAccess'] = async (input, signal) => {
      if (!access) return { kind: 'unavailable' };
      let namedOrigin: string | null = null;
      if (input.target.kind === 'channel_url') {
        try { namedOrigin = new URL(input.target.channelUrl).origin; } catch { /* Access client reports invalid_link. */ }
      }
      const origin = input.origin ?? namedOrigin ?? options.appOrigin;
      const result = await access.requestChannelAccess(input, signal);
      if (result.kind !== 'status') return result;
      const decoded = decodeAccessRequestStatus(result.status);
      if (!decoded.ok || decoded.value.operationId !== input.operationId) return { kind: 'unavailable' };
      if (!['approved', 'connecting', 'connected', 'repair_required'].includes(decoded.value.outcome)) return result;
      const activated = await advance(input.operationId, origin);
      if (!activated || activated.kind === 'unavailable' || activated.kind === 'blocked') return { kind: 'unavailable' };
      return activated?.kind === 'connected' && await nativeReady(activated.binding)
        ? { kind: 'status', status: { v: 1, operationId: input.operationId, outcome: 'connected' } }
        : activated?.kind === 'closed'
          ? { kind: 'status', status: { v: 1, operationId: input.operationId, outcome: activated.outcome } }
          : activated.kind === 'repair_required'
            ? { kind: 'status', status: { v: 1, operationId: input.operationId, outcome: 'repair_required' } }
          : { kind: 'status', status: { v: 1, operationId: input.operationId, outcome: 'connecting' } };
    };
    const channelAccessStatus: AgentClientPort['channelAccessStatus'] = async (input, signal) => {
      if (!access) return { kind: 'unavailable' };
      const result = await access.channelAccessStatus(input, signal);
      if (result.kind !== 'status') return result;
      const decoded = decodeAccessRequestStatus(result.status);
      if (!decoded.ok || decoded.value.operationId !== input.operationId) return { kind: 'unavailable' };
      if (!['approved', 'connecting', 'connected', 'repair_required'].includes(decoded.value.outcome)) return result;
      const activated = await advance(input.operationId, input.origin ?? options.appOrigin);
      if (!activated || activated.kind === 'unavailable' || activated.kind === 'blocked') return { kind: 'unavailable' };
      return activated?.kind === 'connected' && await nativeReady(activated.binding)
        ? { kind: 'status', status: { v: 1, operationId: input.operationId, outcome: 'connected' } }
        : activated?.kind === 'closed'
          ? { kind: 'status', status: { v: 1, operationId: input.operationId, outcome: activated.outcome } }
          : activated.kind === 'repair_required'
            ? { kind: 'status', status: { v: 1, operationId: input.operationId, outcome: 'repair_required' } }
          : { kind: 'status', status: { v: 1, operationId: input.operationId, outcome: 'connecting' } };
    };
    const client = createConnectorBootstrapClient({
      ports: connector.ports, session: claim,
      send: connector.send, status: connector.status,
      listChannels, listAgents: connector.listAgents,
      ...(access ? { requestChannelAccess, channelAccessStatus } : {}),
      ...(connector.listeningMode ? { listeningMode: connector.listeningMode } : {}),
      ...(connector.listeningModeControl ? { listeningModeControl: connector.listeningModeControl } : {}),
    });
    return {
      client: { ...client,
        storedSessionId(harness: string, sessionId: string) {
          return connector.proofSigner && harness === session.harness && sessionId === session.sessionId
            ? `agent_${connector.proofSigner.jkt}` : '';
        },
        async connect(link: string) {
        if (!access || !activationPorts) return { kind: 'unavailable' as const };
        const parsed = parseAccessTarget(link);
        if (parsed?.kind !== 'channel_url') return { kind: 'refused' as const, code: 'invalid_link' as const };
        let target: URL;
        try { target = new URL(link); } catch { return { kind: 'refused' as const, code: 'invalid_link' as const }; }
        if (!/^\/join\/[A-Za-z0-9_-]{8,256}$/.test(target.pathname)) return { kind: 'refused' as const, code: 'invalid_link' as const };
        if (target.origin !== options.appOrigin) return { kind: 'refused' as const, code: 'untrusted_origin' as const };
        const operationId = createHash('sha256').update(JSON.stringify([
          'khala.hosted.channel-access.v1', link, claim.harness, claim.sessionId, claim.workdir,
        ])).digest('base64url').slice(0, 32);
        const result = await requestChannelAccess({ target: { kind: 'channel_url', channelUrl: link }, operationId, origin: target.origin });
        if (result?.kind !== 'status') return { kind: 'unavailable' as const };
        const activated = await advance(operationId, target.origin);
        if (activated?.kind === 'connected' && await nativeReady(activated.binding)) return activated;
        if (activated?.kind === 'closed') return { kind: 'refused' as const,
          code: activated.outcome === 'denied' ? 'admission_denied' as const : 'binding_revoked' as const };
        return { kind: 'unavailable' as const };
      } },
      inbox: connector.inbox,
      close: connector.close,
    };
  };
}

import path from 'node:path';
import { createChannelDiscoveryCredentialClient,
  type BootstrapPorts, type ProofSigner, type SessionClaim, type SessionInspectionPort } from '@khala/connector/bootstrap/index';
import type { HarnessCapabilities } from '@khala/contracts/delivery/index';
import type { AgentClientPort, CliDependencies } from '../cli/types.js';
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
}>;
type ProductionConnector = Readonly<{
  ports: BootstrapPorts;
  proofSigner?: ProofSigner;
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
    const discovery = connector.proofSigner ? createChannelDiscoveryCredentialClient({
      signer: connector.proofSigner, sessions: requestSessions,
      trustedOrigins: [options.appOrigin], openBrowser: options.openBrowser,
      allowProofKeyLocalLabel: true,
    }) : null;
    const access = discovery && connector.proofSigner ? createHttpChannelAccess({
      credentials: discovery, signer: connector.proofSigner, session: claim,
      trustedOrigins: [options.appOrigin], defaultOrigin: options.appOrigin,
      candidate: createProofKeyCandidateClient({
        signer: connector.proofSigner, sessions: requestSessions,
        origin: options.appOrigin, openBrowser: options.openBrowser,
      }),
    }) : null;
    const listChannels = discovery && connector.proofSigner ? createHttpChannelListing({
      credentials: discovery, signer: connector.proofSigner, session: claim,
      trustedOrigins: [options.appOrigin], defaultOrigin: options.appOrigin,
    }) : connector.listChannels;
    return {
      client: createConnectorBootstrapClient({
        ports: connector.ports, session: claim,
        send: connector.send, status: connector.status,
        listChannels, listAgents: connector.listAgents,
        ...(access ? { requestChannelAccess: access.requestChannelAccess,
          channelAccessStatus: access.channelAccessStatus } : {}),
        ...(connector.listeningMode ? { listeningMode: connector.listeningMode } : {}),
        ...(connector.listeningModeControl ? { listeningModeControl: connector.listeningModeControl } : {}),
      }),
      inbox: connector.inbox,
      close: connector.close,
    };
  };
}

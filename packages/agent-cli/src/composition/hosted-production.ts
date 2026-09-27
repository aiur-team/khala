import path from 'node:path';
import type { BootstrapPorts, SessionClaim, SessionInspectionPort } from '@khala/connector/bootstrap/index';
import type { AgentClientPort, CliDependencies } from '../cli/types.js';
import type { OpenGenerationInbox } from './delivering-inbox.js';
import type { HarnessSession } from './session-grant.js';
import { createConnectorBootstrapClient } from './bootstrap.js';
import { codexMcpSessionInspection } from './hosted-session-inspection.js';

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
  session: SessionClaim;
  sessionInspection: (generationFor: (claim: SessionClaim) => Promise<number | null>) => SessionInspectionPort;
  openBrowser(url: string): Promise<void>;
  openInbox: OpenGenerationInbox;
}>;
type ProductionConnector = Readonly<{
  ports: BootstrapPorts;
  send: AgentClientPort['send'];
  status: AgentClientPort['status'];
  listChannels: AgentClientPort['listChannels'];
  listAgents: AgentClientPort['listAgents'];
  inbox: OpenGenerationInbox;
  close(): Promise<void>;
}>;
export type OpenProductionConnector = (input: OpenProductionConnectorInput) => Promise<ProductionConnector>;

/** Binds the provider-named MCP session to one production connector instance. */
export function hostedSessionFactory(options: Readonly<{
  openConnector: OpenProductionConnector;
  stateDirectory: string;
  appOrigin: string;
  browserBundleDirectory: string;
  workdir: string;
  readVersion(): Promise<string | null>;
  openBrowser(url: string): Promise<void>;
  openInbox: OpenGenerationInbox;
}>): NonNullable<CliDependencies['hostedSession']> {
  return async (session: HarnessSession) => {
    const claim = { ...session, workdir: path.resolve(options.workdir) };
    const connector = await options.openConnector({
      stateDirectory: options.stateDirectory,
      appOrigin: options.appOrigin,
      browserBundleDirectory: options.browserBundleDirectory,
      session: claim,
      sessionInspection: generationFor => codexMcpSessionInspection({
        session, workdir: claim.workdir, readVersion: options.readVersion,
        generation: named => generationFor({ ...named, workdir: claim.workdir }),
      }),
      openBrowser: options.openBrowser,
      openInbox: options.openInbox,
    });
    return {
      client: createConnectorBootstrapClient({
        ports: connector.ports, session: claim,
        send: connector.send, status: connector.status,
        listChannels: connector.listChannels, listAgents: connector.listAgents,
      }),
      inbox: connector.inbox,
      close: connector.close,
    };
  };
}

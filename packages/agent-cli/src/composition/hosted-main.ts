import path from 'node:path';
import type { CliDependencies } from '../cli/types.js';
import { setupEnvironment } from '../setup/environment.js';
import { openDefaultBrowser } from './default-browser.js';
import { hostedAppOrigin, hostedSessionFactory, type OpenProductionConnector } from './hosted-production.js';
import { readInstalledCodexVersion } from './hosted-session-inspection.js';
import { inspectClaudeVersion, inspectHostedCodexHooks } from './local-harness-capabilities.js';

/** The published CLI's hosted composition; no provider session exists until an MCP call names it. */
export function installedHostedSession(input: Readonly<{
  openConnector: OpenProductionConnector;
  environment: NodeJS.ProcessEnv;
  stateDirectory: string;
  distDirectory: string;
  workdir: string;
  openInbox: CliDependencies['inbox'];
}>): NonNullable<CliDependencies['hostedSession']> {
  const appOrigin = hostedAppOrigin(input.environment.KHALA_APP_ORIGIN);
  return hostedSessionFactory({
    openConnector: input.openConnector,
    stateDirectory: path.join(input.stateDirectory, 'hosted'),
    appOrigin,
    browserBundleDirectory: path.join(input.distDirectory, 'substrate-browser'),
    chromiumExecutablePath: path.join(input.distDirectory, 'chromium', 'chrome-linux64', 'chrome'),
    workdir: input.workdir,
    readVersion: () => readInstalledCodexVersion(setupEnvironment(input.environment)),
    readClaudeVersion: () => inspectClaudeVersion(setupEnvironment(input.environment)),
    resolveCodexExecutable: () => setupEnvironment(input.environment).probe.resolveExecutable('codex'),
    inspectHooks: () => inspectHostedCodexHooks(setupEnvironment(input.environment)),
    openBrowser: url => openDefaultBrowser(url, appOrigin),
    diagnostic: event => {
      process.stderr.write(`${JSON.stringify({ component: event.component, stage: event.stage,
        result: event.result, ...('httpStatus' in event ? { httpStatus: event.httpStatus } : {}) })}\n`);
    },
    openInbox: input.openInbox,
  });
}

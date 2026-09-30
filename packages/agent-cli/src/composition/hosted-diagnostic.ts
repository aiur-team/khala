import fs from 'node:fs';
import path from 'node:path';
import type { ActivationDiagnostic } from './hosted-production.js';
import type { ChannelAccessDiagnostic } from './channel-access.js';
import type { CandidateDiagnostic } from './proof-key-candidate.js';
import type { DiscoveryCredentialDiagnostic } from '@khala/connector/bootstrap/channel-discovery';

type Diagnostic = Readonly<{ component: 'proof_key_candidate' | 'discovery_credential' | 'channel_access' | 'activation' }>
  & (CandidateDiagnostic | DiscoveryCredentialDiagnostic | ChannelAccessDiagnostic | ActivationDiagnostic);

/** The MCP child's stderr may be hidden by its host; retain only fixed diagnostic fields. */
export function recordHostedDiagnostic(stateDirectory: string, event: Diagnostic): void {
  const line = `${JSON.stringify({ component: event.component, stage: event.stage, result: event.result,
    ...('httpStatus' in event && Number.isInteger(event.httpStatus) ? { httpStatus: event.httpStatus } : {}) })}\n`;
  try { process.stderr.write(line); } catch { /* An invisible stderr must not change the request. */ }
  try {
    const directory = path.join(stateDirectory, 'hosted');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(path.join(directory, `diagnostics-${process.pid}.jsonl`),
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, line); } finally { fs.closeSync(fd); }
  } catch { /* Diagnostics cannot change a request outcome. */ }
}

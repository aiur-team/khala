import fs from 'node:fs';
import path from 'node:path';
import type { ActivationDiagnostic, NativeReadyDiagnostic } from './hosted-production.js';
import type { ChannelAccessDiagnostic } from './channel-access.js';
import type { CandidateDiagnostic } from './proof-key-candidate.js';
import type { DiscoveryCredentialDiagnostic } from '@khala/connector/bootstrap/channel-discovery';
import type { ExchangeHttpDiagnostic } from '@khala/connector/bootstrap/index';
import { STORAGE_ERROR_CODES } from '@khala/connector/storage/errors';
import type { HostedOpenDiagnostic } from '@khala/connector/bootstrap/hosted-open-diagnostic';
import type { HostedSubscriptionDiagnostic } from '@khala/connector/subscription/diagnostic';
import { AGENT_READINESS_ERRORS, AGENT_READINESS_PREREQUISITES } from '../cli/types.js';

type Diagnostic = Readonly<{ component: 'proof_key_candidate' | 'discovery_credential' | 'channel_access' | 'activation' | 'activation_exchange_http' }>
  & (CandidateDiagnostic | DiscoveryCredentialDiagnostic | ChannelAccessDiagnostic | ActivationDiagnostic | ExchangeHttpDiagnostic)
  | (Readonly<{ component: 'hosted_open' }> & HostedOpenDiagnostic)
  | (Readonly<{ component: 'native_ready' }> & NativeReadyDiagnostic)
  | (Readonly<{ component: 'subscription' }> & HostedSubscriptionDiagnostic);

const NATIVE_READY_STAGES = [
  'connector_unready', 'binding_absent', 'binding_mismatch', 'readiness_unready', 'status_exception',
] as const;
const SUBSCRIPTION_STAGES = [
  'local_guard', 'mailbox_guard', 'owner_device_guard', 'guard_exception',
  'matrix_authorize', 'matrix_read', 'matrix_lost', 'mailbox_http', 'owner_device_http',
  'owner_device_attestation_fingerprint', 'owner_device_attestation_capability',
  'owner_device_attestation_challenge_transport', 'owner_device_attestation_challenge_response',
  'owner_device_attestation_register_transport', 'owner_device_attestation_register_response',
  'owner_device_attestation_internal', 'owner_device_capability', 'owner_device_empty',
  'owner_device_trust_peer',
  'matrix_read_closed', 'matrix_read_bridge', 'matrix_read_members', 'matrix_read_participants',
  'matrix_read_processing', 'matrix_read_missing_keys', 'matrix_read_names', 'matrix_read_callback',
] as const;
const SUBSCRIPTION_RESULTS = ['unavailable', 'revoked', 'closing', 'expired', 'rejected', 'gap'] as const;

/** The MCP child's stderr may be hidden by its host; retain only fixed diagnostic fields. */
export function recordHostedDiagnostic(stateDirectory: string, event: Diagnostic): void {
  const native = event.component === 'native_ready';
  const subscription = event.component === 'subscription';
  const line = `${JSON.stringify({ component: event.component,
    stage: native && !(NATIVE_READY_STAGES as readonly string[]).includes(event.stage) ? 'status_exception'
      : subscription && !(SUBSCRIPTION_STAGES as readonly string[]).includes(event.stage) ? 'guard_exception' : event.stage,
    result: subscription && !(SUBSCRIPTION_RESULTS as readonly string[]).includes(event.result)
      ? 'unavailable' : event.result,
    ...('httpStatus' in event && Number.isInteger(event.httpStatus)
      && event.httpStatus >= 100 && event.httpStatus <= 599 ? { httpStatus: event.httpStatus } : {}),
    ...(event.component === 'hosted_open' && event.errorCode && STORAGE_ERROR_CODES.includes(event.errorCode)
      ? { errorCode: event.errorCode } : {}),
    ...(native ? { phase: ['ready', 'degraded', 'stopped', 'absent'].includes(event.phase) ? event.phase : 'absent',
      errorCode: event.errorCode && (AGENT_READINESS_ERRORS as readonly string[]).includes(event.errorCode)
        ? event.errorCode : null,
      prerequisites: Object.fromEntries(AGENT_READINESS_PREREQUISITES.map(key => [key,
        event.prerequisites[key] === true])) } : {}) })}\n`;
  try { process.stderr.write(line); } catch { /* An invisible stderr must not change the request. */ }
  try {
    const directory = path.join(stateDirectory, 'hosted');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(path.join(directory, `diagnostics-${process.pid}.jsonl`),
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, line); } finally { fs.closeSync(fd); }
  } catch { /* Diagnostics cannot change a request outcome. */ }
}

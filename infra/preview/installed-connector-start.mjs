import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function pendingOwnerOutcome(result) {
  return result?.ok === true && result.outcome === 'pending_owner'
    && result.next === 'human_approve' && typeof result.operationId === 'string'
    && result.operationId.length > 0;
}

const HOSTED_OPEN_STAGES = new Set([
  'browser_preflight', 'state_storage', 'trust_storage', 'bootstrap_persistence',
  'binding_recovery', 'device_resume', 'intake_start', 'subscription_start',
  'review_resume', 'connector_bootstrap', 'matrix_writer_active',
  'matrix_startup_retry', 'matrix_startup_blocked', 'matrix_writer_recovered',
  'harness_route_inspect',
]);

export function lastHostedOpenStage(output) {
  let stage;
  for (const line of output.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event?.component === 'hosted_open' && HOSTED_OPEN_STAGES.has(event.stage)) stage = event.stage;
    } catch { /* Child stderr can contain arbitrary text; never copy it to the report. */ }
  }
  return stage;
}

async function main() {
  const diagnosticPath = process.env.KHALA_E2E_CONNECTOR_DIAGNOSTIC;
  const diagnose = (stage, details = {}) => {
    if (diagnosticPath) writeFileSync(diagnosticPath, JSON.stringify({ stage, ...details }), { mode: 0o600 });
  };
  diagnose('inputs');
  const installedCli = process.argv[2];
  const origin = process.env.KHALA_APP_ORIGIN;
  const stateHome = process.env.XDG_STATE_HOME;
  const linkFile = process.env.KHALA_E2E_SHARE_LINK_FILE;
  if (!installedCli || !origin || !/^https:\/\/127\.0\.0\.1:\d+$/u.test(origin)
    || !stateHome || !path.isAbsolute(stateHome) || !linkFile) throw new Error('installed_connector_inputs_invalid');
  const link = await readFile(linkFile, 'utf8');
  const parsed = new URL(link);
  if (parsed.origin !== origin || !/^\/join\/[A-Za-z0-9_-]{8,256}$/u.test(parsed.pathname)
    || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('installed_connector_link_invalid');
  }
  diagnose('process');
  const threadId = randomUUID();
  const initialize = { jsonrpc: '2.0', id: 0, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'khala-external-preview' },
  } };
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'khala_connect', arguments: { url: link }, _meta: { threadId },
  } };
  const child = spawn(process.execPath, [installedCli, 'mcp-serve'], {
    env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let diagnostics = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {
    output += chunk;
    if (output.length > 64 * 1024) child.kill('SIGTERM');
  });
  child.stderr.setEncoding('utf8').on('data', chunk => {
    diagnostics += chunk;
    if (diagnostics.length > 64 * 1024) child.kill('SIGTERM');
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 45_000);
  child.stdin.end(`${JSON.stringify(initialize)}\n${JSON.stringify(request)}\n`);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(timer);
  const hostedOpenStage = lastHostedOpenStage(diagnostics);
  diagnose('process_result', { exitCode: typeof code === 'number' ? code : -1,
    ...(hostedOpenStage ? { hostedOpenStage } : {}) });
  if (code !== 0) throw new Error('installed_connector_process_failed');
  let handshake;
  let reply;
  try {
    const responses = output.trim().split('\n').map(line => JSON.parse(line));
    handshake = responses.find(response => response.id === 0);
    reply = responses.find(response => response.id === 1);
  }
  catch { throw new Error('installed_connector_response_invalid'); }
  if (handshake?.result?.serverInfo?.name !== 'khala-agent-cli'
    || handshake.result.protocolVersion !== '2025-03-26') throw new Error('installed_connector_handshake_invalid');
  const result = reply?.result?.structuredContent;
  diagnose('candidate_result', {
    ...(hostedOpenStage ? { hostedOpenStage } : {}),
    hasStructuredContent: Boolean(result),
    rpcErrorCode: Number.isInteger(reply?.error?.code) ? reply.error.code : 0,
    isError: reply?.result?.isError === true,
    ok: result?.ok === true,
    kind: ['refused', 'unavailable', 'pending', 'connected'].includes(result?.kind) ? result.kind : 'other',
    code: ['not_connected', 'invalid_arguments', 'invalid_input', 'binding_not_held',
      'listener_busy', 'storage_failed', 'transport_unavailable', 'outcome_unknown', 'internal_error',
      'connector_starting', 'internal_unavailable', 'invalid_request', 'invalid_link', 'untrusted_origin', 'link_unavailable',
      'unsupported_descriptor', 'harness_session_missing', 'unsupported_harness', 'ownership_required',
      'admission_denied', 'binding_conflict', 'binding_revoked', 'operation_conflict', 'device_unavailable',
      'discovery_required', 'proof_key_unavailable'].includes(result?.code) ? result.code : 'other',
    outcome: result?.outcome === 'pending_owner' || result?.outcome === 'connecting' ? result.outcome : 'other',
    error: ['unavailable', 'invalid_link', 'not_connected', 'untrusted_origin', 'ownership_required',
      'harness_session_missing', 'link_unavailable']
      .includes(result?.error) ? result.error : 'other',
  });
  if (!pendingOwnerOutcome(result)) throw new Error('installed_connector_not_pending_owner');
  const sessionDirectory = createHash('sha256').update(JSON.stringify([
    'khala.hosted.session.v1', 'codex', threadId, process.cwd(),
  ])).digest('hex');
  const hostedState = path.join(stateHome, 'khala', 'hosted', sessionDirectory, 'state');
  if (!(await stat(hostedState).catch(() => null))?.isDirectory()) throw new Error('installed_connector_state_absent');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

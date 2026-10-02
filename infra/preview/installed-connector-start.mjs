import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function pendingOwnerOutcome(result) {
  return result?.ok === true && result.outcome === 'pending_owner'
    && result.next === 'human_approve' && typeof result.operationId === 'string'
    && result.operationId.length > 0;
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
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'khala_connect', arguments: { url: link }, _meta: { threadId: randomUUID() },
  } };
  const child = spawn(process.execPath, [installedCli, 'mcp-serve'], {
    env: process.env, stdio: ['pipe', 'pipe', 'ignore'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {
    output += chunk;
    if (output.length > 64 * 1024) child.kill('SIGTERM');
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 45_000);
  child.stdin.end(`${JSON.stringify(request)}\n`);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(timer);
  diagnose('process_result', { exitCode: typeof code === 'number' ? code : -1 });
  if (code !== 0) throw new Error('installed_connector_process_failed');
  let reply;
  try { reply = JSON.parse(output.trim().split('\n').find(line => JSON.parse(line).id === 1)); }
  catch { throw new Error('installed_connector_response_invalid'); }
  const result = reply?.result?.structuredContent;
  diagnose('candidate_result', {
    hasStructuredContent: Boolean(result),
    rpcErrorCode: Number.isInteger(reply?.error?.code) ? reply.error.code : 0,
    isError: reply?.result?.isError === true,
    ok: result?.ok === true,
    kind: ['refused', 'unavailable', 'pending', 'connected'].includes(result?.kind) ? result.kind : 'other',
    code: ['not_connected', 'invalid_link', 'untrusted_origin', 'ownership_required',
      'discovery_required', 'proof_key_unavailable'].includes(result?.code) ? result.code : 'other',
    outcome: result?.outcome === 'pending_owner' || result?.outcome === 'connecting' ? result.outcome : 'other',
    error: ['unavailable', 'invalid_link', 'not_connected', 'untrusted_origin', 'ownership_required']
      .includes(result?.error) ? result.error : 'other',
  });
  if (!pendingOwnerOutcome(result)) throw new Error('installed_connector_not_pending_owner');
  const hosted = await readdir(path.join(stateHome, 'khala', 'hosted'), { withFileTypes: true });
  if (!hosted.some(entry => entry.isDirectory())) throw new Error('installed_connector_state_absent');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

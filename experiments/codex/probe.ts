import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { JsonlRpcClient, RpcTransportError } from './rpc.js';

export type ProbeInput = {
  sessionId: string;
  expectedWorkdir: string;
  nonce: string;
  mode: 'idle' | 'busy';
  deadlineMs: number;
  /** Explicitly designated disposable session; omission is read-only preflight. */
  release?: boolean;
  socketPath?: string;
};
export type ProbeReport = {
  harness: 'codex';
  version: string;
  originalSessionId: string;
  observedSessionId: string | null;
  setupActions: readonly { actor: 'agent' | 'human'; action: string }[];
  observations: readonly { kind: string; monotonicMs: number; evidencePath: string }[];
  outcome: 'supported' | 'unsupported' | 'inconclusive';
  limitations: readonly string[];
  facts: {
    mode: 'idle' | 'busy';
    workdirMatched: boolean | null;
    modelAvailable: boolean | null;
    modelUnchanged: boolean | null;
    inputAttempted: boolean;
    queueAccepted: boolean;
    queueId: string | null;
    operationId: string | null;
    consumptionObserved: false;
  };
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Thread = { id: string; cwd: string; model: string | null; canAcceptDirectInput: boolean | null; status: { type: string } };
function thread(value: unknown): Thread {
  const t = (value as { thread?: Thread } | null)?.thread;
  if (!t || typeof t.id !== 'string' || !uuid.test(t.id) || typeof t.cwd !== 'string' ||
      !(t.model === null || typeof t.model === 'string') ||
      !(t.canAcceptDirectInput === null || typeof t.canAcceptDirectInput === 'boolean') ||
      typeof t.status?.type !== 'string') throw new RpcTransportError('protocol');
  return t;
}
function version(deadlineMs: number): Promise<string> {
  return new Promise(resolve => {
    execFile('codex', ['--version'], { timeout: deadlineMs, killSignal: 'SIGKILL', maxBuffer: 8192 }, (error, stdout) => {
      const match = stdout?.trim().match(/^codex-cli (\d+\.\d+\.\d+)$/);
      resolve(!error && match ? match[1] : 'unavailable');
    });
  });
}

/** No session discovery, resume, turn/start, permission updates, or automatic retries. */
export async function runAttachmentProbe(input: ProbeInput): Promise<ProbeReport> {
  if (!input || !uuid.test(input.sessionId) || !isAbsolute(input.expectedWorkdir) ||
      !/^release-nonce-[a-zA-Z0-9-]{1,64}$/.test(input.nonce) ||
      !['idle', 'busy'].includes(input.mode) || !Number.isSafeInteger(input.deadlineMs) ||
      input.deadlineMs < 50 || input.deadlineMs > 60_000 ||
      (input.release !== undefined && typeof input.release !== 'boolean') ||
      (input.socketPath !== undefined && !isAbsolute(input.socketPath))) {
    throw new Error('Invalid probe input; see --help');
  }
  const start = performance.now();
  const observations: { kind: string; monotonicMs: number; evidencePath: string }[] = [];
  const report: ProbeReport = {
    harness: 'codex', version: 'unavailable', originalSessionId: input.sessionId,
    observedSessionId: null, setupActions: [{ actor: 'agent', action: 'Read CLI version; connect proxy only to the designated endpoint.' }],
    observations, outcome: 'inconclusive',
    limitations: [
      'This probe cannot establish executor process identity or permission-state preservation from thread/read metadata.',
      'Queue acceptance is not context consumption, durable acceptance, or exactly-once execution.',
      'Idle/busy mode is checked at one metadata snapshot; it is not a controlled long-tool experiment.',
    ],
    facts: { mode: input.mode, workdirMatched: null, modelAvailable: null, modelUnchanged: null,
      inputAttempted: false, queueAccepted: false, queueId: null, operationId: null, consumptionObserved: false },
  };
  const observe = (kind: string) => observations.push({ kind, monotonicMs: Math.round((performance.now() - start) * 1000) / 1000, evidencePath: `#/observations/${observations.length}` });
  const limit = (message: string) => { report.limitations = [...report.limitations, message]; };
  let client: JsonlRpcClient | undefined;
  try {
    report.version = await version(input.deadlineMs);
    observe('version_checked');
    if (report.version !== '0.154.0') { limit('Only installed schema version 0.154.0 is pinned; no connection attempted for another version.'); return report; }
    const remaining = Math.floor(input.deadlineMs - (performance.now() - start));
    if (remaining < 1) throw new RpcTransportError('deadline');
    client = new JsonlRpcClient({ command: 'codex', args: ['app-server', 'proxy', ...(input.socketPath ? ['--sock', input.socketPath] : [])], deadlineMs: remaining });
    await client.request('initialize', { clientInfo: { name: 'khala_attachment_probe', version: '0.0.0' }, capabilities: { experimentalApi: true } });
    await client.notify('initialized');
    observe('proxy_initialized');
    const before = thread(await client.request('thread/read', { threadId: input.sessionId, includeTurns: false }));
    report.observedSessionId = before.id;
    report.facts.workdirMatched = before.cwd === input.expectedWorkdir;
    report.facts.modelAvailable = Boolean(before.model);
    observe('target_metadata_read');
    if (before.id !== input.sessionId || !report.facts.workdirMatched || !before.model ||
        before.canAcceptDirectInput !== true || before.status.type !== (input.mode === 'busy' ? 'active' : 'idle')) {
      limit('Target identity, workdir, loaded input capability, model, or requested idle/busy state did not match. No nonce sent.');
      return report;
    }
    if (!input.release) { limit('Read-only preflight: release was not requested; no nonce sent.'); return report; }
    report.facts.operationId = randomUUID();
    // From this boundary forward, any missing reply is ambiguous. Never retry.
    report.facts.inputAttempted = true;
    observe('queue_request_attempted');
    const result = await client.request<{ queuedSubmission: { id: string; clientUserMessageId: string } }>('thread/queue/add', {
      threadId: input.sessionId, clientUserMessageId: report.facts.operationId,
      input: [{ type: 'text', text: `Synthetic approved attachment probe: report ${input.nonce} alongside the prior context marker you already know. Do not perform tools or change settings.`, text_elements: [] }],
    });
    if (!result?.queuedSubmission || typeof result.queuedSubmission.id !== 'string' ||
        result.queuedSubmission.id.length < 1 || result.queuedSubmission.id.length > 1024 || result.queuedSubmission.clientUserMessageId !== report.facts.operationId) throw new RpcTransportError('protocol');
    report.facts.queueAccepted = true;
    report.facts.queueId = 'sha256:' + createHash('sha256').update(result.queuedSubmission.id).digest('hex');
    observe('native_queue_accepted');
    const after = thread(await client.request('thread/read', { threadId: input.sessionId, includeTurns: false }));
    report.facts.modelUnchanged = after.model === before.model;
    report.facts.workdirMatched = after.cwd === input.expectedWorkdir;
    if (after.id !== before.id || !report.facts.modelUnchanged || !report.facts.workdirMatched) limit('Metadata changed after enqueue; preservation check failed.');
    observe('post_queue_metadata_read');
    limit('No consumption observer is attached. A fixture must establish prior-marker response, executor identity, permissions, and busy timing independently.');
    return report;
  } catch (error) {
    observe(error instanceof RpcTransportError ? `transport_${error.code}` : 'probe_error');
    limit(report.facts.inputAttempted ? 'Delivery is uncertain after the request attempt. Do not replay without established native reconciliation/deduplication semantics.' : 'Preflight failed before a nonce request; this is not a harness-wide unsupported verdict.');
    return report;
  } finally {
    await client?.close();
    observe('client_cleaned_up');
  }
}

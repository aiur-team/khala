import type { BindingId, PolicySetCommand } from '@khala/contracts/delivery/index';
import type { ControlsClient } from './browser-port';
import { parsePublicOrigin } from '../human/hosted-config';
import { createMailboxReadRetry } from '../human/mailbox-retry';

const SUBMIT = '/api/human/owner-mailbox/submit';
const RESULT = '/api/human/owner-mailbox/result';

type Fetch = typeof globalThis.fetch;
type Reply = Readonly<{ status: number; body: unknown }>;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The same-origin human mailbox supplies owner authority from the cookie and CSRF session. */
export function createOwnerMailboxControlsClient(input: Readonly<{
  origin: string;
  allowInsecureLoopback?: boolean;
  csrf: () => Promise<string | null>;
  fetch?: Fetch;
  waitMs?: number;
}>): ControlsClient {
  const origin = new URL(input.origin);
  if (parsePublicOrigin(input.origin, input.allowInsecureLoopback) !== input.origin) throw new Error('controls_origin_invalid');
  const request = input.fetch ?? globalThis.fetch.bind(globalThis);
  const waitMs = input.waitMs ?? 8_000;
  const possiblySubmitted = new Set<string>();
  const originalCommands = new Map<string, PolicySetCommand>();
  const pendingStatuses = new Map<BindingId, string>();
  const retry = createMailboxReadRetry();

  async function read(response: Response): Promise<Reply> {
    if (!(response.headers.get('content-type') ?? '').startsWith('application/json')) return { status: response.status, body: null };
    try { return { status: response.status, body: await response.json() as unknown }; }
    catch { return { status: response.status, body: null }; }
  }

  async function result(bindingId: BindingId, operationId: string, signal: AbortSignal): Promise<Reply | null> {
    const url = new URL(RESULT, origin);
    url.searchParams.set('binding_id', bindingId);
    url.searchParams.set('operation_id', operationId);
    try {
      return await read(await request(url, { method: 'GET', credentials: 'same-origin', signal,
        headers: { accept: 'application/json' } }));
    } catch { return null; }
  }

  async function submit(bindingId: BindingId, operationId: string, kind: 'controls_status' | 'controls_set',
    body: unknown, signal: AbortSignal): Promise<Reply | null> {
    const csrf = await input.csrf();
    if (signal.aborted) return null;
    if (!csrf) return { status: 401, body: null };
    try {
      return await read(await request(new URL(SUBMIT, origin), {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-khala-csrf': csrf },
        body: JSON.stringify({ bindingId, operationId, kind, body }),
      }));
    } catch { return null; }
  }

  async function awaitOutcome(bindingId: BindingId, operationId: string, first: Reply | null,
    signal: AbortSignal): Promise<Reply | null> {
    if (first?.status !== 200 || !object(first.body) || first.body.operationId !== operationId) return first;
    if (first.body.outcome !== null) return first;
    const deadline = Date.now() + waitMs;
    while (!signal.aborted && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 200));
      if (signal.aborted) return null;
      const next = await result(bindingId, operationId, signal);
      if (next?.status !== 200 || !object(next.body) || next.body.operationId !== operationId) return next;
      if (next.body.outcome !== null) return next;
    }
    return null;
  }

  function completed(answer: Reply | null, operationId: string): Record<string, unknown> | null {
    return answer?.status === 200 && object(answer.body) && answer.body.operationId === operationId
      && object(answer.body.outcome) ? answer.body.outcome : null;
  }

  return {
    async status(bindingId, signal) {
      if (!retry.ready(bindingId)) return { kind: 'refused', code: 'unavailable' };
      let operationId = pendingStatuses.get(bindingId);
      const created = operationId === undefined;
      if (!operationId) {
        operationId = `status_${crypto.randomUUID().replaceAll('-', '')}`;
        pendingStatuses.set(bindingId, operationId);
      }
      const existing = created ? null : await result(bindingId, operationId, signal);
      const first = existing?.status === 404 || existing === null
        ? await submit(bindingId, operationId, 'controls_status', { bindingId }, signal) : existing;
      const answer = created || first !== existing ? await awaitOutcome(bindingId, operationId, first, signal) : first;
      const outcome = completed(answer, operationId);
      if (outcome) pendingStatuses.delete(bindingId);
      if (outcome?.code === 'unavailable') retry.delay(bindingId);
      else if (outcome || answer?.status === 401 || answer?.status === 403) retry.clear(bindingId);
      else if (!signal.aborted) retry.delay(bindingId);
      if (answer?.status === 401 || answer?.status === 403) return { kind: 'refused', code: 'forbidden' };
      if (outcome?.ok === true && 'status' in outcome) return { kind: 'ok', body: outcome.status };
      if (outcome?.ok === false && (outcome.code === 'forbidden' || outcome.code === 'unavailable')) {
        return { kind: 'refused', code: outcome.code };
      }
      return { kind: 'refused', code: 'unavailable' };
    },
    async setPolicy(command: PolicySetCommand) {
      // The controller recreates issuedAt on retry. Pin the first complete wire body:
      // the mailbox deduplicates only an identical command under this operation ID.
      const operationId = command.commandId;
      const original = originalCommands.get(operationId);
      if (original && (original.bindingId !== command.bindingId || original.roomId !== command.roomId
        || original.expectedBindingGeneration !== command.expectedBindingGeneration
        || original.expectedPolicyVersion !== command.expectedPolicyVersion
        || original.peerParticipantId !== command.peerParticipantId
        || original.mode !== command.mode || original.paused !== command.paused)) return { kind: 'lost' };
      if (!original) originalCommands.set(operationId, command);
      const signal = AbortSignal.timeout(waitMs);
      const previousAttempt = possiblySubmitted.has(operationId);
      possiblySubmitted.add(operationId);
      const first = await submit(command.bindingId, operationId, 'controls_set', original ?? command, signal);
      // A later denial cannot disprove an earlier write whose response was lost.
      if (first?.status === 401 || first?.status === 403) return previousAttempt
        ? { kind: 'lost' } : { kind: 'refused', code: 'forbidden' };
      const answer = await awaitOutcome(command.bindingId, operationId, first, signal);
      const outcome = completed(answer, operationId);
      if (outcome?.ok === true && 'ack' in outcome) return { kind: 'answered', body: outcome.ack };
      if (outcome?.ok === false && outcome.code === 'forbidden') return { kind: 'refused', code: 'forbidden' };
      return { kind: 'lost' };
    },
  };
}

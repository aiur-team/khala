import { decodeApprovalCommand, decodeDeliveryLimits, type ApprovalCommand, type BindingId } from '@khala/contracts/delivery/index';
import type { RoomId } from '@khala/contracts/messaging/index';
import type { ReviewControlClient, ReviewPreviewRequest } from './browser-port';
import { parsePublicOrigin } from '../human/hosted-config';

const SUBMIT = '/api/human/owner-mailbox/submit';
const RESULT = '/api/human/owner-mailbox/result';
const BINDINGS = '/api/human/owner-mailbox/review-bindings';

type Fetch = typeof globalThis.fetch;
type Reply = Readonly<{ status: number; body: unknown }>;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type OwnerReviewBinding = Readonly<{ bindingId: BindingId; generation: number; agentParticipantId: string;
  device: Readonly<{ userId: string; deviceId: string; fingerprint: string }> | null }>;

/** Same-origin, cookie-authenticated human route. Authority is never supplied by this client. */
export function createOwnerMailboxReviewClient(input: Readonly<{
  origin: string;
  allowInsecureLoopback?: boolean;
  csrf: () => Promise<string | null>;
  fetch?: Fetch;
  waitMs?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}>): Readonly<{ review: ReviewControlClient; bindings(roomId: RoomId, signal: AbortSignal): Promise<readonly OwnerReviewBinding[] | null> }> {
  const origin = new URL(input.origin);
  if (parsePublicOrigin(input.origin, input.allowInsecureLoopback) !== input.origin) throw new Error('review_origin_invalid');
  const request = input.fetch ?? globalThis.fetch.bind(globalThis);
  const waitMs = input.waitMs ?? 8_000;
  const submittedCommands = new Set<string>();
  const limits = (() => {
    const decoded = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
    if (!decoded.ok) throw new Error('review_limits_invalid');
    return decoded.value;
  })();
  const storage = input.storage ?? (typeof globalThis.sessionStorage === 'undefined' ? null : globalThis.sessionStorage);
  const key = (bindingId: BindingId, roomId: RoomId, generation: number) =>
    `khala.review.unknown.v1:${bindingId}:${roomId}:${generation}`;
  function pending(bindingId: BindingId, roomId: RoomId, generation?: number): ApprovalCommand | null {
    if (generation === undefined) return null;
    try {
      const raw = storage?.getItem(key(bindingId, roomId, generation));
      if (!raw) return null;
      const decoded = decodeApprovalCommand(JSON.parse(raw) as unknown, limits);
      if (!decoded.ok || decoded.value.bindingId !== bindingId || decoded.value.roomId !== roomId
        || decoded.value.expectedBindingGeneration !== generation) return null;
      submittedCommands.add(decoded.value.commandId);
      return decoded.value;
    } catch { return null; }
  }
  function remember(command: ApprovalCommand): void {
    try { storage?.setItem(key(command.bindingId, command.roomId, command.expectedBindingGeneration), JSON.stringify(command)); }
    catch { /* Read-only reconciliation remains available in this tab. */ }
  }
  function forget(command: ApprovalCommand): void {
    try { storage?.removeItem(key(command.bindingId, command.roomId, command.expectedBindingGeneration)); }
    catch { /* No authority depends on storage cleanup. */ }
  }

  async function read(response: Response): Promise<Reply> {
    if (!(response.headers.get('content-type') ?? '').startsWith('application/json')) return { status: response.status, body: null };
    try { return { status: response.status, body: await response.json() as unknown }; }
    catch { return { status: response.status, body: null }; }
  }
  async function result(bindingId: BindingId, operationId: string, signal: AbortSignal): Promise<Reply | null> {
    const url = new URL(RESULT, origin);
    url.searchParams.set('binding_id', bindingId);
    url.searchParams.set('operation_id', operationId);
    try { return await read(await request(url, { method: 'GET', credentials: 'same-origin', signal,
      headers: { accept: 'application/json' } })); }
    catch { return null; }
  }
  async function submit(bindingId: BindingId, operationId: string, kind: 'review_preview' | 'review_approve',
    body: unknown, signal: AbortSignal): Promise<Reply | null> {
    const csrf = await input.csrf();
    if (!csrf) return { status: 401, body: null };
    try { return await read(await request(new URL(SUBMIT, origin), {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-khala-csrf': csrf },
      body: JSON.stringify({ bindingId, operationId, kind, body }),
    })); }
    catch { return null; }
  }
  async function awaitOutcome(bindingId: BindingId, operationId: string, first: Reply | null,
    signal: AbortSignal): Promise<Reply | null> {
    if (first?.status !== 200 || !object(first.body) || first.body.operationId !== operationId) return first;
    if (first.body.outcome !== null) return first;
    const deadline = Date.now() + waitMs;
    while (!signal.aborted && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 200));
      const next = await result(bindingId, operationId, signal);
      if (next?.status !== 200 || !object(next.body) || next.body.operationId !== operationId) return next;
      if (next.body.outcome !== null) return next;
    }
    return null;
  }
  const review: ReviewControlClient = {
    recoverUnknown: pending,
    async preview(body: ReviewPreviewRequest, signal: AbortSignal) {
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body))));
      const digest = Array.from(hash.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
      const operationId = `preview_${digest}_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
      const answer = await awaitOutcome(body.bindingId, operationId,
        await submit(body.bindingId, operationId, 'review_preview', body, signal), signal);
      if (answer?.status === 401 || answer?.status === 403) return { kind: 'refused', code: 'forbidden' };
      if (answer?.status !== 200 || !object(answer.body) || answer.body.operationId !== operationId
        || !object(answer.body.outcome)) return { kind: 'lost' };
      const outcome = answer.body.outcome;
      if (outcome.ok === true && 'preview' in outcome) return { kind: 'ok', body: outcome.preview };
      if (outcome.ok === false && ['forbidden', 'revoked', 'unavailable'].includes(String(outcome.code))) {
        return { kind: 'refused', code: outcome.code as 'forbidden' | 'revoked' | 'unavailable' };
      }
      return { kind: 'lost' };
    },
    async approve(command: ApprovalCommand) {
      const prior = pending(command.bindingId, command.roomId, command.expectedBindingGeneration);
      if (prior && prior.commandId !== command.commandId) return { kind: 'lost' };
      // Once a write may have happened, reconcile by read only. The browser
      // controller supplies the same command ID for every unknown retry.
      const signal = AbortSignal.timeout(waitMs);
      const previouslySubmitted = submittedCommands.has(command.commandId);
      submittedCommands.add(command.commandId);
      if (!previouslySubmitted) remember(command);
      const answer = await awaitOutcome(command.bindingId, command.commandId,
        previouslySubmitted ? await result(command.bindingId, command.commandId, signal)
          : await submit(command.bindingId, command.commandId, 'review_approve', command, signal), signal);
      if (answer?.status === 200 && object(answer.body) && answer.body.operationId === command.commandId
        && answer.body.outcome !== null) {
        if (object(answer.body.outcome) && answer.body.outcome.ok !== undefined
          && answer.body.outcome.code !== 'outcome_unknown') forget(command);
        return { kind: 'answered', body: answer.body.outcome };
      }
      // A previous attempt with the same command ID may have committed before
      // authorization was lost. This result cannot prove that it did not.
      if (answer?.status === 409) { forget(command); return { kind: 'answered', body: { ok: false, code: 'idempotency_conflict' } }; }
      return { kind: 'lost' };
    },
  };
  return {
    review,
    async bindings(roomId, signal) {
      const url = new URL(BINDINGS, origin);
      url.searchParams.set('room_id', roomId);
      try {
        const response = await read(await request(url, { method: 'GET', credentials: 'same-origin', signal,
          headers: { accept: 'application/json' } }));
        if (response.status !== 200 || !object(response.body) || response.body.v !== 1
          || response.body.roomId !== roomId || !Array.isArray(response.body.bindings)) return null;
        const bindings: OwnerReviewBinding[] = [];
        for (const item of response.body.bindings) {
          if (!object(item) || typeof item.bindingId !== 'string' || typeof item.agentParticipantId !== 'string'
            || !Number.isSafeInteger(item.generation) || (item.generation as number) < 0
            || !(item.device === null || (object(item.device) && typeof item.device.userId === 'string'
              && item.device.userId.startsWith('@') && typeof item.device.deviceId === 'string'
              && typeof item.device.fingerprint === 'string'
              && /^[A-Za-z0-9+/]{43}=?$/u.test(item.device.fingerprint)))) return null;
          bindings.push(item as OwnerReviewBinding);
        }
        return bindings;
      } catch { return null; }
    },
  };
}

import type { ListeningModeCommand, ListeningModeResult, ListeningModeView, SessionBinding, OwnerAuthority } from '@khala/contracts/delivery/index';
import type { JsonValue } from '@khala/contracts/messaging/index';
import type { AdapterCapability } from '@khala/connector/bootstrap/index';
import type { ProofSigner } from '@khala/connector/bootstrap/proof';
import { readBounded } from '@khala/connector/bootstrap/discovery';
import type { HostedSubscriptionDiagnostic } from '@khala/connector/subscription/diagnostic';
import type { PolicyControlHandler } from '../controls/control-handler';
import type { ReviewControlHandler } from '../review/control-handler';
import type { LocalStopRequest, LocalStopReceipt } from '../closure/local-fence';
import { refusedListeningModeResult } from '@khala/policy/listening-mode/store';

const POLL = '/api/agent/owner-mailbox/poll';
const COMPLETE = '/api/agent/owner-mailbox/complete';
const MAX_RESPONSE = 2 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{8,64}$/u;
type Command = Readonly<{
  operationId: string;
  kind: 'controls_status' | 'controls_set' | 'listening_set' | 'review_preview' | 'review_approve' | 'channel_stop';
  body: JsonValue;
  authority: OwnerAuthority;
  outcome: null;
}>;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function command(value: unknown, binding: SessionBinding): Command | null {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'authority,body,kind,operationId,outcome'
    || typeof value.operationId !== 'string' || !ID.test(value.operationId)
    || !['controls_status', 'controls_set', 'listening_set', 'review_preview', 'review_approve', 'channel_stop'].includes(String(value.kind))
    || value.outcome !== null || !object(value.body) || !object(value.authority)
    || value.authority.ownerId !== binding.ownerId || typeof value.authority.issuer !== 'string'
    || typeof value.authority.subject !== 'string' || typeof value.authority.authorizationId !== 'string'
    || typeof value.authority.authenticatedAt !== 'string') return null;
  return value as Command;
}
async function responseBody(response: Response): Promise<unknown | null> {
  if ((response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') return null;
  const bytes = await readBounded(response, MAX_RESPONSE);
  if (!bytes) return null;
  try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as unknown; }
  catch { return null; }
}

/**
 * Pulls metadata commands only through the DPoP-bound same-origin relay. The
 * hosted server has already authenticated the OIDC owner and checked current
 * binding, generation, room membership and its stored authority MAC. The
 * endpoint additionally rejects any cross-binding response before invoking
 * local owner-only handlers. Model tools never call this processor.
 */
export function createProductionOwnerMailbox(input: Readonly<{
  appOrigin: string;
  binding: SessionBinding;
  signer: ProofSigner;
  capability(): Promise<AdapterCapability | null>;
  controls?: PolicyControlHandler;
  listening?: () => Readonly<{
    read(authority: OwnerAuthority): Promise<Readonly<{ ok: true; view: ListeningModeView }> | Readonly<{ ok: false; code: string }>>;
    set(authority: OwnerAuthority, command: ListeningModeCommand): Promise<ListeningModeResult>;
  }> | null;
  review?: ReviewControlHandler | (() => ReviewControlHandler | null);
  stop(request: LocalStopRequest): Promise<Readonly<{ kind: 'stopped'; receipt: LocalStopReceipt }> | Readonly<{ kind: 'unavailable' }>>;
  onRevoked(): Promise<void>;
  fetch?: typeof fetch;
  diagnostic?(event: HostedSubscriptionDiagnostic): void;
}>) {
  const report = (result: HostedSubscriptionDiagnostic['result'], httpStatus?: number) => {
    try { input.diagnostic?.({ stage: 'mailbox_http', result,
      ...(httpStatus === undefined ? {} : { httpStatus }) }); }
    catch { /* Diagnostics cannot change authorization. */ }
  };
  const reportPoll = (stage: HostedSubscriptionDiagnostic['stage'],
    result: HostedSubscriptionDiagnostic['result'], httpStatus?: number, pendingCount?: number) => {
    try { input.diagnostic?.({ stage, result,
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(pendingCount === undefined ? {} : { pendingCount }) }); }
    catch { /* Diagnostics cannot change mailbox processing. */ }
  };
  const url = new URL(input.appOrigin);
  if (url.protocol !== 'https:' || url.origin !== input.appOrigin) throw new Error('mailbox_origin_invalid');
  const transport = input.fetch ?? fetch;
  const pollUrl = `${input.appOrigin}${POLL}`;
  const completeUrl = `${input.appOrigin}${COMPLETE}`;
  let closed = false;
  let inFlight: Promise<'ok' | 'unavailable' | 'revoked'> | null = null;
  let lastPendingCount: number | null = null;

  function validPoll(value: unknown): value is Record<string, unknown> & { closing: boolean; entries: unknown[] } {
    if (!object(value) || value.v !== 1 || value.bindingId !== input.binding.bindingId
      || value.generation !== input.binding.generation || typeof value.closing !== 'boolean'
      || !Array.isArray(value.entries) || value.entries.length > 65) return false;
    const seen = new Set<string>();
    let ordinary = 0;
    let stops = 0;
    for (const raw of value.entries) {
      const entry = command(raw, input.binding);
      if (!entry || seen.has(entry.operationId)) return false;
      seen.add(entry.operationId);
      if (entry.kind === 'channel_stop') stops += 1;
      else ordinary += 1;
    }
    return ordinary <= 64 && stops <= 1 && (!value.closing || ordinary === 0);
  }

  async function call(method: 'GET' | 'POST', target: string, body?: unknown): Promise<Readonly<{ status: number; body: unknown | null }> | null> {
    const capability = await input.capability();
    if (!capability || capability.bindingId !== input.binding.bindingId || capability.generation !== input.binding.generation) return null;
    try {
      const response = await transport(target, {
        method, headers: { accept: 'application/json', authorization: `DPoP ${capability.token}`,
          dpop: input.signer.proof(method, target, capability.token),
          ...(method === 'POST' ? { 'content-type': 'application/json', origin: input.appOrigin } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await responseBody(response) };
    } catch { return null; }
  }

  async function execute(entry: Command): Promise<JsonValue | null> {
    switch (entry.kind) {
      case 'controls_status': {
        if (!input.controls) return null;
        const status = await input.controls.status(entry.authority, entry.body);
        if (!status.ok) return status as JsonValue;
        let listening: ReturnType<NonNullable<typeof input.listening>> = null;
        try { listening = input.listening?.() ?? null; } catch { /* Policy status remains usable. */ }
        if (!listening) return { ok: true, status: { ...status.status,
          listening: null, listeningUnavailable: 'connector_starting' } } as JsonValue;
        try {
          const read = await listening.read(entry.authority);
          return { ok: true, status: { ...status.status, listening: read.ok ? read.view : null,
            listeningUnavailable: read.ok ? null : 'connector_unavailable' } } as JsonValue;
        } catch {
          return { ok: true, status: { ...status.status,
            listening: null, listeningUnavailable: 'connector_unavailable' } } as JsonValue;
        }
      }
      case 'controls_set': return input.controls ? input.controls.setPolicy(entry.authority, entry.body) as Promise<JsonValue> : null;
      case 'listening_set': {
        const listening = input.listening?.();
        return listening ? await listening.set(entry.authority, entry.body as ListeningModeCommand) as JsonValue
          : refusedListeningModeResult(entry.body as ListeningModeCommand, 'unavailable') as JsonValue;
      }
      case 'review_preview': {
        const handler = typeof input.review === 'function' ? input.review() : input.review;
        return handler ? handler.preview(entry.authority, entry.body) as Promise<JsonValue> : null;
      }
      case 'review_approve': {
        const handler = typeof input.review === 'function' ? input.review() : input.review;
        return handler ? handler.approve(entry.authority, entry.body) as Promise<JsonValue> : null;
      }
      case 'channel_stop': {
        const body = entry.body;
        if (!object(body) || Object.keys(body).sort().join(',') !== 'expectedRoomRevision,operationId,ownerId,roomId'
          || body.ownerId !== input.binding.ownerId || typeof body.roomId !== 'string'
          || body.operationId !== entry.operationId || body.expectedRoomRevision !== 0) return null;
        const result = await input.stop(body as LocalStopRequest);
        return result.kind === 'stopped' ? result as JsonValue : null;
      }
    }
  }

  async function authorize(): Promise<'active' | 'closing' | 'revoked' | 'unavailable'> {
    if (closed) return 'revoked';
    const polled = await call('GET', pollUrl);
    if (!polled) { report('unavailable'); return 'unavailable'; }
    if (polled.status === 401 || polled.status === 403) {
      report('revoked', polled.status);
      closed = true;
      await input.onRevoked();
      return 'revoked';
    }
    if (polled.status !== 200 || !validPoll(polled.body)) {
      report('unavailable', polled.status);
      return 'unavailable';
    }
    if (polled.body.closing) report('closing', polled.status);
    return polled.body.closing ? 'closing' : 'active';
  }

  async function pollOnce(): Promise<'ok' | 'unavailable' | 'revoked'> {
      if (closed) return 'unavailable';
      const polled = await call('GET', pollUrl);
      if (!polled) { reportPoll('mailbox_poll_fetch', 'unavailable'); return 'unavailable'; }
      if (polled.status === 401 || polled.status === 403) {
        reportPoll('mailbox_poll_fetch', 'revoked', polled.status);
        closed = true;
        await input.onRevoked();
        return 'revoked';
      }
      if (polled.status !== 200 || !validPoll(polled.body)) {
        reportPoll('mailbox_poll_fetch', 'unavailable', polled.status);
        return 'unavailable';
      }
      const entries = polled.body.entries.map(value => command(value, input.binding));
      if (entries.some(value => value === null)) {
        reportPoll('mailbox_poll_entries', 'unavailable', polled.status);
        return 'unavailable';
      }
      if (lastPendingCount !== entries.length) {
        reportPoll('mailbox_poll_entries', 'ok', polled.status, entries.length);
        lastPendingCount = entries.length;
      }
      for (const entry of entries) {
        if (!entry || closed) return 'unavailable';
        let result: JsonValue | null;
        try { result = await execute(entry); }
        catch { reportPoll('mailbox_poll_execute', 'unavailable'); return 'unavailable'; }
        if (result === null) { reportPoll('mailbox_poll_execute', 'unavailable'); return 'unavailable'; }
        reportPoll('mailbox_poll_execute', 'ok');
        const completed = await call('POST', completeUrl, {
          bindingId: input.binding.bindingId, operationId: entry.operationId, outcome: result,
        });
        if (!completed || completed.status !== 200 || !object(completed.body)
          || completed.body.v !== 1 || completed.body.operationId !== entry.operationId) {
          reportPoll('mailbox_poll_complete', 'unavailable', completed?.status);
          return 'unavailable';
        }
        reportPoll('mailbox_poll_complete', 'ok', completed.status);
        if (entry.kind === 'channel_stop') { closed = true; return 'revoked'; }
      }
      // Closure can precede the durable stop command. Keep polling until its
      // local fence receipt is submitted; authorize() already blocks intake.
      return 'ok';
  }
  return {
    authorize,
    pollOnce() {
      if (!inFlight) inFlight = pollOnce().finally(() => { inFlight = null; });
      return inFlight;
    },
    close() { closed = true; },
  };
}

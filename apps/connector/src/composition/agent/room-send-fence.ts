import type { AdapterCapability } from '@khala/connector/bootstrap/index';
import type { ProofSigner } from '@khala/connector/bootstrap/proof';
import { readBounded } from '@khala/connector/bootstrap/discovery';

const ROOT = '/api/agent/room-send';
type Grant = Readonly<{ kind: 'granted'; permitId: string }>;
type Hold = Readonly<{ kind: 'held'; operationId: string; epoch: number }>;
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
async function body(response: Response): Promise<Record<string, unknown> | null> {
  if ((response.headers.get('content-type') ?? '').split(';')[0]?.trim() !== 'application/json') return null;
  const bytes = await readBounded(response, 8192);
  if (!bytes) return null;
  try { const parsed: unknown = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); return object(parsed) ? parsed : null; }
  catch { return null; }
}

/** Connector-owned DPoP client; no model process receives permits, capabilities or rotation receipts. */
export function createAgentRoomSendFence(input: Readonly<{
  appOrigin: string; bindingId: string; generation: number; signer: ProofSigner;
  capability(): Promise<AdapterCapability | null>;
  discardOutboundSession(): Promise<boolean>;
  fetch?: typeof fetch;
}>) {
  if (new URL(input.appOrigin).protocol !== 'https:' || new URL(input.appOrigin).origin !== input.appOrigin) {
    throw new Error('room_send_origin_invalid');
  }
  const transport = input.fetch ?? fetch;
  let ready = false;
  async function call(action: 'ready' | 'acquire' | 'finish' | 'rotation' | 'inspect', value: unknown): Promise<Readonly<{
    status: number; body: Record<string, unknown> | null;
  }> | null> {
    const capability = await input.capability();
    if (!capability || capability.bindingId !== input.bindingId || capability.generation !== input.generation) return null;
    const target = `${input.appOrigin}${ROOT}/${action}`;
    try {
      const response = await transport(target, { method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', origin: input.appOrigin,
          authorization: `DPoP ${capability.token}`, dpop: input.signer.proof('POST', target, capability.token) },
        body: JSON.stringify(value), redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await body(response) };
    } catch { return null; }
  }
  async function register(): Promise<boolean> {
    if (ready) return true;
    if (!await input.discardOutboundSession()) return false;
    const result = await call('ready', {});
    if (result?.status !== 200 || result.body?.kind !== 'applied') return false;
    ready = true;
    return true;
  }
  async function acquire(clientTxnId: string): Promise<Grant | Hold | null> {
    await register();
    const result = await call('acquire', { clientTxnId });
    if (result?.status === 200 && result.body?.kind === 'granted' && typeof result.body.permitId === 'string') {
      return { kind: 'granted', permitId: result.body.permitId };
    }
    if (result?.status === 423 && result.body?.kind === 'held' && typeof result.body.operationId === 'string'
      && Number.isSafeInteger(result.body.epoch)) return { kind: 'held', operationId: result.body.operationId,
      epoch: result.body.epoch as number };
    return null;
  }
  return {
    acquire,
    async finish(permitId: string, outcome: Readonly<{ kind: 'complete'; eventId: string }> | Readonly<{ kind: 'unknown' | 'cancelled' }>): Promise<boolean> {
      const result = await call('finish', { permitId, outcome: outcome.kind,
        eventId: outcome.kind === 'complete' ? outcome.eventId : null });
      return result?.status === 200 && result.body?.kind === 'applied';
    },
    async rotate(operationId: string, epoch: number): Promise<boolean> {
      if (!await input.discardOutboundSession()) return false;
      const result = await call('rotation', { operationId, epoch });
      return result?.status === 200 && result.body?.kind === 'applied';
    },
    async pollRotation(): Promise<void> {
      const result = await call('inspect', {});
      const hold = result?.status === 200 && result.body?.kind === 'ok' && object(result.body.hold)
        ? result.body.hold : null;
      if (hold && typeof hold.operationId === 'string' && Number.isSafeInteger(hold.epoch)) {
        await this.rotate(hold.operationId, hold.epoch as number);
      }
    },
  };
}

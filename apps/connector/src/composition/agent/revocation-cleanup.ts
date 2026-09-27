import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { AdapterCapability } from '@khala/connector/bootstrap/index';
import type { ProofSigner } from '@khala/connector/bootstrap/proof';
import { readBounded } from '@khala/connector/bootstrap/discovery';

const CLEANUP = '/api/agent/revocation/cleanup';
const RESULT = '/api/agent/revocation/result';
const KEY = /^[A-Za-z0-9+/]{43}=?$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
type Removal = 'removed' | 'replaced' | 'reauthentication_required' | 'forbidden' | 'unavailable';
type Command = Readonly<{ v: 1; operationId: string; deviceId: string; deviceKey: string; generation: number;
  removal: null | Exclude<Removal, 'unavailable'> }>;
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function command(value: unknown, binding: SessionBinding): value is Command {
  return object(value) && Object.keys(value).sort().join(',') === 'deviceId,deviceKey,generation,operationId,removal,v'
    && value.v === 1 && typeof value.operationId === 'string' && ID.test(value.operationId)
    && value.deviceId === binding.deviceId && typeof value.deviceKey === 'string' && KEY.test(value.deviceKey)
    && value.generation === binding.generation
    && (value.removal === null || ['removed', 'replaced', 'reauthentication_required', 'forbidden'].includes(String(value.removal)));
}
async function body(response: Response): Promise<unknown | null> {
  if ((response.headers.get('content-type') ?? '').split(';')[0]?.trim() !== 'application/json') return null;
  const bytes = await readBounded(response, 8192);
  if (!bytes) return null;
  try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as unknown; } catch { return null; }
}

/** Only the revoked endpoint's SDK can produce this exact-device removal receipt. */
export function createProductionRevocationCleanup(input: Readonly<{
  appOrigin: string; binding: SessionBinding; signer: ProofSigner;
  existingCapability(): Promise<AdapterCapability | null>;
  quiesce(): Promise<void>;
  removeOwnDevice(expectedCurve25519: string): Promise<Removal>;
  fetch?: typeof fetch;
}>) {
  const origin = new URL(input.appOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== input.appOrigin) throw new Error('revocation_cleanup_origin_invalid');
  const transport = input.fetch ?? fetch;
  let completed = false;
  async function call(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<{ status: number; value: unknown | null } | null> {
    const capability = await input.existingCapability();
    if (!capability || capability.bindingId !== input.binding.bindingId || capability.generation !== input.binding.generation) return null;
    const target = `${input.appOrigin}${path}`;
    try {
      const response = await transport(target, { method,
        headers: { accept: 'application/json', authorization: `DPoP ${capability.token}`,
          dpop: input.signer.proof(method, target, capability.token),
          ...(method === 'POST' ? { origin: input.appOrigin, 'content-type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
        redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, value: await body(response) };
    } catch { return null; }
  }
  return {
    async pollOnce(): Promise<'complete' | 'pending' | 'unavailable'> {
      if (completed) return 'complete';
      const response = await call('GET', CLEANUP);
      if (!response || response.status !== 200 || !command(response.value, input.binding)) return 'unavailable';
      const instruction = response.value;
      if (instruction.removal !== null) { completed = true; return 'complete'; }
      await input.quiesce();
      const removal = await input.removeOwnDevice(instruction.deviceKey);
      if (removal === 'unavailable') return 'pending';
      const receipt = { operationId: instruction.operationId, deviceId: instruction.deviceId,
        deviceKey: instruction.deviceKey, generation: instruction.generation, removal };
      const posted = await call('POST', RESULT, receipt);
      if (!posted || posted.status !== 200 || !object(posted.value)
        || posted.value.operationId !== instruction.operationId || posted.value.removal !== removal) return 'pending';
      completed = true;
      return 'complete';
    },
  };
}

import { createHash } from 'node:crypto';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { AdapterCapability } from '@khala/connector/bootstrap/index';
import { readBounded } from '@khala/connector/bootstrap/discovery';
import type { ProofSigner } from '@khala/connector/bootstrap/proof';

const CHALLENGE_PATH = '/api/agent/device-attestation/challenge';
const REGISTER_PATH = '/api/agent/device-attestation/register';
const NONCE = /^[A-Za-z0-9_-]{43}$/u;
const FINGERPRINT = /^[A-Za-z0-9+/]{43}=?$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_RESPONSE_BYTES = 4_096;

export type DeviceAttestationResult =
  | Readonly<{ kind: 'attested' }>
  | Readonly<{ kind: 'unavailable'; stage: 'fingerprint' | 'capability' | 'challenge_transport'
    | 'challenge_response' | 'register_transport' | 'register_response' | 'internal' }>;

const unavailable = (stage: Extract<DeviceAttestationResult, { kind: 'unavailable' }>['stage']): DeviceAttestationResult =>
  ({ kind: 'unavailable', stage });

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

/** Registers only the Matrix key started for this exact, active binding. */
export function createAgentDeviceAttestation(input: Readonly<{
  appOrigin: string;
  binding: SessionBinding;
  signer: ProofSigner;
  capability(): Promise<AdapterCapability | null>;
  fingerprint(): string | null;
  fetch?: typeof fetch;
  clock?: () => number;
}>) {
  const origin = new URL(input.appOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== input.appOrigin) throw new Error('attestation_origin_invalid');
  const fetcher = input.fetch ?? fetch;
  const clock = input.clock ?? Date.now;
  const challengeUrl = `${input.appOrigin}${CHALLENGE_PATH}`;
  const registerUrl = `${input.appOrigin}${REGISTER_PATH}`;
  let attested = false;
  let pending: Promise<DeviceAttestationResult> | null = null;

  async function json(response: Response): Promise<unknown | null> {
    if (response.status !== 200 || (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    try {
      const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
      return bytes && bytes.length > 0 ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown : null;
    } catch { return null; }
  }

  async function register(): Promise<DeviceAttestationResult> {
    const fingerprint = input.fingerprint();
    if (!fingerprint || !FINGERPRINT.test(fingerprint)) return unavailable('fingerprint');
    const capability = await input.capability();
    if (!capability || capability.bindingId !== input.binding.bindingId
      || capability.generation !== input.binding.generation || capability.expiresAt <= clock()
      || !TOKEN.test(capability.token) || !capability.scope.includes('publish_own')) return unavailable('capability');
    const authorization = `DPoP ${capability.token}`;
    let challenge: Response;
    try {
      challenge = await fetcher(challengeUrl, { method: 'GET', redirect: 'error', credentials: 'omit',
        headers: { accept: 'application/json', authorization,
          dpop: input.signer.proof('GET', challengeUrl, capability.token) },
        signal: AbortSignal.timeout(10_000) });
    } catch { return unavailable('challenge_transport'); }
    const issued = await json(challenge);
    if (!exact(issued, ['v', 'nonce', 'expiresAt']) || issued.v !== 1
      || typeof issued.nonce !== 'string' || !NONCE.test(issued.nonce)
      || !Number.isSafeInteger(issued.expiresAt) || (issued.expiresAt as number) <= clock()) return unavailable('challenge_response');
    const body = { v: 1 as const, bindingId: input.binding.bindingId, deviceId: input.binding.deviceId,
      generation: input.binding.generation, nonce: issued.nonce, fingerprint };
    const raw = JSON.stringify(body);
    const bodyHash = createHash('sha256').update(raw).digest('base64url');
    let response: Response;
    try {
      response = await fetcher(registerUrl, { method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { accept: 'application/json', 'content-type': 'application/json', origin: input.appOrigin,
          authorization, dpop: input.signer.proof('POST', registerUrl, capability.token,
            { nonce: issued.nonce, bodyHash }) },
        body: raw, signal: AbortSignal.timeout(10_000) });
    } catch { return unavailable('register_transport'); }
    const result = await json(response);
    return exact(result, ['v', 'kind']) && result.v === 1 && result.kind === 'attested'
      ? { kind: 'attested' } : unavailable('register_response');
  }

  return {
    ensure(): Promise<DeviceAttestationResult> {
      if (attested) return Promise.resolve({ kind: 'attested' });
      if (!pending) pending = register().then(result => { attested = result.kind === 'attested'; return result; })
        .catch(() => unavailable('internal')).finally(() => { pending = null; });
      return pending;
    },
  };
}

import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { AdapterCapability } from '@khala/connector/bootstrap/index';
import type { ProofSigner } from '@khala/connector/bootstrap/proof';
import { readBounded } from '@khala/connector/bootstrap/discovery';
import type { MatrixConnectorSubstrate } from '../../substrate/matrix';

const PATH = '/api/agent/owner-device-proof/lookup';
const FINGERPRINT = /^[A-Za-z0-9+/]{43}=?$/u;
const DEVICE = /^[A-Za-z0-9._=-]{1,255}$/u;

/** Trusts only public keys the current owner's protected browser registered. */
export function createOwnerDeviceTrust(input: Readonly<{
  appOrigin: string;
  binding: SessionBinding;
  roomId: string;
  ownerUserId: string;
  signer: ProofSigner;
  capability(): Promise<AdapterCapability | null>;
  matrix: MatrixConnectorSubstrate;
  fetch?: typeof fetch;
}>) {
  const url = `${input.appOrigin}${PATH}`;
  const fetcher = input.fetch ?? fetch;
  const trusted = new Map<string, string>();
  let pending: Promise<'active' | 'unavailable' | 'revoked'> | null = null;

  async function refresh(): Promise<'active' | 'unavailable' | 'revoked'> {
    const capability = await input.capability();
    if (!capability || capability.bindingId !== input.binding.bindingId
      || capability.generation !== input.binding.generation) return 'unavailable';
    let response: Response;
    try {
      response = await fetcher(url, { method: 'GET', redirect: 'error', credentials: 'omit',
        headers: { accept: 'application/json', authorization: `DPoP ${capability.token}`,
          dpop: input.signer.proof('GET', url, capability.token) }, signal: AbortSignal.timeout(10_000) });
    } catch { return 'unavailable'; }
    if (response.status === 401 || response.status === 403) return 'revoked';
    if (response.status !== 200 || (response.headers.get('content-type') ?? '').split(';')[0]?.trim() !== 'application/json') {
      await response.body?.cancel().catch(() => undefined);
      return 'unavailable';
    }
    const bytes = await readBounded(response, 16_384);
    if (!bytes) return 'unavailable';
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as unknown; }
    catch { return 'unavailable'; }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'unavailable';
    const data = body as Record<string, unknown>;
    if (Object.keys(data).sort().join(',') !== 'devices,roomId,v' || data.v !== 1
      || data.roomId !== input.roomId || !Array.isArray(data.devices) || data.devices.length > 32) return 'unavailable';
    const seen = new Set<string>();
    const pins: Array<{ deviceId: string; fingerprint: string }> = [];
    for (const value of data.devices) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'unavailable';
      const peer = value as Record<string, unknown>;
      if (Object.keys(peer).sort().join(',') !== 'deviceId,fingerprint'
        || typeof peer.deviceId !== 'string' || !DEVICE.test(peer.deviceId)
        || typeof peer.fingerprint !== 'string' || !FINGERPRINT.test(peer.fingerprint)
        || seen.has(peer.deviceId) || peer.deviceId === input.binding.deviceId) return 'unavailable';
      seen.add(peer.deviceId);
      if (trusted.has(peer.deviceId) && trusted.get(peer.deviceId) !== peer.fingerprint) return 'revoked';
      pins.push({ deviceId: peer.deviceId, fingerprint: peer.fingerprint });
    }
    for (const deviceId of trusted.keys()) if (!seen.has(deviceId)) return 'revoked';
    for (const peer of pins) {
      if (!trusted.has(peer.deviceId)) {
        try { await input.matrix.trustPeer(input.ownerUserId, peer.deviceId, peer.fingerprint); }
        catch { return 'unavailable'; }
        trusted.set(peer.deviceId, peer.fingerprint);
      }
    }
    return seen.size > 0 ? 'active' : 'unavailable';
  }
  return {
    ensure() {
      if (!pending) pending = refresh().finally(() => { pending = null; });
      return pending;
    },
  };
}

import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { AdapterCapability } from '@khala/connector/bootstrap/index';
import type { ProofSigner } from '@khala/connector/bootstrap/proof';
import { readBounded } from '@khala/connector/bootstrap/discovery';
import type { HostedSubscriptionDiagnostic } from '@khala/connector/subscription/diagnostic';
import type { MatrixConnectorSubstrate } from '../../substrate/matrix';
import type { DeviceAttestationResult } from './device-attestation';

const PATH = '/api/agent/owner-device-proof/lookup';
const FINGERPRINT = /^[A-Za-z0-9+/]{43}=?$/u;
const DEVICE = /^[A-Za-z0-9._=-]{1,255}$/u;

type TrustPeerFailure = 'device_key_missing' | 'fingerprint_mismatch' | 'closed'
  | 'pending' | 'compromised' | 'verification' | 'other';

const TRUST_CODES: ReadonlyArray<readonly [string, TrustPeerFailure]> = [
  ['matrix_device_key_missing', 'device_key_missing'],
  ['matrix_fingerprint_mismatch', 'fingerprint_mismatch'],
  ['matrix_closed', 'closed'],
  ['matrix_trust_pending', 'pending'],
  ['matrix_trust_compromised', 'compromised'],
  ['matrix_trust_recovery_required', 'compromised'],
  ['matrix_verification_failed', 'verification'],
  ['matrix_verification_rollback_failed', 'verification'],
];

/** Only exact, reviewed values leave this boundary. SDK error text never does. */
function trustPeerFailure(error: unknown): TrustPeerFailure {
  if (typeof error !== 'object' || error === null) return 'other';
  let message: unknown;
  try { message = (error as { message?: unknown }).message; } catch { return 'other'; }
  if (typeof message !== 'string' || message.length > 8192) return 'other';
  for (const [code, category] of TRUST_CODES) {
    const at = message.indexOf(code);
    if (at < 0) continue;
    const before = message[at - 1];
    const after = message[at + code.length];
    if ((before === undefined || !/[A-Za-z0-9_]/u.test(before))
      && (after === undefined || !/[A-Za-z0-9_]/u.test(after))) return category;
  }
  return 'other';
}

/** Trusts only public keys the current owner's protected browser registered. */
export function createOwnerDeviceTrust(input: Readonly<{
  appOrigin: string;
  binding: SessionBinding;
  roomId: string;
  ownerUserId: string;
  signer: ProofSigner;
  capability(): Promise<AdapterCapability | null>;
  registerOwnDevice(): Promise<DeviceAttestationResult>;
  matrix: MatrixConnectorSubstrate;
  fetch?: typeof fetch;
  diagnostic?(event: HostedSubscriptionDiagnostic): void;
}>) {
  const report = (result: HostedSubscriptionDiagnostic['result'], httpStatus?: number) => {
    try { input.diagnostic?.({ stage: 'owner_device_http', result,
      ...(httpStatus === undefined ? {} : { httpStatus }) }); }
    catch { /* Diagnostics cannot change owner trust. */ }
  };
  const reportLocal = (stage: HostedSubscriptionDiagnostic['stage']) => {
    try { input.diagnostic?.({ stage, result: 'unavailable' }); }
    catch { /* Diagnostics cannot change owner trust. */ }
  };
  const url = `${input.appOrigin}${PATH}`;
  const fetcher = input.fetch ?? fetch;
  const trusted = new Map<string, string>();
  let pending: Promise<'active' | 'unavailable' | 'revoked'> | null = null;

  async function refresh(): Promise<'active' | 'unavailable' | 'revoked'> {
    const own = await input.registerOwnDevice().catch(() => ({ kind: 'unavailable' as const, stage: 'internal' as const }));
    if (own.kind !== 'attested') {
      reportLocal(`owner_device_attestation_${own.stage}`);
      return 'unavailable';
    }
    const capability = await input.capability();
    if (!capability || capability.bindingId !== input.binding.bindingId
      || capability.generation !== input.binding.generation) {
      reportLocal('owner_device_capability');
      return 'unavailable';
    }
    let response: Response;
    try {
      response = await fetcher(url, { method: 'GET', redirect: 'error', credentials: 'omit',
        headers: { accept: 'application/json', authorization: `DPoP ${capability.token}`,
          dpop: input.signer.proof('GET', url, capability.token) }, signal: AbortSignal.timeout(10_000) });
    } catch { report('unavailable'); return 'unavailable'; }
    if (response.status === 401 || response.status === 403) { report('revoked', response.status); return 'revoked'; }
    if (response.status !== 200 || (response.headers.get('content-type') ?? '').split(';')[0]?.trim() !== 'application/json') {
      report('unavailable', response.status);
      await response.body?.cancel().catch(() => undefined);
      return 'unavailable';
    }
    const bytes = await readBounded(response, 16_384);
    if (!bytes) { report('unavailable', response.status); return 'unavailable'; }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as unknown; }
    catch { report('unavailable', response.status); return 'unavailable'; }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      report('unavailable', response.status); return 'unavailable';
    }
    const data = body as Record<string, unknown>;
    if (Object.keys(data).sort().join(',') !== 'devices,roomId,v' || data.v !== 1
      || data.roomId !== input.roomId || !Array.isArray(data.devices) || data.devices.length > 32) {
      report('unavailable', response.status); return 'unavailable';
    }
    const seen = new Set<string>();
    const pins: Array<{ deviceId: string; fingerprint: string }> = [];
    for (const value of data.devices) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'unavailable';
      const peer = value as Record<string, unknown>;
      if (Object.keys(peer).sort().join(',') !== 'deviceId,fingerprint'
        || typeof peer.deviceId !== 'string' || !DEVICE.test(peer.deviceId)
        || typeof peer.fingerprint !== 'string' || !FINGERPRINT.test(peer.fingerprint)
      || seen.has(peer.deviceId) || peer.deviceId === input.binding.deviceId) {
        report('unavailable', response.status); return 'unavailable';
      }
      seen.add(peer.deviceId);
      if (trusted.has(peer.deviceId) && trusted.get(peer.deviceId) !== peer.fingerprint) return 'revoked';
      pins.push({ deviceId: peer.deviceId, fingerprint: peer.fingerprint });
    }
    for (const deviceId of trusted.keys()) if (!seen.has(deviceId)) return 'revoked';
    for (const peer of pins) {
      if (!trusted.has(peer.deviceId)) {
        try { await input.matrix.trustPeer(input.ownerUserId, peer.deviceId, peer.fingerprint); }
        catch (error) {
          reportLocal(`owner_device_trust_peer_${trustPeerFailure(error)}`);
          return 'unavailable';
        }
        trusted.set(peer.deviceId, peer.fingerprint);
      }
    }
    if (seen.size === 0) {
      reportLocal('owner_device_empty');
      return 'unavailable';
    }
    return 'active';
  }
  return {
    ensure() {
      if (!pending) pending = refresh().finally(() => { pending = null; });
      return pending;
    },
  };
}

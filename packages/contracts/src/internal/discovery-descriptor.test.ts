import { describe, expect, it } from 'vitest';
import {
  INTERNAL_DISCOVERY_SCOPES, encodeInternalConnectorKey, encodeInternalDiscoveryDescriptor, parseInternalConnectorKey,
  parseInternalDiscoveryDescriptor,
} from './discovery-descriptor';

const principal = `agent_${'a'.repeat(43)}`;
const capability = `${'C'.repeat(42)}E`;
const descriptor = { v: 1, kind: 'discovery', principal, generation: 2, discoveryCapability: capability, scopes: INTERNAL_DISCOVERY_SCOPES } as const;
const key = { v: 1, kind: 'connector_proof_key', principal, generation: 2, publicKey: `${'P'.repeat(42)}A`, privateKey: `${'D'.repeat(42)}A` } as const;

describe('internal discovery descriptor', () => {
  it('round-trips exactly the discovery scopes and nothing else', () => {
    expect(parseInternalDiscoveryDescriptor(encodeInternalDiscoveryDescriptor(descriptor))).toEqual({ ok: true, value: descriptor });
    expect(INTERNAL_DISCOVERY_SCOPES).toEqual(['list_channels', 'request_channel_access', 'request_channel_create']);
  });

  it('refuses extra authority, missing fields and malformed values', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...descriptor, scopes: [...INTERNAL_DISCOVERY_SCOPES, 'send'] }, 'scopes'],
      [{ ...descriptor, bindingCapability: capability }, 'bindingCapability'],
      [{ ...descriptor, origin: 'http://127.0.0.1:4870' }, 'origin'],
      [{ ...descriptor, principal: 'someone' }, 'principal'],
      [{ ...descriptor, generation: 0 }, 'generation'],
      [{ ...descriptor, discoveryCapability: 'short' }, 'discoveryCapability'],
      [{ ...descriptor, kind: 'granted' }, 'kind'],
    ];
    for (const [value, field] of cases) expect(parseInternalDiscoveryDescriptor(JSON.stringify(value))).toEqual({ ok: false, field });
    expect(parseInternalDiscoveryDescriptor('{')).toEqual({ ok: false, field: '' });
    expect(parseInternalDiscoveryDescriptor(' '.repeat(2_000))).toEqual({ ok: false, field: '' });
  });

  it('keeps the connector key in its own format that never parses as a descriptor', () => {
    const text = encodeInternalConnectorKey(key);
    expect(parseInternalConnectorKey(text)).toEqual({ ok: true, value: key });
    expect(parseInternalDiscoveryDescriptor(text).ok).toBe(false);
    expect(parseInternalConnectorKey(encodeInternalDiscoveryDescriptor(descriptor)).ok).toBe(false);
    expect(parseInternalConnectorKey(JSON.stringify({ ...key, privateKey: key.publicKey }))).toEqual({ ok: false, field: 'privateKey' });
  });
});

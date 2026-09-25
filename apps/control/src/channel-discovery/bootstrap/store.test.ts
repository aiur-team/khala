import { describe, expect, it } from 'vitest';
import { digestDiscoverySecret, discoveryStoreKeys, parseCredentialRef, credentialRef } from './store';

describe('channel discovery store identifiers', () => {
  it('purpose-separates code, credential and limiter material', () => {
    const value = 'A'.repeat(43);
    expect(digestDiscoverySecret('code', value)).not.toBe(digestDiscoverySecret('credential', value));
    expect(discoveryStoreKeys.code(value)).not.toBe(discoveryStoreKeys.credential(value));
  });

  it('round-trips fixed-size credential references without storing the reference as a key', () => {
    const slot = 'A'.repeat(43);
    const secret = 'B'.repeat(43);
    const ref = credentialRef(slot, secret);
    expect(parseCredentialRef(ref)).toEqual({ slot, secret });
    expect(discoveryStoreKeys.slot(slot)).not.toContain(ref);
    expect(parseCredentialRef(`${ref}.extra`)).toBeNull();
  });
});

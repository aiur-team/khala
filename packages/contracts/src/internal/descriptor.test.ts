import { describe, expect, it } from 'vitest';
import {
  type GrantedDescriptor,
  type TransportDescriptor,
  INTERNAL_ACTIVE_DESCRIPTOR_FILE,
  INTERNAL_WEB_BUNDLE_DIRECTORY,
  INTERNAL_WEB_BUNDLE_DOCUMENT,
  MAX_INTERNAL_DESCRIPTOR_BYTES,
  decodeInternalDescriptor,
  encodeInternalDescriptor,
  isGrantedDescriptor,
  isInternalCapability,
  isLoopbackOrigin,
  loopbackOrigin,
  parseInternalDescriptor,
} from './descriptor';

const capability = (fill: string) => `${fill.repeat(42)}A`;
const transport: TransportDescriptor = {
  v: 1, channelId: 'chan_1', origin: 'http://127.0.0.1:4870', transportCapability: capability('t'),
};
const granted: GrantedDescriptor = {
  ...transport, grantRef: 'grant_1', bindingId: 'binding_1', bindingCapability: capability('b'),
};

function errorOf(input: unknown) {
  const result = decodeInternalDescriptor(input);
  return result.ok ? null : result.error;
}

describe('internal runtime descriptor', () => {
  it('publishes stable file and bundle names', () => {
    expect(INTERNAL_ACTIVE_DESCRIPTOR_FILE).toBe('active.json');
    expect(INTERNAL_WEB_BUNDLE_DIRECTORY).toBe('internal-web');
    expect(INTERNAL_WEB_BUNDLE_DOCUMENT).toBe('index.html');
  });

  it('decodes transport-only and granted states exactly', () => {
    expect(decodeInternalDescriptor(transport)).toEqual({ ok: true, value: transport });
    expect(decodeInternalDescriptor(granted)).toEqual({ ok: true, value: granted });
    const decoded = decodeInternalDescriptor(granted);
    expect(decoded.ok && isGrantedDescriptor(decoded.value)).toBe(true);
    const plain = decodeInternalDescriptor(transport);
    expect(plain.ok && isGrantedDescriptor(plain.value)).toBe(false);
  });

  it('round-trips canonical file text with fixed key order', () => {
    const text = encodeInternalDescriptor({ ...granted });
    expect(text).toBe(`${JSON.stringify(granted)}\n`);
    expect(parseInternalDescriptor(text)).toEqual({ ok: true, value: granted });
    expect(encodeInternalDescriptor(transport)).toBe(`${JSON.stringify(transport)}\n`);
  });

  it('rejects unknown, missing, and partially granted fields', () => {
    expect(errorOf({ ...transport, port: 4870 })).toEqual({ code: 'unknown_field', field: 'port' });
    expect(errorOf({ ...transport, token: capability('x') })).toEqual({ code: 'unknown_field', field: 'token' });
    const noOrigin: Record<string, unknown> = { ...transport };
    delete noOrigin.origin;
    expect(errorOf(noOrigin)).toEqual({ code: 'missing_field', field: 'origin' });
    expect(errorOf({ ...transport, bindingId: 'binding_1' })).toEqual({ code: 'missing_field', field: 'grantRef' });
    expect(errorOf({ ...transport, grantRef: 'g', bindingId: 'b' })).toEqual({ code: 'missing_field', field: 'bindingCapability' });
    expect(errorOf({ ...granted, bindingCapability: granted.transportCapability }))
      .toEqual({ code: 'invalid_value', field: 'bindingCapability' });
  });

  it('rejects non-objects and unsupported versions', () => {
    for (const input of [null, [], 'x', 1, new Date()]) expect(errorOf(input)?.code).toBe('not_object');
    expect(errorOf({ ...transport, v: 2 })).toEqual({ code: 'unsupported_version', field: 'v' });
    expect(errorOf({ ...transport, v: '1' })).toEqual({ code: 'unsupported_version', field: 'v' });
  });

  it('accepts only canonical IPv4 loopback origins', () => {
    for (const origin of ['http://127.0.0.1:1', 'http://127.0.0.1:4870', 'http://127.0.0.1:65535']) {
      expect(isLoopbackOrigin(origin)).toBe(true);
    }
    for (const origin of [
      'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:04870',
      'https://127.0.0.1:4870', 'http://localhost:4870', 'http://[::1]:4870', 'http://127.0.0.2:4870',
      'http://127.0.0.1:4870/', 'http://127.0.0.1:4870/path', 'http://127.0.0.1:4870?q', 'http://127.0.0.1:4870#h',
      'http://user:pass@127.0.0.1:4870', 'HTTP://127.0.0.1:4870', ' http://127.0.0.1:4870', 4870,
    ]) {
      expect(isLoopbackOrigin(origin)).toBe(false);
      expect(errorOf({ ...transport, origin })).toEqual({ code: 'invalid_value', field: 'origin' });
    }
    expect(loopbackOrigin(4871)).toBe('http://127.0.0.1:4871');
    expect(() => loopbackOrigin(0)).toThrow(RangeError);
    expect(() => loopbackOrigin(1.5)).toThrow(RangeError);
  });

  it('accepts only canonical 32-byte base64url capabilities', () => {
    expect(isInternalCapability(capability('a'))).toBe(true);
    expect(isInternalCapability(Buffer.alloc(32, 0xff).toString('base64url'))).toBe(true);
    for (const value of [
      capability('a').slice(1), `${capability('a')}A`, `${'a'.repeat(42)}B`, `${'a'.repeat(42)}=`,
      `${'a'.repeat(41)}+A`, `${'a'.repeat(41)}/A`, `${'a'.repeat(42)}A=`, '', null,
    ]) {
      expect(isInternalCapability(value)).toBe(false);
      expect(errorOf({ ...transport, transportCapability: value })).toEqual({ code: 'invalid_value', field: 'transportCapability' });
    }
  });

  it('bounds identifiers and rejects control or malformed characters', () => {
    for (const channelId of ['', 'a\nb', 'a\u0000b', 'a\u007fb', '\ud800', 'x'.repeat(513), 7]) {
      expect(errorOf({ ...transport, channelId })).toEqual({ code: 'invalid_value', field: 'channelId' });
    }
    expect(errorOf({ ...transport, channelId: 'x'.repeat(512) })).toBeNull();
    expect(errorOf({ ...granted, grantRef: '' })).toEqual({ code: 'invalid_value', field: 'grantRef' });
    expect(errorOf({ ...granted, bindingId: 'a\tb' })).toEqual({ code: 'invalid_value', field: 'bindingId' });
  });

  it('bounds and parses file text before decoding', () => {
    expect(parseInternalDescriptor('{')).toEqual({ ok: false, error: { code: 'malformed_json', field: '' } });
    expect(parseInternalDescriptor(' '.repeat(MAX_INTERNAL_DESCRIPTOR_BYTES + 1)))
      .toEqual({ ok: false, error: { code: 'too_large', field: '' } });
    expect(parseInternalDescriptor('[]')).toEqual({ ok: false, error: { code: 'not_object', field: '' } });
  });

  it('refuses to encode invalid state without echoing secrets', () => {
    const bad = { ...granted, bindingCapability: 'not-a-capability' };
    expect(() => encodeInternalDescriptor(bad)).toThrow(/invalid_value bindingCapability/);
    try { encodeInternalDescriptor(bad); } catch (error) {
      expect(String(error)).not.toContain(granted.transportCapability);
      expect(String(error)).not.toContain('not-a-capability');
    }
  });
});

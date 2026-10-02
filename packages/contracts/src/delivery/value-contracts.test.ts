import { describe, expect, expectTypeOf, it } from 'vitest';
import { decodeDeliveryLimits } from './decode';
import {
  type DeviceId, type OwnerId, decodeBindingId, decodeDeviceId, decodeOwnerId,
} from './ids';

describe('delivery limits', () => {
  it('requires both positive safe configured limits and supplies no defaults', () => {
    expect(decodeDeliveryLimits({ maxSelectionEvents: 2, maxPayloadBytes: 4096 }))
      .toEqual({ ok: true, value: { maxSelectionEvents: 2, maxPayloadBytes: 4096 } });
    expect(decodeDeliveryLimits({ maxSelectionEvents: 2 }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'maxPayloadBytes' });
    expect(decodeDeliveryLimits({ maxSelectionEvents: 0, maxPayloadBytes: 4096 }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'maxSelectionEvents' });
    expect(decodeDeliveryLimits({ maxSelectionEvents: 2, maxPayloadBytes: Number.MAX_SAFE_INTEGER + 1 }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'maxPayloadBytes' });
    expect(decodeDeliveryLimits({ maxSelectionEvents: 2, maxPayloadBytes: 4096, defaultBusy: 'queue' }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'defaultBusy' });
  });

  it('returns a safe failure for hostile object access instead of throwing', () => {
    const input = Object.defineProperty({ maxPayloadBytes: 4096 }, 'maxSelectionEvents', {
      enumerable: true,
      get: () => { throw new Error('untrusted plaintext'); },
    });
    expect(decodeDeliveryLimits(input))
      .toEqual({ ok: false, code: 'invalid_field', field: 'maxSelectionEvents' });
  });

  it('turns any other thrown error into a plaintext-free failure', () => {
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('untrusted plaintext'); } });
    expect(decodeDeliveryLimits(hostile)).toEqual({ ok: false, code: 'invalid_field', field: '' });
  });
});

describe('independent branded identifiers', () => {
  type MessagingOwnerIdMirror = string & { readonly __khala: 'OwnerId' };

  it('is structurally compatible with the independently declared messaging brand', () => {
    expectTypeOf<OwnerId>().toEqualTypeOf<MessagingOwnerIdMirror>();
    expectTypeOf<DeviceId>().not.toMatchTypeOf<OwnerId>();
    expectTypeOf<string>().not.toMatchTypeOf<OwnerId>();
    expectTypeOf<OwnerId>().toMatchTypeOf<string>();
  });

  it('brands identifiers without changing their bytes', () => {
    expect(decodeOwnerId('Owner Mixed Case')).toEqual({ ok: true, value: 'Owner Mixed Case' });
    expect(decodeDeviceId('dev-a')).toEqual({ ok: true, value: 'dev-a' });
  });

  it('enforces nonempty, control-free, well-formed identifiers', () => {
    expect(decodeOwnerId('')).toEqual({ ok: false, code: 'invalid_field', field: '' });
    expect(decodeOwnerId('owner\nadmin')).toEqual({ ok: false, code: 'invalid_field', field: '' });
    expect(decodeOwnerId(`owner${String.fromCharCode(0x85)}admin`))
      .toEqual({ ok: false, code: 'invalid_field', field: '' });
    expect(decodeOwnerId('broken-\ud800')).toEqual({ ok: false, code: 'invalid_field', field: '' });
  });

  it('caps identifiers at 512 UTF-8 bytes, including multibyte boundaries', () => {
    expect(decodeBindingId('a'.repeat(512)).ok).toBe(true);
    expect(decodeBindingId('\u00e9'.repeat(256)).ok).toBe(true);
    expect(decodeBindingId(`${'a'.repeat(511)}\u00e9`))
      .toEqual({ ok: false, code: 'limit_exceeded', field: '' });
  });

  it('counts three- and four-byte UTF-8 characters exactly', () => {
    // U+20AC is 3 bytes; U+1F44D is 4 bytes (a surrogate pair in UTF-16).
    expect(decodeBindingId(`${'\u20ac'.repeat(170)}aa`).ok).toBe(true);
    expect(decodeBindingId(`${'\u20ac'.repeat(170)}aaa`))
      .toEqual({ ok: false, code: 'limit_exceeded', field: '' });
    expect(decodeBindingId('\u{1f44d}'.repeat(128)).ok).toBe(true);
    expect(decodeBindingId(`${'\u{1f44d}'.repeat(128)}a`))
      .toEqual({ ok: false, code: 'limit_exceeded', field: '' });
  });
});

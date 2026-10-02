import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import exact from '../../fixtures/delivery/exact-release.json';
import invalid from '../../fixtures/delivery/invalid.json';
import views from '../../fixtures/delivery/views.json';
import type { Decoded } from './decode';
import * as delivery from './index';
import {
  decodeDeliveryReceipt, decodeDeliveryReceiptTransport, decodeDeliveryReceiptV1, decodeDeliveryReceiptV2,
} from './receipts';

const decoders: Record<string, (input: unknown) => Decoded<unknown>> = {
  receipt: decodeDeliveryReceipt,
  receiptV1: decodeDeliveryReceiptV1,
  receiptV2: decodeDeliveryReceiptV2,
  receiptTransport: decodeDeliveryReceiptTransport,
};

function mutate(base: unknown, set: Record<string, unknown> = {}, remove: readonly string[] = []): unknown {
  const copy = structuredClone(base) as Record<string, unknown>;
  for (const [path, value] of Object.entries(set)) {
    const keys = path.split('.');
    let target = copy;
    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
    target[keys.at(-1) as string] = structuredClone(value);
  }
  for (const key of remove) delete copy[key];
  return copy;
}

const lookup = (path: string): unknown =>
  path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], exact);

describe('exact receipt fixture', () => {
  it.each([['receipt', 'receipt']])('%s decodes %s and round-trips byte-stable JSON', (decoder, path) => {
    const input = lookup(path);
    const result = decoders[decoder]!(input);
    expect(result).toEqual({ ok: true, value: input });
    if (result.ok) expect(JSON.stringify(result.value)).toBe(JSON.stringify(input));
  });

  it('round-trips explicit receipt versions without promotion', () => {
    expect(decodeDeliveryReceiptV1(exact.receipt)).toEqual({ ok: true, value: exact.receipt });
    expect(decodeDeliveryReceiptV2(exact.receiptV2)).toEqual({ ok: true, value: exact.receiptV2 });
    for (const receipt of [exact.receipt, exact.receiptV2]) {
      const result = decodeDeliveryReceiptTransport(receipt);
      expect(result).toEqual({ ok: true, value: receipt });
      if (result.ok) expect(JSON.stringify(result.value)).toBe(JSON.stringify(receipt));
    }
    expect(decodeDeliveryReceiptV1(exact.receiptV2)).toEqual({ ok: false, code: 'invalid_version', field: 'v' });
    expect(decodeDeliveryReceiptV2(exact.receipt)).toEqual({ ok: false, code: 'invalid_version', field: 'v' });
    expect(decodeDeliveryReceiptTransport({ ...exact.receiptV2, v: 3 }))
      .toEqual({ ok: false, code: 'invalid_version', field: 'v' });
  });

});

describe('invalid fixtures', () => {
  it.each(invalid.cases)('$name', testCase => {
    const input = mutate(lookup(testCase.base), testCase.set, 'remove' in testCase ? testCase.remove : []);
    expect(decoders[testCase.decoder]!(input)).toEqual({ ok: false, ...testCase.error });
  });


  it('lists every retained receipt fixture', () => {
    const names = invalid.cases.map(testCase => testCase.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([
      'receipt free-text error',
      'failed receipt without an error',
    ]));
  });
});

describe('view fixtures', () => {
  it.each(views.valid)('accepts: $name', testCase => {
    const expected = 'expected' in testCase ? testCase.expected : testCase.input;
    expect(decoders[testCase.decoder]!(testCase.input)).toEqual({ ok: true, value: expected });
  });


  it('lists the ambiguous receipt outcome', () => {
    expect(views.valid.map(view => view.name)).toContain('disconnect after a possible submission is outcome_unknown');
  });
});

describe('public surface', () => {
  it('does not expose fixtures or test helpers', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { exports: Record<string, string> };
    expect(Object.entries(packageJson.exports).filter(([key, target]) => /fixture/i.test(key + target))).toEqual([]);
    expect(() => readFileSync(new URL('./fixtures.ts', import.meta.url))).toThrow();
    expect(Object.keys(delivery).filter(name => /fixture|fake/i.test(name))).toEqual([]);
    const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(indexSource).not.toMatch(/from '[^']*(fixtures|\.test)/);
  });

  it('imports nothing from the messaging domain', () => {
    for (const file of [
      'decode.ts', 'ids.ts', 'receipts.ts', 'listening-mode.ts',
    ]) {
      expect(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')).not.toMatch(/messaging/);
    }
  });
});

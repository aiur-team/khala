import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./thread.css', import.meta.url), 'utf8');

describe('thread.css', () => {
  // Operator request 2026-10-23: a clear gutter opposite each bubble, so left and right read apart on a phone.
  it('caps a message row at 78% with no wider mobile override', () => {
    const widths = [...css.matchAll(/\.kh-row\s*\{[^}]*max-width:\s*([\d.]+)%/gu)].map(match => Number(match[1]));
    expect(widths).toEqual([78]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { copyShareLink, resolveClipboardWriter } from './share-link';

describe('copyShareLink', () => {
  it('reports ok when the injected writer succeeds', async () => {
    const writer = vi.fn().mockResolvedValue(undefined);
    const result = await copyShareLink('https://khala.aiur.team/i/1', writer);
    expect(result).toEqual({ ok: true });
    expect(writer).toHaveBeenCalledWith('https://khala.aiur.team/i/1');
  });

  it('reports denied, never ok, when the writer throws', async () => {
    const writer = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    const result = await copyShareLink('https://khala.aiur.team/i/1', writer);
    expect(result).toEqual({ ok: false, reason: 'denied' });
  });

  it('reports unavailable, never ok, when no writer is given', async () => {
    const result = await copyShareLink('https://khala.aiur.team/i/1', null);
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('resolveClipboardWriter', () => {
  it('returns null when navigator.clipboard is absent', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    try {
      expect(resolveClipboardWriter()).toBeNull();
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
    }
  });
});

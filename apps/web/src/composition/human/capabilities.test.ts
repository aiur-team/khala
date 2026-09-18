import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { registerHumanCapabilities } from './capabilities';

describe('human capability registration', () => {
  it('registers the finite optional capability set as explicitly unavailable', () => {
    const capabilities = registerHumanCapabilities();

    expect(capabilities.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: 'review', state: 'unavailable' },
      { id: 'controls', state: 'unavailable' },
      { id: 'recovery', state: 'unavailable' },
    ]);
  });

  it('attaches unavailable capabilities without gaining write authority', () => {
    const context = Object.freeze({}) as never;

    for (const capability of registerHumanCapabilities()) {
      expect(Object.keys(capability).sort()).toEqual(['attach', 'id', 'state']);
      const handle = capability.attach(context);
      expect(Object.keys(handle)).toEqual(['dispose']);
      expect(() => handle.dispose()).not.toThrow();
      expect(() => handle.dispose()).not.toThrow();
    }
  });

  it('uses only reviewed literal registrations', async () => {
    const source = await readFile(new URL('./capabilities.ts', import.meta.url), 'utf8');

    expect(source).toContain("from '../review/register'");
    expect(source).toContain("from '../controls/register'");
    expect(source).toContain("from '../recovery/register'");
    expect(source).not.toMatch(/\bimport\s*\(/u);
    expect(source).not.toMatch(/fixtures?/iu);
    expect(source).not.toMatch(/(?:request|location|searchParams|URL)\b[^\n]*\bimport\b/iu);
  });
});

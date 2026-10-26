import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { selectFrame, utf8Length } from './index';

it('byte counts equal Buffer for all existing deliver goldens and Unicode edge cases', () => {
  const dir = new URL('../../agent/src/harness/__golden__/', import.meta.url);
  const names = readdirSync(dir).filter(name => name.startsWith('deliver-'));
  expect(names).toHaveLength(81);
  for (const body of [...names.map(name => readFileSync(new URL(name, dir), 'utf8')), 'café 👋', '\ud800', '\udc00', '']) {
    expect(utf8Length(body)).toBe(Buffer.byteLength(body));
  }
});
const render = (entries: readonly { body: string }[]) => '<frame>' + entries.map(entry => entry.body).join('\n') + '</frame>';
it('bounds frames to 50 messages and 64 KiB by default, preserving original consumed entries', () => {
  const entries = Array.from({ length: 51 }, () => ({ body: 'hi' }));
  expect(selectFrame(entries, render, '…')).toEqual({ frame: render(entries.slice(0, 50)), consumed: entries.slice(0, 50) });
  const huge = [{ body: 'x'.repeat(70_000) }];
  const selected = selectFrame(huge, render, '…');
  expect(Buffer.byteLength(selected.frame!)).toBe(65_536);
  expect(selected.frame).toBe('<frame>' + 'x'.repeat(65_518) + '…</frame>');
  expect(selected.consumed).toEqual(huge);
});
it('truncates on code points using product copy and never consumes an oversized later message', () => {
  const entries = [{ body: 'é👋é👋' }];
  expect(selectFrame(entries, render, '…', 24)).toEqual({ frame: '<frame>é👋…</frame>', consumed: entries });
  expect(selectFrame([{ body: 'hi' }, ...entries], render, '…', 24)).toEqual({ frame: '<frame>hi</frame>', consumed: [{ body: 'hi' }] });
  expect(selectFrame(entries, render, '…', 24, false)).toEqual({ frame: null, consumed: [] });
  expect(selectFrame([], render, '…')).toEqual({ frame: null, consumed: [] });
});
it('rejects metadata that cannot fit even after truncating the first body', () => {
  expect(() => selectFrame([{ body: 'a' }], render, '…', 1)).toThrow('frame_metadata_too_large');
});

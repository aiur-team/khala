import { expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isEmptyPrompt, type EmptyPrompt } from './prompt-guard';

const claude: EmptyPrompt = { pattern: /^❯[\u00a0 ]?(Try ".*")?$/, cursorColumn: 2 };
const codex: EmptyPrompt = { pattern: /^› ?(Ask Codex to do anything)?$/, cursorColumn: 2 };
it('accepts bare prompts and dim placeholders, preserving NBSP', () => {
  expect(isEmptyPrompt('❯\u00a0   \n', 2, claude)).toBe(true);
  expect(isEmptyPrompt('❯\u00a0\x1b[2mTry "fix lint errors"\x1b[0m   \n', 2, claude)).toBe(true);
  expect(isEmptyPrompt('\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m', 2, codex)).toBe(true);
});
it.each(['❯ draft text', '❯ abc', '❯ Try "fix lint errors"', '❯\x1b[2mTry "fix\x1b[22m lint errors"', '❯\x1b[2mTry "fix lint errors"\x1b[1G', '❯\t'])('rejects a draft or unsafe terminal control even with cursor at Home: %j', line => {
  expect(isEmptyPrompt(line, 2, claude)).toBe(false);
});
it('rejects single-space drafts and missing guards', () => {
  expect(isEmptyPrompt('❯ ', 3, claude)).toBe(false);
  expect(isEmptyPrompt('› ', 3, codex)).toBe(false);
  expect(isEmptyPrompt('❯', 2)).toBe(false);
  expect(isEmptyPrompt('› Ask Codex to do anything', 2, codex)).toBe(false);
});
it('does not interpret RGB colour component 2 as dim or 0 as intensity reset', () => {
  expect(isEmptyPrompt('❯ \x1b[38;2;2;0;22mTry "fix lint errors"', 2, claude)).toBe(false);
  expect(isEmptyPrompt('❯ \x1b[2;38;2;0;0;0mTry "fix lint errors"', 2, claude)).toBe(true);
});
it('does not depend on or mutate RegExp lastIndex', () => {
  const guard = { pattern: /^❯ ?$/g, cursorColumn: 2 };
  guard.pattern.lastIndex = 30;
  expect(isEmptyPrompt('❯', 2, guard)).toBe(true);
  expect(guard.pattern.lastIndex).toBe(30);
});
const fixtures = fileURLToPath(new URL('../../../../../docs/build/multi-harness/spikes/terminal-hosts/', import.meta.url));
for (const file of readdirSync(fixtures).filter(file => /^(claude|codex)-.*\.cursorline$/.test(file))) {
  it(`classifies spike cursor-line fixture ${file}`, () => {
    const capture = readFileSync(path.join(fixtures, file), 'utf8');
    const metadata = capture.split('\n')[0]!;
    const x = Number(metadata.match(/cursor_x=(\d+)/)![1]);
    const y = Number(metadata.match(/cursor_y=(\d+)/)![1]);
    const ansi = readFileSync(path.join(fixtures, file.replace('.cursorline', '.ansi.txt')), 'utf8').split('\n')[y]!;
    const empty = /-(empty|empty-rotated|after-turn)\.cursorline$/.test(file);
    expect(isEmptyPrompt(ansi, x, file.startsWith('claude') ? claude : codex)).toBe(empty);
  });
}

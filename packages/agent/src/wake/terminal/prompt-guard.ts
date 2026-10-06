export type EmptyPrompt = { pattern: RegExp; cursorColumn: number };

/** Only SGR styling is permitted; cursor moves and other terminal controls fail closed. */
function styledLine(line: string): { text: string; dim: boolean[] } | null {
  let text = '';
  const dim: boolean[] = [];
  let faint = false;
  for (let i = 0; i < line.length;) {
    if (line[i] === '\x1b') {
      const match = line.slice(i).match(/^\x1b\[([0-9;:]*)m/);
      if (!match) return null;
      const params = match[1] === '' ? [0] : match[1]!.split(';').map(Number);
      for (let j = 0; j < params.length; j++) {
        const code = params[j];
        // Colour payloads can contain 0, 2 and 22 without changing intensity.
        if (code === 38 || code === 48 || code === 58) {
          if (params[j + 1] === 5) j += 2;
          else if (params[j + 1] === 2) j += 4;
          else return null;
        } else if (code === 0 || code === 22) faint = false;
        else if (code === 2) faint = true;
        else if (!Number.isFinite(code)) return null;
      }
      i += match[0].length;
    } else {
      const character = line[i]!;
      if (/[\x00-\x1f\x7f-\x9f]/.test(character)) return null;
      text += character;
      dim.push(faint);
      i++;
    }
  }
  return { text, dim };
}

export function isEmptyPrompt(line: string, cursorX: number, guard?: EmptyPrompt): boolean {
  if (!guard || !Number.isSafeInteger(cursorX) || cursorX !== guard.cursorColumn) return false;
  const parsed = styledLine(line.replace(/\r?\n$/, ''));
  if (!parsed) return false;
  const text = parsed.text.replace(/ +$/, '');
  // Avoid mutating a caller's global/sticky regexp state between probes.
  const pattern = new RegExp(guard.pattern.source, guard.pattern.flags.replace(/[gy]/g, ''));
  if (!pattern.test(text)) return false;
  const placeholder = text.match(/^(?:❯[\u00a0 ]?)(Try ".*")$/) ?? text.match(/^› ?(Ask Codex to do anything)$/);
  if (placeholder) {
    const start = text.length - placeholder[1]!.length;
    return text.slice(start).split('').every((character, offset) => character === ' ' || parsed.dim[start + offset]);
  }
  return true;
}

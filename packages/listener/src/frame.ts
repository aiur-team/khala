export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_FRAME_MESSAGES = 50;
const encoder = new TextEncoder();
export const utf8Length = (value: string): number => encoder.encode(value).byteLength;

/** The caller owns all frame copy and metadata; only bounding is shared. */
export function selectFrame<T extends { body: string }>(entries: readonly T[], render: (entries: readonly T[]) => string,
  truncatedSuffix: string, budget = MAX_FRAME_BYTES, truncate = true) {
  const rendered: T[] = [];
  let consumedCount = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (rendered.length === MAX_FRAME_MESSAGES) break;
    if (utf8Length(render([...rendered, entry])) > budget) {
      if (rendered.length || !truncate) break;
      // Search code point boundaries so truncation cannot split a UTF-8 character.
      const body = Array.from(entry.body);
      let low = 0, high = body.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const candidate = { ...entry, body: body.slice(0, middle).join('') + truncatedSuffix };
        if (utf8Length(render([candidate])) <= budget) low = middle;
        else high = middle - 1;
      }
      const truncated = { ...entry, body: body.slice(0, low).join('') + truncatedSuffix };
      if (utf8Length(render([truncated])) > budget) throw new Error('frame_metadata_too_large');
      rendered.push(truncated);
      consumedCount = i + 1;
      break;
    }
    rendered.push(entry);
    consumedCount = i + 1;
  }
  return {
    frame: rendered.length ? render(rendered) : null,
    consumed: entries.slice(0, consumedCount),
  };
}

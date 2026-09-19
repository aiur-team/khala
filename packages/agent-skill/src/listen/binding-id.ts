const MAX_IDENTIFIER_BYTES = 512;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Validate the opaque binding identifier before it reaches the child process.
 * This intentionally mirrors the delivery contract without importing package
 * source into the standalone fallback executable.
 */
export function listenerBindingId(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  if (!isWellFormed(input) || CONTROL.test(input) || utf8Length(input) > MAX_IDENTIFIER_BYTES) return null;
  return input;
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x80) bytes += 1;
    else if (codePoint < 0x800) bytes += 2;
    else if (codePoint < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

// Image attachments shared by the web composer and the agent CLI. The type is
// sniffed from magic bytes (never trusted from a file name or MIME header), so
// SVG and anything else outside the allowlist is refused. Media is encrypted
// client-side as a Matrix `EncryptedFile` (v2, AES-256-CTR, SHA-256 of the
// ciphertext): the homeserver stores ciphertext only.

/** Raster formats every target browser renders natively. No SVG: it can carry script. */
export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION = 65_535;

/** What an image message carries besides its caption. `url` is the mxc URI of the ciphertext. */
export type ImageRef = Readonly<{
  name: string; mimetype: ImageMimeType; size: number; w: number; h: number;
  url: string; key: string; iv: string; sha256: string;
}>;

export type SniffedImage = Readonly<{ mimetype: ImageMimeType; w: number; h: number }>;

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const ascii = (b: Uint8Array, i: number, text: string) => [...text].every((c, k) => b[i + k] === c.charCodeAt(0));

function sniffType(b: Uint8Array): SniffedImage | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 'PNG\r\n\x1a\n') && ascii(b, 12, 'IHDR')) {
    return { mimetype: 'image/png', w: (u16be(b, 16) << 16 | u16be(b, 18)) >>> 0, h: (u16be(b, 20) << 16 | u16be(b, 22)) >>> 0 };
  }
  if (b.length >= 10 && (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))) return { mimetype: 'image/gif', w: u16le(b, 6), h: u16le(b, 8) };
  if (b.length >= 30 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) {
    if (ascii(b, 12, 'VP8 ')) return { mimetype: 'image/webp', w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
    if (ascii(b, 12, 'VP8L')) {
      return { mimetype: 'image/webp', w: 1 + (((b[22]! & 0x3f) << 8) | b[21]!), h: 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)) };
    }
    if (ascii(b, 12, 'VP8X')) return { mimetype: 'image/webp', w: 1 + u24le(b, 24), h: 1 + u24le(b, 27) };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) { i += 1; continue; }
      // SOF0-SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mimetype: 'image/jpeg', w: u16be(b, i + 7), h: u16be(b, i + 5) };
      }
      if (marker === 0xda || marker === 0xd9) return null;
      i += 2 + u16be(b, i + 2);
    }
  }
  return null;
}

/** The sniffed type and size, or null when the bytes are not an allowed raster image with sane dimensions. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const found = sniffType(bytes);
  return found && found.w >= 1 && found.h >= 1 && found.w <= MAX_DIMENSION && found.h <= MAX_DIMENSION ? found : null;
}

export type ImageCheck = Readonly<{ ok: true; image: SniffedImage }> | Readonly<{ ok: false; reason: 'unsupported_type' | 'too_large' | 'empty' }>;

/** The one gate both senders run before encrypting. */
export function checkImage(bytes: Uint8Array): ImageCheck {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > IMAGE_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const image = sniffImage(bytes);
  return image ? { ok: true, image } : { ok: false, reason: 'unsupported_type' };
}

/**
 * Drops JPEG APP1 (EXIF, XMP: camera, time, GPS), APP13 (IPTC) and comment
 * segments before the scan. Orientation lives in EXIF, so a rotated camera
 * photo may then show sideways; the web composer re-encodes instead.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  while (i + 3 < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1]!;
    if (marker === 0xda) break;
    const end = i + 2 + u16be(bytes, i + 2);
    if (end > bytes.length) return bytes;
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) parts.push(bytes.subarray(i, end));
    i = end;
  }
  parts.push(bytes.subarray(i));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function base64(bytes: Uint8Array, url = false): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const encoded = btoa(binary).replace(/=+$/u, '');
  return url ? encoded.replace(/\+/gu, '-').replace(/\//gu, '_') : encoded;
}

function unbase64(text: string): Uint8Array {
  const binary = atob(text.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(text.length / 4) * 4, '='));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

const sha256 = async (bytes: Uint8Array) => base64(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));

/** Encrypts for upload; the caller uploads `ciphertext` and keeps `key`, `iv` and `sha256` in the encrypted event. */
export async function encryptAttachment(plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; key: string; iv: string; sha256: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  // Matrix v2: a random 64-bit nonce, then a 64-bit counter that starts at zero.
  const iv = new Uint8Array(16);
  iv.set(crypto.getRandomValues(new Uint8Array(8)));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-CTR', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CTR', counter: iv, length: 64 }, key, new Uint8Array(plaintext)));
  return { ciphertext, key: base64(raw, true), iv: base64(iv), sha256: await sha256(ciphertext) };
}

/** Verifies the ciphertext hash, then decrypts. Throws on any mismatch. */
export async function decryptAttachment(ciphertext: Uint8Array, ref: Pick<ImageRef, 'key' | 'iv' | 'sha256'>): Promise<Uint8Array> {
  if (await sha256(ciphertext) !== ref.sha256) throw new Error('attachment_hash_mismatch');
  const key = await crypto.subtle.importKey('raw', new Uint8Array(unbase64(ref.key)), 'AES-CTR', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CTR', counter: new Uint8Array(unbase64(ref.iv)), length: 64 }, key, new Uint8Array(ciphertext)));
}

const MXC = /^mxc:\/\/[A-Za-z0-9.:[\]-]{1,255}\/[A-Za-z0-9_-]{1,255}$/u;
const NAME = /^[^\p{Cc}/\\]{1,255}$/u;

/** A validated image reference, or null. Content from the room is untrusted. */
export function readImageRef(value: unknown): ImageRef | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  if (keys !== 'h,iv,key,mimetype,name,sha256,size,url,w') return null;
  const int = (n: unknown, max: number) => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max;
  return typeof v.name === 'string' && NAME.test(v.name) && (IMAGE_MIME_TYPES as readonly unknown[]).includes(v.mimetype)
    && int(v.size, IMAGE_MAX_BYTES * 2) && int(v.w, MAX_DIMENSION) && int(v.h, MAX_DIMENSION)
    && typeof v.url === 'string' && MXC.test(v.url) && typeof v.key === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(v.key)
    && typeof v.iv === 'string' && /^[A-Za-z0-9+/]{22}(==)?$/u.test(v.iv) && typeof v.sha256 === 'string' && /^[A-Za-z0-9+/]{43}=?$/u.test(v.sha256)
    ? v as ImageRef : null;
}

/** Matrix `m.image` content. `body` is the caption, or the file name when there is none (Matrix v1.10 media captions). */
export function imageEventContent(ref: ImageRef, caption: string): Record<string, unknown> {
  return {
    msgtype: 'm.image', body: caption || ref.name, filename: ref.name,
    info: { mimetype: ref.mimetype, size: ref.size, w: ref.w, h: ref.h },
    file: { v: 'v2', url: ref.url, iv: ref.iv, hashes: { sha256: ref.sha256 },
      key: { kty: 'oct', key_ops: ['encrypt', 'decrypt'], alg: 'A256CTR', k: ref.key, ext: true } },
  };
}

/** Reads an encrypted `m.image`; unencrypted (`url`) or malformed images are not shown. */
export function readImageEvent(content: Record<string, unknown>): { image: ImageRef; caption: string } | null {
  if (content.msgtype !== 'm.image' || typeof content.body !== 'string') return null;
  const obj = (value: unknown) => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const file = obj(content.file), info = obj(content.info), key = obj(file.key), hashes = obj(file.hashes);
  if (file.v !== 'v2' || key.alg !== 'A256CTR' || key.kty !== 'oct') return null;
  const name = typeof content.filename === 'string' ? content.filename : content.body;
  const image = readImageRef({ name, mimetype: info.mimetype, size: info.size, w: info.w, h: info.h,
    url: file.url, key: key.k, iv: file.iv, sha256: hashes.sha256 });
  return image ? { image, caption: content.body === name ? '' : content.body } : null;
}

/** The agent-facing one-line stand-in, `[image: name, WxH]`. */
export function imageLabel(image: Pick<ImageRef, 'name' | 'w' | 'h'>): string {
  return `[image: ${image.name}, ${image.w}x${image.h}]`;
}

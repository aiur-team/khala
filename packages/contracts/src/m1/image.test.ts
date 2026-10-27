import { describe, expect, it } from 'vitest';
import { checkImage, decryptAttachment, encryptAttachment, IMAGE_MAX_BYTES, imageEventContent, imageLabel, readImageEvent, readImageRef,
  sniffImage, stripImageMetadata, type ImageRef } from './image';
import { decodeMessageContent, digestMessageContent } from '../messaging/events';
import { decodeContentLimits } from '../messaging/decode';

const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap(part => typeof part === 'string' ? [...part].map(c => c.charCodeAt(0)) : part));
const png = (w: number, h: number) => bytes([0x89], 'PNG\r\n\x1a\n', [0, 0, 0, 13], 'IHDR', [0, 0, w >> 8, w & 255, 0, 0, h >> 8, h & 255], [8, 6, 0, 0, 0]);
const app1 = bytes([0xff, 0xe1, 0, 12], 'Exif\0\0GPS!');
const jpeg = (w: number, h: number) => bytes([0xff, 0xd8], [0xff, 0xe0, 0, 6], 'JFIF', [...app1], [0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0],
  [0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);

describe('sniffImage', () => {
  it('reads each allowed format and its size from magic bytes', () => {
    expect(sniffImage(png(640, 480))).toEqual({ mimetype: 'image/png', w: 640, h: 480 });
    expect(sniffImage(jpeg(4032, 3024))).toEqual({ mimetype: 'image/jpeg', w: 4032, h: 3024 });
    expect(sniffImage(bytes('GIF89a', [10, 0, 20, 0, 0]))).toEqual({ mimetype: 'image/gif', w: 10, h: 20 });
    expect(sniffImage(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8X', [10, 0, 0, 0, 0, 0, 0, 0, 99, 0, 0, 49, 0, 0]))).toEqual({ mimetype: 'image/webp', w: 100, h: 50 });
  });

  it('refuses SVG, HTML and other files, whatever they are named', () => {
    expect(sniffImage(bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(bytes('<!doctype html><img src=x onerror=alert(1)>'))).toBeNull();
    expect(sniffImage(bytes('PK\x03\x04 zip'))).toBeNull();
    expect(sniffImage(png(0, 10))).toBeNull();
  });
});

describe('checkImage', () => {
  it('enforces the allowlist and the size cap', () => {
    expect(checkImage(png(2, 2))).toEqual({ ok: true, image: { mimetype: 'image/png', w: 2, h: 2 } });
    expect(checkImage(bytes('<svg/>'))).toEqual({ ok: false, reason: 'unsupported_type' });
    expect(checkImage(bytes([0, 0, 0, 24], 'ftypheic', [0, 0, 0, 0], 'mif1heic'))).toEqual({ ok: false, reason: 'heic' });
    expect(checkImage(new Uint8Array(0))).toEqual({ ok: false, reason: 'empty' });
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
    big.set(png(2, 2));
    expect(checkImage(big)).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('stripImageMetadata', () => {
  it('drops JPEG EXIF/GPS and keeps the frame and scan', () => {
    const stripped = stripImageMetadata(jpeg(8, 4), 'image/jpeg');
    expect(new TextDecoder().decode(stripped)).not.toContain('GPS');
    expect(stripped.length).toBe(jpeg(8, 4).length - app1.length);
    expect(sniffImage(stripped)).toEqual({ mimetype: 'image/jpeg', w: 8, h: 4 });
  });

  it('drops PNG eXIf and text chunks and keeps the image chunks', () => {
    const chunk = (type: string, data: string) => bytes([0, 0, 0, data.length], type, data, [1, 2, 3, 4]);
    const ihdr = bytes([0x89], 'PNG\r\n\x1a\n', [0, 0, 0, 13], 'IHDR', [0, 0, 0, 8, 0, 0, 0, 4, 8, 6, 0, 0, 0], [1, 2, 3, 4]);
    const keep = [ihdr, chunk('IDAT', 'pixels'), chunk('IEND', '')];
    const full = bytes(...[ihdr, chunk('eXIf', 'GPS!'), chunk('tEXt', 'Comment\0GPS'), chunk('iTXt', 'XML:com.adobe.xmp GPS'), keep[1]!, keep[2]!].map(part => [...part]));
    const stripped = stripImageMetadata(full, 'image/png');
    expect(stripped).toEqual(bytes(...keep.map(part => [...part])));
    expect(sniffImage(stripped)).toEqual({ mimetype: 'image/png', w: 8, h: 4 });
  });

  it('drops WebP EXIF and XMP chunks, clears their flags and fixes the RIFF size', () => {
    const chunk = (type: string, data: number[]) => [...bytes(type, [data.length, 0, 0, 0], data, data.length % 2 ? [0] : [])];
    const vp8x = chunk('VP8X', [0x0c, 0, 0, 0, 99, 0, 0, 49, 0, 0]);
    const image = chunk('VP8L', [1, 2, 3]);
    const webp = (...chunks: number[][]) => {
      const body = chunks.flat();
      return bytes('RIFF', [(body.length + 4) & 255, 0, 0, 0], 'WEBP', body);
    };
    const stripped = stripImageMetadata(webp(vp8x, chunk('EXIF', [...bytes('GPS!')]), image, chunk('XMP ', [...bytes('GPS')])), 'image/webp');
    expect(stripped).toEqual(webp([...vp8x.slice(0, 8), 0, ...vp8x.slice(9)], image));
    expect(sniffImage(stripped)).toEqual({ mimetype: 'image/webp', w: 100, h: 50 });
  });

  it('leaves GIF (no EXIF; animation kept) and truncated files alone', () => {
    const gif = bytes('GIF89a', [10, 0, 20, 0, 0]);
    expect(stripImageMetadata(gif, 'image/gif')).toBe(gif);
    expect(stripImageMetadata(png(1, 1), 'image/png')).toEqual(png(1, 1));
  });
});

describe('attachment encryption', () => {
  it('round-trips and never uploads plaintext', async () => {
    const plain = png(3, 3);
    const sealed = await encryptAttachment(plain);
    expect(sealed.ciphertext).not.toEqual(plain);
    expect(await decryptAttachment(sealed.ciphertext, sealed)).toEqual(plain);
  });

  it('refuses tampered ciphertext', async () => {
    const sealed = await encryptAttachment(png(3, 3));
    sealed.ciphertext[0]! ^= 1;
    await expect(decryptAttachment(sealed.ciphertext, sealed)).rejects.toThrow('attachment_hash_mismatch');
  });
});

describe('image events', () => {
  const ref = async (): Promise<ImageRef> => {
    const sealed = await encryptAttachment(png(4, 3));
    return { name: 'shot.png', mimetype: 'image/png', size: 40, w: 4, h: 3, url: 'mxc://matrix.example/AbC_1-2', key: sealed.key, iv: sealed.iv, sha256: sealed.sha256 };
  };

  it('round-trips m.image content with and without a caption', async () => {
    const image = await ref();
    expect(readImageEvent(imageEventContent(image, 'look'))).toEqual({ image, caption: 'look' });
    expect(readImageEvent(imageEventContent(image, ''))).toEqual({ image, caption: '' });
    expect(imageLabel(image)).toBe('[image: shot.png, 4x3]');
  });

  it('refuses unencrypted, SVG or path-like images', async () => {
    const image = await ref();
    expect(readImageEvent({ msgtype: 'm.image', body: 'x.png', url: 'mxc://a/b' })).toBeNull();
    expect(readImageRef({ ...image, mimetype: 'image/svg+xml' })).toBeNull();
    expect(readImageRef({ ...image, name: '../etc/passwd' })).toBeNull();
    expect(readImageRef({ ...image, url: 'https://evil.example/x' })).toBeNull();
  });

  it('decodes and digests content carrying an image', async () => {
    const limits = decodeContentLimits({ maxBodyBytes: 8000, maxDisplayNameBytes: 64, maxRoomTitleBytes: 64 });
    if (!limits.ok) throw new Error('limits');
    const image = await ref();
    const content = { v: 1, kind: 'text', body: 'look', image, inReplyTo: '$parent' };
    expect(decodeMessageContent(content, limits.value)).toEqual({ ok: true, value: content });
    expect(decodeMessageContent({ ...content, image: { ...image, url: 'x' } }, limits.value).ok).toBe(false);
    const digest = await digestMessageContent(content as never);
    expect(digest.ok).toBe(true);
    expect(await digestMessageContent({ ...content, image: { ...image, w: 5 } } as never)).not.toEqual(digest);
  });
});

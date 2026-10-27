import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MessageContent } from '@khala/contracts/messaging/index';
import { decodeContentLimits, type ParticipantView } from '@khala/contracts/messaging/index';
import type { MediaPort } from '../../ui/conversation/ports';
import { loadedImage, loadImage, prepareImage, saveImage, uploadImage } from './image-media';
import { renderMessageContent } from './message-renderer';
import { encodeMessageContent, projectWireEvent } from '../../composition/human/message-wire';

const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap(part => typeof part === 'string' ? [...part].map(c => c.charCodeAt(0)) : part));
const png = (w: number, h: number) => bytes([0x89], 'PNG\r\n\x1a\n', [0, 0, 0, 13], 'IHDR', [0, 0, w >> 8, w & 255, 0, 0, h >> 8, h & 255], [8, 6, 0, 0, 0]);
const jpeg = bytes([0xff, 0xd8], [0xff, 0xe1, 0, 8], 'Exif\0G', [0xff, 0xc0, 0, 11, 8, 0, 4, 0, 8, 3, 1, 0x22, 0], [0xff, 0xda, 0, 2, 0xff, 0xd9]);
const file = (data: Uint8Array, name: string) => new File([new Uint8Array(data)], name);

function memoryMedia(): MediaPort & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return { store, upload: async ciphertext => { const url = `mxc://matrix.example/m${store.size}`; store.set(url, ciphertext); return url; },
    download: async url => store.get(url)! };
}

describe('prepareImage', () => {
  it('accepts an allowed raster image and sniffs its size', async () => {
    expect(await prepareImage(file(png(30, 20), 'shot.png'))).toMatchObject({ mimetype: 'image/png', w: 30, h: 20, name: 'shot.png' });
  });

  it('refuses SVG even when it is named .png, and oversize files', async () => {
    expect(await prepareImage(file(bytes('<svg onload="alert(1)"/>'), 'cat.png'))).toEqual({ error: 'unsupported_type' });
    expect(await prepareImage({ size: 11 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Blob)).toEqual({ error: 'too_large' });
  });

  it('re-encodes JPEG, and strips its EXIF/GPS when the canvas is unavailable', async () => {
    const reencode = vi.fn(async () => jpeg);
    await prepareImage(file(jpeg, 'p.jpg'), reencode);
    expect(reencode).toHaveBeenCalledOnce();
    const stripped = await prepareImage(file(jpeg, 'p.jpg'), async () => { throw new Error('no canvas'); });
    expect('bytes' in stripped && new TextDecoder().decode(stripped.bytes)).not.toContain('Exif');
  });
});

describe('encrypted upload and display', () => {
  it('uploads only ciphertext and decrypts it back for display', async () => {
    const media = memoryMedia();
    const prepared = await prepareImage(file(png(4, 3), 'shot.png'));
    if ('error' in prepared) throw new Error(prepared.error);
    const image = await uploadImage(media, prepared);
    expect([...media.store.values()][0]).not.toEqual(png(4, 3));
    const blob = await loadImage(media, image);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png(4, 3));
    expect(blob.type).toBe('image/png');
    expect(loadedImage(image)).toBe(blob);
  });

  it('refuses decrypted bytes that are not the declared image type', async () => {
    const media = memoryMedia();
    const prepared = await prepareImage(file(png(4, 3), 'shot.png'));
    if ('error' in prepared) throw new Error(prepared.error);
    const image = await uploadImage(media, prepared);
    await expect(loadImage(media, { ...image, mimetype: 'image/gif' })).rejects.toThrow('not_an_image');
  });

  it('round-trips an image message through the Matrix wire, reply parent included', async () => {
    const media = memoryMedia();
    const prepared = await prepareImage(file(png(4, 3), 'shot.png'));
    if ('error' in prepared) throw new Error(prepared.error);
    const image = await uploadImage(media, prepared);
    const limits = decodeContentLimits({ maxBodyBytes: 8000, maxDisplayNameBytes: 64, maxRoomTitleBytes: 64 });
    if (!limits.ok) throw new Error('limits');
    const participant = { participantId: 'p', ownerId: 'o', kind: 'human', displayName: 'Maya', deviceIds: [] } as unknown as ParticipantView;
    for (const content of [{ v: 1, kind: 'text', body: 'shot.png', image }, { v: 1, kind: 'text', body: 'look', image, inReplyTo: '$parent' }] as MessageContent[]) {
      const wire = encodeMessageContent(content);
      expect(wire).toMatchObject({ msgtype: 'm.image', filename: 'shot.png' });
      expect(projectWireEvent({ type: 'm.room.message', content: wire, eventId: '$e' as never, participant, authorDeviceId: 'D' as never,
        clientTxnId: null, receivedAt: '1970-01-01T00:00:00.000Z' }, limits.value)).toMatchObject({ kind: 'message', content });
    }
    // An unencrypted image (plain `url`) is never shown.
    expect(projectWireEvent({ type: 'm.room.message', content: { msgtype: 'm.image', body: 'x.png', url: 'mxc://a/b' }, eventId: '$e' as never,
      participant, authorDeviceId: 'D' as never, clientTxnId: null, receivedAt: '1970-01-01T00:00:00.000Z' }, limits.value)).toBeNull();
  });
});

describe('rendering', () => {
  const image = { name: 'shot.png', mimetype: 'image/png' as const, size: 10, w: 800, h: 600, url: 'mxc://matrix.example/x',
    key: 'a'.repeat(43), iv: 'A'.repeat(22), sha256: 'B'.repeat(43) };

  it('shows a sized placeholder while loading, then the caption under it', () => {
    const html = renderToStaticMarkup(renderMessageContent({ v: 1, kind: 'text', body: 'look', image }, { loadImage: () => new Promise(() => {}) }));
    expect(html).toContain('class="kh-img kh-img--loading"');
    expect(html).toContain('width:240px;aspect-ratio:800 / 600');
    expect(html).toContain('look');
    expect(html).not.toContain('mxc://');
  });

  it('shows only the name without a media port, and no caption when the body is the file name', () => {
    const html = renderToStaticMarkup(renderMessageContent({ v: 1, kind: 'text', body: 'shot.png', image }));
    expect(html).toBe('<p class="message-content__text">[image: shot.png]</p>');
  });
});

describe('saveImage', () => {
  const blob = new Blob([png(1, 1)], { type: 'image/png' });

  it('opens the share sheet (iOS "Save Image") when files can be shared', () => {
    const share = vi.fn(async () => {});
    saveImage(blob, 'shot.png', { canShare: () => true, share }, {} as Document);
    const shared = (share.mock.calls[0] as unknown as [{ files: File[] }])[0].files[0]!;
    expect(shared.name).toBe('shot.png');
    expect(shared.type).toBe('image/png');
  });

  it('names the saved file by its verified type, never the sender extension', () => {
    const share = vi.fn(async () => {});
    saveImage(blob, 'invoice‮gnp.exe', { canShare: () => true, share }, {} as Document);
    expect((share.mock.calls[0] as unknown as [{ files: File[] }])[0].files[0]!.name).toBe('invoicegnp.png');
  });

  it('falls back to a download link elsewhere', () => {
    const link = { click: vi.fn(), href: '', download: '' };
    saveImage(blob, 'shot.png', { canShare: () => false, share: vi.fn() }, { createElement: () => link } as unknown as Document);
    expect(link.download).toBe('shot.png');
    expect(link.href).toMatch(/^blob:/u);
    expect(link.click).toHaveBeenCalledOnce();
  });
});

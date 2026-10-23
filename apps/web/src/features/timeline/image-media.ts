// Image attachments in the browser: prepare (validate, drop metadata), encrypt
// and upload, decrypt and cache for display, and save through the platform.
import { checkImage, decryptAttachment, encryptAttachment, IMAGE_MAX_BYTES, stripJpegMetadata, type ImageRef, type SniffedImage } from '@khala/contracts/m1/image';
import type { MediaPort } from '../channel/ports';

export type PreparedImage = Readonly<SniffedImage & { bytes: Uint8Array; name: string }>;
export type ImageError = 'unsupported_type' | 'too_large' | 'empty' | 'unreadable' | 'upload_failed';

export const IMAGE_ERROR_TEXT: Readonly<Record<ImageError, string>> = {
  unsupported_type: 'Only JPEG, PNG, GIF or WebP images can be sent.',
  too_large: 'Images can be up to 10 MB.',
  empty: 'That image is empty.',
  unreadable: "That image couldn't be read.",
  upload_failed: "The image couldn't be uploaded. Try again.",
};

/** Draws a JPEG onto a canvas: the browser applies its EXIF orientation, and the output carries no EXIF/GPS. */
async function reencodeJpeg(bytes: Uint8Array): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
  // iOS caps canvases near 16.7 MP; 4096 px on the long edge stays under it.
  const scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) throw new Error('reencode_failed');
  return new Uint8Array(await blob.arrayBuffer());
}

/** The bytes to send, or why the file can't be sent. Type is sniffed from the bytes, never the file name. */
export async function prepareImage(file: Blob & { name?: string }, reencode = reencodeJpeg): Promise<PreparedImage | { error: ImageError }> {
  if (file.size > IMAGE_MAX_BYTES) return { error: 'too_large' };
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { return { error: 'unreadable' }; }
  let checked = checkImage(bytes);
  if (!checked.ok) return { error: checked.reason };
  if (checked.image.mimetype === 'image/jpeg') {
    // Without a canvas, strip the metadata segments instead (orientation may then be lost).
    bytes = await reencode(bytes).catch(() => stripJpegMetadata(bytes));
    checked = checkImage(bytes);
    if (!checked.ok) return { error: checked.reason };
  }
  const name = (file.name || 'image').replace(/[\p{Cc}/\\]/gu, '_').slice(0, 255);
  return { ...checked.image, bytes, name };
}

export async function uploadImage(media: MediaPort, image: PreparedImage): Promise<ImageRef> {
  const sealed = await encryptAttachment(image.bytes);
  const url = await media.upload(sealed.ciphertext);
  return { name: image.name, mimetype: image.mimetype, size: image.bytes.length, w: image.w, h: image.h, url, key: sealed.key, iv: sealed.iv, sha256: sealed.sha256 };
}

// ponytail: decrypted images stay in memory for the page's life; add eviction if channels hold hundreds of images.
const loading = new Map<string, Promise<Blob>>();
const loaded = new Map<string, Blob>();

/** Downloads, verifies and decrypts once per mxc URL. A failure is forgotten so a later render retries. */
export function loadImage(media: MediaPort, image: ImageRef): Promise<Blob> {
  let pending = loading.get(image.url);
  if (!pending) {
    pending = media.download(image.url).then(ciphertext => decryptAttachment(ciphertext, image)).then(bytes => {
      const blob = new Blob([new Uint8Array(bytes)], { type: image.mimetype });
      loaded.set(image.url, blob);
      return blob;
    });
    pending.catch(() => loading.delete(image.url));
    loading.set(image.url, pending);
  }
  return pending;
}

/** Seeds the cache with an image this tab just sent, so its own echo never downloads it again. */
export function rememberImage(url: string, blob: Blob): void {
  loaded.set(url, blob);
  loading.set(url, Promise.resolve(blob));
}

/** The decrypted image if it is already in memory; Save must not await, or iOS drops the tap's user activation. */
export function loadedImage(url: string): Blob | undefined {
  return loaded.get(url);
}

/**
 * Hands the image to the platform. iOS Safari and Home Screen web apps get the
 * share sheet, whose "Save Image" writes to Photos; elsewhere it downloads.
 * Call it synchronously from the click.
 */
export function saveImage(blob: Blob, name: string, nav: Pick<Navigator, 'canShare' | 'share'> | undefined = globalThis.navigator,
  doc: Document = document): void {
  const file = new File([blob], name, { type: blob.type });
  if (nav?.canShare?.({ files: [file] })) {
    void nav.share({ files: [file] }).catch(() => undefined); // A dismissed sheet rejects with AbortError.
    return;
  }
  const link = doc.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

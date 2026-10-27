// Image attachments in the browser: prepare (validate, drop metadata), encrypt
// and upload, decrypt and cache for display, and save through the platform.
import { checkImage, decryptAttachment, encryptAttachment, IMAGE_MAX_BYTES, imageFileName, sniffImage, stripImageMetadata, type ImageRef, type SniffedImage } from '@khala/contracts/m1/image';
import type { MediaPort } from '../../ui/conversation/ports';

export type PreparedImage = Readonly<SniffedImage & { bytes: Uint8Array; name: string }>;
export type ImageError = 'unsupported_type' | 'heic' | 'too_large' | 'empty' | 'unreadable' | 'upload_failed';

export const IMAGE_ERROR_TEXT: Readonly<Record<ImageError, string>> = {
  unsupported_type: 'Only JPEG, PNG, GIF or WebP images can be sent.',
  heic: "HEIC images can't be sent. Save it as JPEG first.",
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
  const type = checked.image.mimetype;
  // JPEG goes through a canvas so its EXIF orientation is applied. Without one, and for PNG and WebP,
  // the metadata is cut out byte-wise, which keeps PNG/WebP lossless and animated. GIF has none.
  bytes = type === 'image/jpeg' ? await reencode(bytes).catch(() => stripImageMetadata(bytes, type)) : stripImageMetadata(bytes, type);
  checked = checkImage(bytes);
  if (!checked.ok) return { error: checked.reason };
  const name = (file.name || 'image').replace(/[\p{Cc}\p{Cf}/\\]/gu, '_').slice(0, 255);
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
// Keyed on the whole reference: another event may reuse a media URL with a different key.
const cacheKey = (image: ImageRef) => JSON.stringify([image.url, image.key, image.iv, image.sha256, image.mimetype]);

/**
 * Downloads, verifies and decrypts once per reference. The decrypted bytes must sniff as the
 * declared allowed type: a sender cannot pass off another file as an image. A failure is
 * forgotten so a later render retries.
 */
export function loadImage(media: MediaPort, image: ImageRef): Promise<Blob> {
  const key = cacheKey(image);
  let pending = loading.get(key);
  if (!pending) {
    pending = media.download(image.url).then(ciphertext => decryptAttachment(ciphertext, image)).then(bytes => {
      if (sniffImage(bytes)?.mimetype !== image.mimetype) throw new Error('not_an_image');
      const blob = new Blob([new Uint8Array(bytes)], { type: image.mimetype });
      loaded.set(key, blob);
      return blob;
    });
    pending.catch(() => loading.delete(key));
    loading.set(key, pending);
  }
  return pending;
}

/** Seeds the cache with an image this tab just sent, so its own echo never downloads it again. */
export function rememberImage(image: ImageRef, blob: Blob): void {
  loaded.set(cacheKey(image), blob);
  loading.set(cacheKey(image), Promise.resolve(blob));
}

/** The decrypted image if it is already in memory; Save must not await, or iOS drops the tap's user activation. */
export function loadedImage(image: ImageRef): Blob | undefined {
  return loaded.get(cacheKey(image));
}

/**
 * Hands the image to the platform. iOS Safari and Home Screen web apps get the
 * share sheet, whose "Save Image" writes to Photos; elsewhere it downloads.
 * Call it synchronously from the click.
 */
export function saveImage(blob: Blob, name: string, nav: Pick<Navigator, 'canShare' | 'share'> | undefined = globalThis.navigator,
  doc: Document = document): void {
  // The extension follows the verified type; the sender's name is only a stem.
  const file = new File([blob], imageFileName(name, blob.type as ImageRef['mimetype']), { type: blob.type });
  if (nav?.canShare?.({ files: [file] })) {
    void nav.share({ files: [file] }).catch(() => undefined); // A dismissed sheet rejects with AbortError.
    return;
  }
  const link = doc.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

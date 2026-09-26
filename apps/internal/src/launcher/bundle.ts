import fs from 'node:fs';
import path from 'node:path';
import { INTERNAL_WEB_BUNDLE_DOCUMENT } from '@khala/contracts/internal/descriptor';
import type { AssetContentType, AssetManifest } from '../server/assets';

// Builds the server's fixed asset manifest from the built internal web bundle.
// Only regular files with a known content type become routes; the server then
// re-validates and reads each one without following links.

const CONTENT_TYPES: Readonly<Record<string, AssetContentType>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const MAX_FILES = 512;
const SEGMENT = /^[A-Za-z0-9._~-]+$/;

export class WebBundleError extends Error {
  constructor() {
    super('internal web bundle: unavailable');
    this.name = 'WebBundleError';
  }
}

/** Returns the manifest for `directory`, or throws `WebBundleError` when it is not a usable bundle. */
export function webBundleManifest(directory: string): AssetManifest {
  let root: string;
  try {
    root = fs.realpathSync.native(directory);
    if (root !== directory || !fs.lstatSync(root).isDirectory()) throw new Error();
  } catch {
    throw new WebBundleError();
  }
  const entries: Array<AssetManifest['entries'][number]> = [];
  const walk = (relative: readonly string[]): void => {
    for (const entry of fs.readdirSync(path.join(root, ...relative), { withFileTypes: true })) {
      if (!SEGMENT.test(entry.name) || entry.name.startsWith('.')) continue;
      const segments = [...relative, entry.name];
      if (entry.isDirectory()) walk(segments);
      else if (entry.isFile()) {
        const contentType = CONTENT_TYPES[path.extname(entry.name).toLowerCase()];
        if (!contentType) continue;
        if (entries.length >= MAX_FILES) throw new WebBundleError();
        entries.push({ route: `/${segments.join('/')}`, file: segments.join('/'), contentType });
      }
    }
  };
  try {
    walk([]);
  } catch {
    throw new WebBundleError();
  }
  const document = entries.find(entry => entry.route === `/${INTERNAL_WEB_BUNDLE_DOCUMENT}`);
  if (!document) throw new WebBundleError();
  entries.push({ route: '/', file: document.file, contentType: document.contentType });
  return { root, entries, channelDocument: '/' };
}

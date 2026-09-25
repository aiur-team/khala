import fs from 'node:fs';
import path from 'node:path';

// Static serving is manifest-only: every file is validated, read into immutable
// memory before listening, and selected by exact route key. No request path is
// ever joined onto the filesystem.

export const ASSET_CONTENT_TYPES = [
  'text/html; charset=utf-8',
  'text/css; charset=utf-8',
  'text/javascript; charset=utf-8',
  'application/json; charset=utf-8',
  'application/manifest+json; charset=utf-8',
  'image/svg+xml',
  'image/png',
  'image/webp',
  'image/x-icon',
  'font/woff2',
] as const;

export type AssetContentType = (typeof ASSET_CONTENT_TYPES)[number];

export type AssetManifest = Readonly<{
  /** Absolute, symlink-free bundle directory. */
  root: string;
  entries: readonly Readonly<{ route: string; file: string; contentType: AssetContentType }>[];
  /** HTML route served for `/channels/:channelId` application routes. */
  channelDocument?: string;
}>;

export type Asset = Readonly<{ contentType: AssetContentType; body: Buffer }>;

export type AssetTable = Readonly<{
  get(route: string): Asset | null;
  channelDocument: Asset | null;
  routes: readonly string[];
}>;

export type AssetLimits = Readonly<{ maxAssetBytes: number; maxTotalBytes: number; maxEntries: number }>;

export const DEFAULT_ASSET_LIMITS: AssetLimits = {
  maxAssetBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxEntries: 512,
};

export type AssetErrorCode =
  | 'invalid_root' | 'invalid_route' | 'reserved_route' | 'duplicate_route' | 'invalid_file'
  | 'unsafe_file' | 'too_large' | 'invalid_content_type' | 'too_many_entries' | 'missing_document';

export class AssetManifestError extends Error {
  readonly code: AssetErrorCode;
  constructor(code: AssetErrorCode) {
    // Paths stay out of the message so a startup failure cannot leak them into logs.
    super(`asset manifest: ${code}`);
    this.name = 'AssetManifestError';
    this.code = code;
  }
}

const ROUTE_PATTERN = /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/;
const FILE_SEGMENT = /^[A-Za-z0-9._~-]+$/;
export const RESERVED_ROUTE_PREFIXES = ['/api/', '/__khala/', '/channels/'] as const;

function validRoute(route: string): boolean {
  return ROUTE_PATTERN.test(route) && route.split('/').every(segment => segment !== '.' && segment !== '..');
}

function fileSegments(file: string): string[] | null {
  const segments = file.split('/');
  return segments.every(segment => FILE_SEGMENT.test(segment) && segment !== '.' && segment !== '..') ? segments : null;
}

function readNoFollow(root: string, segments: readonly string[], maxBytes: number): Buffer {
  // Every intermediate directory must be a real directory, never a link.
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch { throw new AssetManifestError('invalid_file'); }
    if (stat.isSymbolicLink()) throw new AssetManifestError('unsafe_file');
    if (!stat.isDirectory()) throw new AssetManifestError('invalid_file');
  }
  const filename = path.join(current, segments.at(-1)!);
  let fd: number;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    throw new AssetManifestError((error as NodeJS.ErrnoException).code === 'ELOOP' ? 'unsafe_file' : 'invalid_file');
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new AssetManifestError('invalid_file');
    // A hard link can alias a file outside the bundle on the same filesystem.
    if (stat.nlink !== 1) throw new AssetManifestError('unsafe_file');
    if (stat.size > maxBytes) throw new AssetManifestError('too_large');
    const body = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < body.byteLength) {
      const read = fs.readSync(fd, body, offset, body.byteLength - offset, offset);
      if (read === 0) throw new AssetManifestError('invalid_file');
      offset += read;
    }
    return body;
  } finally {
    fs.closeSync(fd);
  }
}

export function loadAssets(manifest: AssetManifest, limits: AssetLimits = DEFAULT_ASSET_LIMITS): AssetTable {
  const root = manifest.root;
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\\') || path.normalize(root) !== root) {
    throw new AssetManifestError('invalid_root');
  }
  try {
    // The resolved root must equal the declared root, so no ancestor is a link.
    if (!fs.lstatSync(root).isDirectory() || fs.realpathSync.native(root) !== root) throw new Error();
  } catch {
    throw new AssetManifestError('invalid_root');
  }
  if (manifest.entries.length > limits.maxEntries) throw new AssetManifestError('too_many_entries');

  const table = new Map<string, Asset>();
  let total = 0;
  for (const entry of manifest.entries) {
    if (typeof entry.route !== 'string' || !validRoute(entry.route)) throw new AssetManifestError('invalid_route');
    if (entry.route === '/api' || entry.route === '/__khala' || entry.route === '/channels'
      || RESERVED_ROUTE_PREFIXES.some(prefix => entry.route.startsWith(prefix))) {
      throw new AssetManifestError('reserved_route');
    }
    if (table.has(entry.route)) throw new AssetManifestError('duplicate_route');
    if (!(ASSET_CONTENT_TYPES as readonly string[]).includes(entry.contentType)) throw new AssetManifestError('invalid_content_type');
    const segments = typeof entry.file === 'string' ? fileSegments(entry.file) : null;
    if (!segments) throw new AssetManifestError('invalid_file');
    const body = readNoFollow(root, segments, limits.maxAssetBytes);
    total += body.byteLength;
    if (total > limits.maxTotalBytes) throw new AssetManifestError('too_large');
    table.set(entry.route, { contentType: entry.contentType, body });
  }

  let channelDocument: Asset | null = null;
  if (manifest.channelDocument !== undefined) {
    channelDocument = table.get(manifest.channelDocument) ?? null;
    if (!channelDocument || channelDocument.contentType !== 'text/html; charset=utf-8') {
      throw new AssetManifestError('missing_document');
    }
  }
  return {
    get: route => table.get(route) ?? null,
    channelDocument,
    routes: [...table.keys()],
  };
}

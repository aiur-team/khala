// Canaries and the leak scanner for the security boundary suite (KHA-138).
//
// A canary is a fresh cryptographically random marker seeded into one message.
// The scanner looks for its random core in every form this suite knows how to
// recognise: raw UTF-8 and UTF-16LE, hex, and base64/base64url at every byte
// alignment, so a payload that was base64-encoded inside a larger buffer is still
// found. Absence supports only the paths and encodings tested here; it is not a
// proof against arbitrary encodings, compression or encryption by endpoint code.
//
// Reports name the canary's label and the encoding, never the canary text, so a
// failure message or evidence line cannot itself carry the secret.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type Canary = Readonly<{
  /** Stable, content-free name used in reports: `pending`, `approved`, ... */
  label: string;
  /** The whole marker to put in a message body. */
  text: string;
  /** The random part the scanner searches for. */
  core: string;
}>;

/** A fresh canary. Two canaries never share a core. */
export function mintCanary(label: string): Canary {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(label)) throw new Error('canary label must be a short identifier');
  const core = randomBytes(16).toString('hex');
  return { label, text: `khala-canary-${label}-${core}`, core };
}

export type LeakForm = Readonly<{ encoding: string; needle: Buffer }>;

/** Stable substrings of base64(prefix + core) for every prefix length mod 3. */
function base64Forms(core: Buffer, url: boolean): Buffer[] {
  const forms: Buffer[] = [];
  for (let shift = 0; shift < 3; shift += 1) {
    const encoded = Buffer.concat([Buffer.alloc(shift), core]).toString(url ? 'base64url' : 'base64').replace(/=+$/, '');
    // Keep only characters whose six bits all come from the core; the others depend on neighbours.
    const start = Math.ceil((shift * 4) / 3);
    const end = Math.floor(((shift + core.length) * 4) / 3);
    forms.push(Buffer.from(encoded.slice(start, end), 'latin1'));
  }
  return forms;
}

/** Every form of the canary core the scanner recognises. */
export function leakForms(canary: Canary): readonly LeakForm[] {
  const core = Buffer.from(canary.core, 'utf8');
  return [
    { encoding: 'utf8', needle: core },
    { encoding: 'utf16le', needle: Buffer.from(canary.core, 'utf16le') },
    { encoding: 'hex', needle: Buffer.from(core.toString('hex'), 'latin1') },
    { encoding: 'hex-upper', needle: Buffer.from(core.toString('hex').toUpperCase(), 'latin1') },
    ...base64Forms(core, false).map(needle => ({ encoding: 'base64', needle })),
    ...base64Forms(core, true).map(needle => ({ encoding: 'base64url', needle })),
  ];
}

export type Leak = Readonly<{ canary: string; encoding: string; where: string }>;

function asBuffer(haystack: string | Uint8Array): Buffer {
  return typeof haystack === 'string' ? Buffer.from(haystack, 'utf8') : Buffer.from(haystack);
}

/** Leaks of `canaries` in one haystack. `where` names the surface, never the content. */
export function findLeaks(haystack: string | Uint8Array, canaries: readonly Canary[], where: string): Leak[] {
  const bytes = asBuffer(haystack);
  const leaks: Leak[] = [];
  for (const canary of canaries) {
    const hit = leakForms(canary).find(form => bytes.includes(form.needle));
    if (hit) leaks.push({ canary: canary.label, encoding: hit.encoding, where });
  }
  return leaks;
}

/** Every regular file under `root`, including SQLite databases, WAL and journal files. */
export function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

/** Leaks in every file under `root`; `where` is the path relative to `root`. */
export function scanTree(root: string, canaries: readonly Canary[]): Leak[] {
  return listFiles(root).flatMap(file => findLeaks(fs.readFileSync(file), canaries, path.relative(root, file)));
}

/** A human-readable, content-free summary for assertion messages. */
export function describeLeaks(leaks: readonly Leak[]): string {
  return leaks.map(leak => `${leak.canary} as ${leak.encoding} in ${leak.where}`).join('; ');
}

/**
 * Records what a surface returned, for later scanning. Each capture is a named
 * haystack; the suite scans all of them for pending canaries and checks the
 * positive control against the ones that must carry approved content.
 */
export interface SurfaceCapture {
  add(where: string, output: string | Uint8Array): void;
  leaks(canaries: readonly Canary[]): Leak[];
  /** Surfaces whose output carried `canary`. */
  carrying(canary: Canary): string[];
  surfaces(): string[];
}

export function createSurfaceCapture(): SurfaceCapture {
  const captured: { where: string; bytes: Buffer }[] = [];
  return {
    add(where, output) {
      captured.push({ where, bytes: asBuffer(output) });
    },
    leaks: canaries => captured.flatMap(({ where, bytes }) => findLeaks(bytes, canaries, where)),
    carrying: canary => [...new Set(captured.filter(({ bytes }) => findLeaks(bytes, [canary], '').length > 0).map(c => c.where))],
    surfaces: () => [...new Set(captured.map(c => c.where))],
  };
}

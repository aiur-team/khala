// Exact-restore editing of a harness config file that Khala shares with the user.
//
// Before Khala's first change to a file, the exact original bytes (or the fact that the
// file did not exist) are recorded in Khala's state directory, keyed by the file's path.
// A reinstall never re-records, so Khala's own output is never mistaken for the original.
// Uninstall removes Khala's keys; when what is left means the same as the recording, the
// recorded bytes are written back (or the file is deleted, with any directories Khala
// created for it), otherwise only Khala's keys and the empty containers Khala created go.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

/** How a config file is read, written and compared. */
export type ManagedFormat = {
  /** Throws on content Khala cannot edit safely. */
  parse(text: string): unknown;
  /** Serializes `value` in the style of `like` (the current file text, null when absent). */
  serialize(value: unknown, like: string | null): string;
  equal(a: unknown, b: unknown): boolean;
  /** True when a file holding `value` is no different from no file at all. */
  empty(value: unknown): boolean;
  /** Removes empty containers in `value` that are absent from `original`; JSON only. */
  prune?(value: unknown, original: unknown): unknown;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const BOM = '﻿';

/** Formats JSON like `like`: its indentation (two spaces for a one-line file), line endings, BOM and final newline. */
export function formatJson(value: unknown, like: string | null): string {
  const body = like?.startsWith(BOM) ? like.slice(1) : like;
  const indent = body?.match(/^([ \t]+)\S/mu)?.[1] ?? 2;
  const newline = body?.includes('\r\n') ? '\r\n' : '\n';
  const trailing = body === null || body === undefined || /\n$/u.test(body) || body.trim() === '' ? newline : '';
  return (like?.startsWith(BOM) ? BOM : '') + JSON.stringify(value, null, indent).replaceAll('\n', newline) + trailing;
}

/**
 * Drops objects and arrays in `value` that are empty and have no counterpart in `original`,
 * innermost first, so a container Khala created only to hold its own keys does not outlive
 * them. Containers the user had, even empty ones, are kept.
 */
export function pruneCreated(value: unknown, original: unknown): unknown {
  if (!isObject(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const before = isObject(original) && Object.hasOwn(original, key) ? original[key] : undefined;
    const pruned = pruneCreated(child, before);
    const emptyContainer = Array.isArray(pruned) ? pruned.length === 0 : isObject(pruned) && Object.keys(pruned).length === 0;
    if (emptyContainer && before === undefined) continue;
    next[key] = pruned;
  }
  return next;
}

export const jsonFormat: ManagedFormat = {
  parse: text => (text.trim() ? JSON.parse(text.replace(/^﻿/u, '')) : {}),
  serialize: formatJson,
  equal: isDeepStrictEqual,
  empty: value => isObject(value) && Object.keys(value).length === 0,
  prune: pruneCreated,
};

/** Line-edited text (Codex `config.toml`): equal when the non-blank lines match, ignoring trailing spaces. */
const meaningfulLines = (text: unknown) => String(text).split(/\r?\n/u).map(line => line.trimEnd()).filter(Boolean);
export const textFormat: ManagedFormat = {
  parse: text => text,
  serialize: value => String(value),
  equal: (a, b) => isDeepStrictEqual(meaningfulLines(a), meaningfulLines(b)),
  empty: value => meaningfulLines(value).length === 0,
};

export type ManagedRead = { file: string; text: string | null };

/** Reads a config file as text, or null when it does not exist. */
export async function readManaged(file: string): Promise<ManagedRead> {
  try { return { file, text: await fs.readFile(file, 'utf8') }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file, text: null }; throw error; }
}

type Recording = { existed: boolean; bytes?: string; createdDirs: string[] };
type Recordings = Record<string, Recording>;
const LEGACY_BACKUP = '.khala-bak';

/** The recordings of every file Khala manages, one JSON file in Khala's state directory. */
export class ManagedFiles {
  readonly store: string;
  constructor(stateDir: string) { this.store = path.join(stateDir, 'install-originals.json'); }

  private async load(): Promise<Recordings> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.store, 'utf8'));
      return isObject(value) ? value as Recordings : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async save(recordings: Recordings): Promise<void> {
    if (!Object.keys(recordings).length) { await fs.rm(this.store, { force: true }); return; }
    await fs.mkdir(path.dirname(this.store), { recursive: true, mode: 0o700 });
    const temp = `${this.store}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(recordings, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, this.store);
  }

  /** The recorded original: `undefined` when nothing is recorded, `null` when the file did not exist. */
  async original(file: string): Promise<Buffer | null | undefined> {
    const recording = (await this.load())[path.resolve(file)];
    if (recording) return recording.existed ? Buffer.from(recording.bytes ?? '', 'base64') : null;
    const legacy = await readBytes(file + LEGACY_BACKUP);
    return legacy ?? undefined;
  }

  /**
   * Records the original once, before Khala's first change. An earlier installer's
   * `.khala-bak` is adopted as the original (the file itself then holds Khala's output)
   * and removed. A harness-specific legacy absence sentinel can pass `original: null`;
   * the override still never replaces a previously saved recording.
   */
  async record(file: string, options?: { original: Buffer | null }): Promise<void> {
    const key = path.resolve(file);
    const recordings = await this.load();
    if (recordings[key]) return;
    const legacy = await readBytes(file + LEGACY_BACKUP);
    const current = options ? options.original : legacy ?? await readBytes(file);
    recordings[key] = current === null
      ? { existed: false, createdDirs: await missingDirs(path.dirname(key)) }
      : { existed: true, bytes: current.toString('base64'), createdDirs: [] };
    await this.save(recordings);
    if (legacy) await fs.rm(file + LEGACY_BACKUP, { force: true });
  }

  /**
   * Install: records every file's original first (so each knows which directories Khala
   * creates), then writes each `text` that differs from the current content.
   */
  async write(entries: ReadonlyArray<{ current: ManagedRead; text: string; mode?: number }>): Promise<void> {
    for (const { current } of entries) await this.record(current.file);
    for (const { current, text, mode } of entries) {
      if (text === current.text) continue;
      await fs.mkdir(path.dirname(current.file), { recursive: true });
      await fs.writeFile(current.file, text, mode === undefined ? undefined : { mode });
    }
  }

  /**
   * Uninstall. `strip` receives the parsed current content and the parsed recorded original
   * (`undefined` when the file did not exist or nothing is recorded) and returns the content
   * without Khala's keys. Writes back the recorded bytes when the result is equal to them,
   * deletes the file when it did not exist and nothing is left, and otherwise writes the
   * stripped content. The recording is then dropped.
   */
  async restore(current: ManagedRead, format: ManagedFormat, strip: (value: unknown, original: unknown) => unknown): Promise<void> {
    const key = path.resolve(current.file);
    const recordings = await this.load();
    const recording = recordings[key];
    const original = await this.original(current.file);
    if (current.text !== null) {
      let originalValue: unknown;
      let comparable = original !== undefined;
      if (original) {
        try { originalValue = format.parse(original.toString('utf8')); } catch { comparable = false; }
      }
      let value = strip(format.parse(current.text), originalValue);
      if (comparable && format.prune) value = format.prune(value, originalValue);
      if (comparable && original === null && format.empty(value)) {
        await fs.rm(current.file, { force: true });
        // Only empty directories go: rmdir fails while anything else is still inside.
        for (const dir of recording?.createdDirs ?? []) await fs.rmdir(dir).catch(() => undefined);
      } else if (comparable && original && format.equal(value, originalValue)) {
        if (!original.equals(Buffer.from(current.text, 'utf8'))) await fs.writeFile(current.file, original);
      } else {
        const text = format.serialize(value, current.text);
        if (text !== current.text) await fs.writeFile(current.file, text);
      }
    }
    if (recording) { delete recordings[key]; await this.save(recordings); }
    await fs.rm(current.file + LEGACY_BACKUP, { force: true });
  }
}

async function readBytes(file: string): Promise<Buffer | null> {
  try { return await fs.readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** The ancestors of `dir` (itself included) that do not exist yet, deepest first. */
async function missingDirs(dir: string): Promise<string[]> {
  const missing: string[] = [];
  for (let at = dir; ; at = path.dirname(at)) {
    try { await fs.stat(at); return missing; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    missing.push(at);
    if (path.dirname(at) === at) return missing;
  }
}

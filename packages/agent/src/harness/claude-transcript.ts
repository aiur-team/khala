import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';

const MAX_TAIL_BYTES = 64 * 1024;
const MARKERS = new Set(['[Request interrupted by user]', '[Request interrupted by user for tool use]']);

/** Complete, nonblank lines from the transcript's bounded tail; empty on any failure. */
async function tailLines(transcriptPath: string | undefined): Promise<string[]> {
  if (!transcriptPath) return [];
  let handle: fs.FileHandle | undefined;
  try {
    // Nonblocking open prevents a supplied FIFO from hanging hook delivery.
    handle = await fs.open(transcriptPath, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) return [];
    const length = Math.min(stat.size, MAX_TAIL_BYTES);
    const start = stat.size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    if (bytesRead !== length) return [];
    let tail = buffer.toString('utf8');
    if (start > 0) {
      const newline = tail.indexOf('\n');
      if (newline < 0) return [];
      tail = tail.slice(newline + 1);
    }
    return tail.split('\n').filter(line => line.trim() !== '');
  } catch { return []; }
  finally { await handle?.close().catch(() => {}); }
}

/** Only the latest complete transcript entry can establish an interrupt boundary. */
export async function claudeTranscriptInterrupted(transcriptPath: string | undefined, activityAt: string): Promise<boolean> {
  const lines = await tailLines(transcriptPath);
  if (!lines.length) return false;
  try {
    const entry = JSON.parse(lines.at(-1)!);
    if (entry?.type !== 'user' || entry.message?.role !== 'user'
      || typeof entry.timestamp !== 'string' || !(Date.parse(entry.timestamp) > Date.parse(activityAt))) return false;
    const content = entry.message.content;
    if (typeof content === 'string') return MARKERS.has(content);
    return Array.isArray(content) && content.length === 1 && content[0]?.type === 'text'
      && typeof content[0].text === 'string' && MARKERS.has(content[0].text);
  } catch { return false; }
}

/** The running Claude Code version, from the newest transcript entry that records one. */
export async function claudeTranscriptVersion(transcriptPath: string | undefined): Promise<string | undefined> {
  for (const line of (await tailLines(transcriptPath)).reverse()) {
    try {
      const version = JSON.parse(line)?.version;
      if (typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version)) return version;
    } catch { /* A partial or foreign line carries no version. */ }
  }
  return undefined;
}

/** Numeric dotted-version comparison; unknown is never at or above a floor. */
export function versionAtLeast(version: string | undefined, floor: string): boolean {
  if (version === undefined) return false;
  const a = version.split('.').map(Number), b = floor.split('.').map(Number);
  for (let i = 0; i < b.length; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i]!;
  return true;
}

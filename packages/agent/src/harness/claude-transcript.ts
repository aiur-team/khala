import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';

const MAX_TAIL_BYTES = 64 * 1024;
const MARKERS = new Set(['[Request interrupted by user]', '[Request interrupted by user for tool use]']);

/** Only the latest complete transcript entry can establish an interrupt boundary. */
export async function claudeTranscriptInterrupted(transcriptPath: string | undefined, activityAt: string): Promise<boolean> {
  if (!transcriptPath) return false;
  let handle: fs.FileHandle | undefined;
  try {
    // Nonblocking open prevents a supplied FIFO from hanging hook delivery.
    handle = await fs.open(transcriptPath, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) return false;
    const length = Math.min(stat.size, MAX_TAIL_BYTES);
    const start = stat.size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    if (bytesRead !== length) return false;
    let tail = buffer.toString('utf8');
    if (start > 0) {
      const newline = tail.indexOf('\n');
      if (newline < 0) return false;
      tail = tail.slice(newline + 1);
    }
    const lines = tail.split('\n').filter(line => line.trim() !== '');
    if (!lines.length) return false;
    const entry = JSON.parse(lines.at(-1)!);
    if (entry?.type !== 'user' || entry.message?.role !== 'user'
      || typeof entry.timestamp !== 'string' || !(Date.parse(entry.timestamp) > Date.parse(activityAt))) return false;
    const content = entry.message.content;
    if (typeof content === 'string') return MARKERS.has(content);
    return Array.isArray(content) && content.length === 1 && content[0]?.type === 'text'
      && typeof content[0].text === 'string' && MARKERS.has(content[0].text);
  } catch { return false; }
  finally { await handle?.close().catch(() => {}); }
}

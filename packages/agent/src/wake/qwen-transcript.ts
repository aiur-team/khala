import * as fs from 'node:fs/promises';
import { confirmWakeText } from './shared/nonce';

/** Qwen-authored notification provenance, never assistant or tool output. */
export async function qwenNotification(filePath: string): Promise<string | undefined> {
  const file = await fs.open(filePath, 'r');
  let text: string;
  try {
    const stat = await file.stat();
    const start = Math.max(0, stat.size - 1024 * 1024);
    const buffer = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start) text = text.slice(text.indexOf('\n') + 1);
  } finally { await file.close(); }
  const notifications: string[] = [];
  for (const line of text.trimEnd().split('\n').reverse()) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'user' || entry.provenance !== 'system' || entry.subtype !== 'notification'
      || entry.deliveredTurn !== true || entry.message?.role !== 'user' || !Array.isArray(entry.message.parts)) continue;
    notifications.push(entry.message.parts.filter((part: { text?: unknown }) => typeof part?.text === 'string')
      .map((part: { text: string }) => part.text).join('\n'));
  }
  return notifications.length ? notifications.join('\n') : undefined;
}
export async function verifyQwenTranscript(dir: string, filePath: string, now: number): Promise<string | undefined> {
  const text = await qwenNotification(filePath);
  if (text !== undefined) await confirmWakeText(dir, 'socket', text, now);
  return text;
}

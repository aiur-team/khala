import { wakeLine } from '@khala/agent/wake-shared';

/** Validate CLI output, preserving its channel wrapper verbatim. */
export function wakeParts(stdout: string) {
  const match = /^Khala: channel messages are waiting\. Continue\. \(k-([a-f0-9]{8})\)(?:\n|$)/.exec(stdout);
  if (!match) return [];
  const parts: { type: 'text'; text: string; synthetic?: boolean }[] = [{ type: 'text', text: wakeLine(match[1]!) }];
  const frame = stdout.slice(match[0].length);
  if (frame) parts.push({ type: 'text', text: frame, synthetic: true });
  return parts;
}

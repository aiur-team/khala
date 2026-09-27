// The read-only imported transcript as the external channel shows it. It comes from a
// verified archive, never from the live timeline, and it is display provenance only:
// the original author labels and times are what the internal channel recorded, not
// events anyone sent in this channel.

import type { ImportedHistoryRecord } from '@khala/contracts/messaging/imported-history';

/** A verified archive, as the messaging projection returns it. */
export type ImportedTranscript = Readonly<{
  archiveId: string;
  /** UTC RFC 3339: when the owner imported it. */
  importedAt: string;
  records: readonly ImportedHistoryRecord[];
}>;

/** One piece of a body: plain text, or a fenced code block with its optional language label. */
export type BodySegment = Readonly<{ kind: 'text'; text: string }> | Readonly<{ kind: 'code'; text: string; language: string | null }>;

const FENCE = /^```([^\n`]*)\n([\s\S]*?)\n?```$/gm;

/** Splits a body into text and fenced code. Nothing in a body is ever interpreted beyond that. */
export function segmentsOf(body: string): readonly BodySegment[] {
  const segments: BodySegment[] = [];
  let last = 0;
  for (const match of body.matchAll(FENCE)) {
    const before = body.slice(last, match.index);
    if (before.trim()) segments.push({ kind: 'text', text: before.replace(/\n$/, '') });
    const language = match[1]!.trim();
    segments.push({ kind: 'code', text: match[2]!, language: language === '' ? null : language });
    last = match.index + match[0].length;
  }
  const rest = body.slice(last);
  if (rest.trim() || segments.length === 0) segments.push({ kind: 'text', text: rest.replace(/^\n/, '') });
  return segments;
}

export function formatImportedTime(iso: string, locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC';
}

export type ImportedHistoryRead =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'ok'; transcript: ImportedTranscript }>
  /** The archive exists but did not verify; nothing from it is shown. */
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'unavailable' }>;

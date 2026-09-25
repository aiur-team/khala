import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type ArchiveSnapshot, readArchiveSnapshot } from '../store/lifecycle-snapshot';
import { isNormalAbsolute } from './paths';
import { type LifecycleOpenFailureCode, isOpenFailure, lifecycleFailure, openOwnedChannel } from './resume';

export const JSONL_EXPORT_FORMAT_V1 = 'khala.internal.export.jsonl.v1';
export const MARKDOWN_EXPORT_FORMAT_V1 = 'khala.internal.export.markdown.v1';

export type ExportFormat = 'markdown' | 'jsonl';
export type ExportOverwrite = 'refuse' | 'replace';

export type ExportFailureCode =
  | LifecycleOpenFailureCode
  | 'destination_exists'
  | 'destination_unsafe'
  | 'write_failed';

export type ExportResultV1 =
  | Readonly<{ kind: 'exported'; v: 1; format: ExportFormat; destination: string; bytes: number }>
  | Readonly<{ kind: 'failed'; code: ExportFailureCode }>;

/** Test-only deterministic interruption points in the publication sequence. */
export type ExportFaultStage = 'partial_write' | 'after_sync' | 'before_publish';
export type ExportFault = (stage: ExportFaultStage) => void;

// JSONL is the versioned integration seam. Every record is built property by
// property, never by serializing a database row.

export function renderJsonl(snapshot: ArchiveSnapshot): string {
  const { metadata } = snapshot;
  const records: unknown[] = [
    { record: 'export', v: 1, format: JSONL_EXPORT_FORMAT_V1 },
    {
      record: 'channel',
      v: 1,
      channelId: metadata.channelId,
      title: metadata.title,
      createdAt: metadata.createdAt,
      creatorParticipantId: metadata.creatorParticipantId,
      creatorDeviceId: metadata.creatorDeviceId,
      revision: metadata.revision,
      eventCount: metadata.eventCount,
    },
    ...snapshot.participants.map(participant => ({
      record: 'participant',
      v: 1,
      participantId: participant.participantId,
      kind: participant.kind,
      displayName: participant.displayName,
      membership: participant.membership,
      deviceIds: [...participant.deviceIds],
    })),
    ...snapshot.events.map(event => ({
      record: 'message',
      v: 1,
      sequence: event.sequence,
      eventId: event.eventId,
      authorParticipantId: event.authorParticipantId,
      authorDeviceId: event.authorDeviceId,
      receivedAt: event.receivedAt,
      content: { v: 1, kind: 'text', body: event.body },
    })),
  ];
  return records.map(record => `${JSON.stringify(record)}\n`).join('');
}

// Markdown is presentation output. Authored values only ever appear inside
// JSON-escaped inline code spans or a literal fenced block, so no title, name or
// body can introduce document structure.

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

function inlineLiteral(value: string | number | null): string {
  const json = JSON.stringify(value);
  const ticks = '`'.repeat(longestBacktickRun(json) + 1);
  return `${ticks} ${json} ${ticks}`;
}

/** Fence strictly longer than any backtick run in the body. */
export function literalFence(body: string): string {
  return '`'.repeat(Math.max(3, longestBacktickRun(body) + 1));
}

export function renderMarkdown(snapshot: ArchiveSnapshot): string {
  const { metadata } = snapshot;
  const names = new Map(snapshot.participants.map(participant => [participant.participantId, participant.displayName]));
  const lines: string[] = [
    '# Khala internal channel export',
    '',
    `- Format: ${inlineLiteral(MARKDOWN_EXPORT_FORMAT_V1)}`,
    `- Channel ID: ${inlineLiteral(metadata.channelId)}`,
    `- Title: ${inlineLiteral(metadata.title)}`,
    `- Created at: ${inlineLiteral(metadata.createdAt)}`,
    `- Revision: ${inlineLiteral(metadata.revision)}`,
    `- Messages: ${inlineLiteral(metadata.eventCount)}`,
    '',
    '## Participants',
    '',
  ];
  for (const participant of snapshot.participants) {
    lines.push(
      `- Participant ${inlineLiteral(participant.participantId)}`
        + `, name ${inlineLiteral(participant.displayName)}`
        + `, kind ${inlineLiteral(participant.kind)}`
        + `, membership ${inlineLiteral(participant.membership)}`
        + `, devices ${inlineLiteral(JSON.stringify(participant.deviceIds))}`,
    );
  }
  if (snapshot.participants.length === 0) lines.push('No participants.');
  lines.push('', '## Messages', '');
  if (snapshot.events.length === 0) lines.push('No messages.', '');
  for (const event of snapshot.events) {
    const fence = literalFence(event.body);
    lines.push(
      `### Message ${event.sequence}`,
      '',
      `- Event ID: ${inlineLiteral(event.eventId)}`,
      `- Author: ${inlineLiteral(event.authorParticipantId)} (${inlineLiteral(names.get(event.authorParticipantId) ?? null)})`,
      `- Device: ${inlineLiteral(event.authorDeviceId)}`,
      `- Received at: ${inlineLiteral(event.receivedAt)}`,
      '',
      `${fence}text`,
      event.body,
      fence,
      '',
    );
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function writeRange(descriptor: number, bytes: Buffer, start: number, end: number): void {
  for (let offset = start; offset < end;) offset += fs.writeSync(descriptor, bytes, offset, end - offset);
}

function writeAll(descriptor: number, bytes: Buffer, fault: ExportFault | undefined): void {
  const half = Math.floor(bytes.length / 2);
  writeRange(descriptor, bytes, 0, half);
  fault?.('partial_write');
  writeRange(descriptor, bytes, half, bytes.length);
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

type PublishFailure = Readonly<{ kind: 'failed'; code: 'destination_exists' | 'destination_unsafe' | 'write_failed' }>;

function destinationState(destination: string): 'absent' | 'file' | 'unsafe' {
  try {
    return fs.lstatSync(destination).isFile() ? 'file' : 'unsafe';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unsafe';
  }
}

function checkDestination(destination: string, overwrite: ExportOverwrite): PublishFailure | null {
  if (!isNormalAbsolute(destination) || destination === path.dirname(destination)) {
    return lifecycleFailure('destination_unsafe');
  }
  try {
    if (!fs.lstatSync(path.dirname(destination)).isDirectory()) return lifecycleFailure('destination_unsafe');
  } catch {
    return lifecycleFailure('destination_unsafe');
  }
  const state = destinationState(destination);
  if (state === 'unsafe') return lifecycleFailure('destination_unsafe');
  if (state === 'file' && overwrite === 'refuse') return lifecycleFailure('destination_exists');
  return null;
}

/**
 * Publishes a synced `0600` sibling temporary. Refusal publishes by hard link so
 * a destination that appears mid-export is never clobbered; replacement renames
 * atomically. Every failure removes the temporary and leaves the prior
 * destination, or no destination, in place.
 */
function publish(
  destination: string,
  contents: string,
  overwrite: ExportOverwrite,
  fault: ExportFault | undefined,
): PublishFailure | null {
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.${path.basename(destination)}.${randomBytes(8).toString('hex')}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    writeAll(descriptor, Buffer.from(contents, 'utf8'), fault);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fault?.('after_sync');
    fault?.('before_publish');
    if (overwrite === 'refuse') {
      try {
        fs.linkSync(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return lifecycleFailure('destination_exists');
        throw error;
      }
    } else {
      if (destinationState(destination) === 'unsafe') return lifecycleFailure('destination_unsafe');
      fs.renameSync(temporary, destination);
    }
    // The complete file is already visible; a directory-sync failure must not
    // report a published export as failed.
    try { syncDirectory(directory); } catch {}
    return null;
  } catch {
    return lifecycleFailure('write_failed');
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    // After a successful link or rename only the sibling name, if any, remains.
    try { fs.unlinkSync(temporary); } catch {}
  }
}

/**
 * Exports one offline channel. A running store is refused; the archive is read
 * in one owned snapshot and ownership is released before any output I/O.
 */
export function exportInternalChannel(input: Readonly<{
  root: string;
  channelId: string;
  format: ExportFormat;
  destination: string;
  overwrite: ExportOverwrite;
  fault?: ExportFault;
}>): ExportResultV1 {
  if (input.format !== 'markdown' && input.format !== 'jsonl') return lifecycleFailure('invalid_request');
  if (input.overwrite !== 'refuse' && input.overwrite !== 'replace') return lifecycleFailure('invalid_request');
  const precheck = checkDestination(input.destination, input.overwrite);
  if (precheck) return precheck;

  const owned = openOwnedChannel(input.root, input.channelId);
  if (isOpenFailure(owned)) return owned;
  let snapshot: ArchiveSnapshot;
  try {
    const result = readArchiveSnapshot(owned.handle, input.channelId);
    if (result.kind !== 'found') return lifecycleFailure(result.kind);
    snapshot = result.value;
  } catch {
    return lifecycleFailure('unavailable');
  } finally {
    owned.handle.close();
  }

  const contents = input.format === 'jsonl' ? renderJsonl(snapshot) : renderMarkdown(snapshot);
  const failure = publish(input.destination, contents, input.overwrite, input.fault);
  if (failure) return failure;
  return {
    kind: 'exported',
    v: 1,
    format: input.format,
    destination: input.destination,
    bytes: Buffer.byteLength(contents, 'utf8'),
  };
}

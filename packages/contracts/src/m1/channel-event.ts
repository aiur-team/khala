import { type Decoded, decodeWith, displayText, fail, label, literal, safeInteger, utcTimestamp, utf8Length, version } from '../messaging/decode';

export const CHANNEL_EVENT_TYPE = 'com.khala.event.v1' as const;
export const CHANNEL_EVENT_STATUSES = ['info', 'pending', 'success', 'failure', 'attention'] as const;
export type ChannelEventStatus = (typeof CHANNEL_EVENT_STATUSES)[number];
export const MAX_CHANNEL_EVENT_BYTES = 4096;
export type ChannelEventSubject = Readonly<{ ticket?: string; pr?: number; branch?: string; repo?: string; sha?: string }>;
export type ChannelEventSource = Readonly<{ system: string; topic?: string; event_id?: string }>;
export type ChannelEventInput = Readonly<{
  kind: string; summary: string; status?: ChannelEventStatus; subject?: ChannelEventSubject;
  actor?: string; url?: string; occurred_at?: string; source?: ChannelEventSource; key?: string;
}>;
export type ChannelEventContent = ChannelEventInput & Readonly<{ v: 1; body: string }>;

function record(input: unknown, path: string) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(path, 'not_object');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'not_object');
  const value = input as Record<string, unknown>;
  return {
    has: (key: string) => Object.hasOwn(value, key) && value[key] !== undefined,
    field: (key: string) => Object.hasOwn(value, key) ? value[key] : fail(path ? `${path}.${key}` : key, 'missing_field'),
    at: (key: string) => path ? `${path}.${key}` : key,
  };
}

function nonempty(value: string, path: string): string {
  if (!value.length) fail(path, 'empty');
  return value;
}
function display(input: unknown, path: string, maxBytes: number, maxPoints: number): string {
  const value = nonempty(displayText(input, path, maxBytes), path);
  if ([...value].length > maxPoints) fail(path, 'too_long');
  return value;
}
function matching(value: string, path: string, pattern: RegExp): string {
  if (!pattern.test(value)) fail(path, 'invalid_value');
  return value;
}

/** Converts unexpected object access/serialization failures into a located decode error. */
function safely<T>(read: () => Decoded<T>): Decoded<T> {
  try { return read(); } catch { return { ok: false, error: { path: '', code: 'invalid_value' } }; }
}

export function decodeChannelEvent(raw: unknown): Decoded<ChannelEventContent> {
  return safely(() => decodeWith(() => {
    let serialized: string | undefined;
    try { serialized = JSON.stringify(raw); } catch { fail('', 'invalid_value'); }
    if (serialized !== undefined && utf8Length(serialized) > MAX_CHANNEL_EVENT_BYTES) fail('', 'too_long');
    const r = record(raw, '');
    const v = version(r.field('v'), 'v');
    const kind = matching(nonempty(label(r.field('kind'), 'kind', 128), 'kind'), 'kind', /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/);
    const summary = display(r.field('summary'), 'summary', 800, 200);
    if (!summary.trim()) fail('summary', 'empty');
    const body = label(r.field('body'), 'body', 1024);
    return {
      v, kind, summary, body,
      ...(r.has('status') ? { status: literal(r.field('status'), 'status', CHANNEL_EVENT_STATUSES) } : {}),
      ...(r.has('subject') ? { subject: readSubject(r.field('subject')) } : {}),
      ...(r.has('actor') ? { actor: display(r.field('actor'), 'actor', 256, 64) } : {}),
      ...(r.has('url') ? { url: readUrl(r.field('url')) } : {}),
      ...(r.has('occurred_at') ? { occurred_at: utcTimestamp(r.field('occurred_at'), 'occurred_at') } : {}),
      ...(r.has('source') ? { source: readSource(r.field('source')) } : {}),
      ...(r.has('key') ? { key: nonempty(label(r.field('key'), 'key', 200), 'key') } : {}),
    };
  }));
}

function readSubject(input: unknown): ChannelEventSubject {
  const r = record(input, 'subject');
  let pr: number | undefined;
  if (r.has('pr')) {
    pr = safeInteger(r.field('pr'), r.at('pr'));
    if (pr === 0) fail(r.at('pr'), 'invalid_value');
  }
  let branch: string | undefined;
  if (r.has('branch')) {
    branch = nonempty(label(r.field('branch'), r.at('branch'), 255), r.at('branch'));
    if (branch.startsWith('refs/')) fail(r.at('branch'), 'invalid_value');
  }
  return {
    ...(r.has('ticket') ? { ticket: display(r.field('ticket'), r.at('ticket'), 256, 64) } : {}),
    ...(pr !== undefined ? { pr } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(r.has('repo') ? { repo: matching(label(r.field('repo'), r.at('repo'), 140), r.at('repo'), /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) } : {}),
    ...(r.has('sha') ? { sha: matching(label(r.field('sha'), r.at('sha'), 64), r.at('sha'), /^[0-9a-f]{7,64}$/) } : {}),
  };
}
function readSource(input: unknown): ChannelEventSource {
  const r = record(input, 'source');
  return {
    system: nonempty(label(r.field('system'), r.at('system'), 32), r.at('system')),
    ...(r.has('topic') ? { topic: label(r.field('topic'), r.at('topic'), 256) } : {}),
    ...(r.has('event_id') ? { event_id: label(r.field('event_id'), r.at('event_id'), 64) } : {}),
  };
}
function readUrl(input: unknown): string {
  if (typeof input !== 'string') fail('url', 'wrong_type');
  if (utf8Length(input) > 2048) fail('url', 'too_long');
  try { if (new URL(input).protocol !== 'https:') fail('url', 'invalid_value'); }
  catch { fail('url', 'invalid_value'); }
  return input;
}

export function formatChannelEventLine(content: Pick<ChannelEventInput, 'summary' | 'subject'>): string {
  const { summary, subject } = content;
  const head = subject?.ticket ? `${subject.ticket} ${summary}` : summary;
  const tail = subject?.branch ?? (subject?.pr !== undefined ? `PR #${subject.pr}` : undefined);
  return tail ? `${head} · ${tail}` : head;
}
export function encodeChannelEvent(input: unknown): Decoded<ChannelEventContent> {
  return safely(() => {
    const checked = decodeWith(() => { record(input, ''); return { ...(input as Record<string, unknown>), v: 1, body: '' }; });
    if (!checked.ok) return checked;
    const decoded = decodeChannelEvent(checked.value);
    if (!decoded.ok) return decoded;
    return decodeChannelEvent({ ...decoded.value, body: formatChannelEventLine(decoded.value) });
  });
}
export function statusFor(content: Pick<ChannelEventInput, 'kind' | 'status'>): ChannelEventStatus {
  if (content.status !== undefined) return content.status;
  switch (content.kind) {
    case 'ci.passed': case 'pr.merged': case 'agent.unblocked': return 'success';
    case 'ci.failed': return 'failure';
    case 'pr.ready_for_review': case 'pr.parked_ready': return 'pending';
    case 'agent.paused': case 'agent.blocked': case 'agent.pause.request': return 'attention';
    default: return content.kind.startsWith('agent.attention.') && !content.kind.endsWith('.resolved') ? 'attention' : 'info';
  }
}
export function dedupeByKey<T>(items: readonly T[], keyOf: (item: T) => string | undefined): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = keyOf(item);
    if (key === undefined) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

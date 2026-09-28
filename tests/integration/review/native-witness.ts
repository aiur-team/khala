// Test-only witness for one already-running Codex Sol TUI. The browser and
// connector create the release; this reader never seeds a binding or inbox.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

export type NativeReviewConfig = Readonly<{
  pid: number; startTicks: string; executable: string; workdir: string; cgroup: string;
  codexHome: string; xdgStateHome: string; xdgDataHome: string; rolloutFile: string;
}>;
export type NativeReviewBaseline = Readonly<{ offset: number; sessionId: string; startTicks: string;
  rolloutDevice: number; rolloutInode: number }>;
type Row = Readonly<{ type?: unknown; payload?: unknown }>;
type ObjectRow = Record<string, unknown>;
const object = (value: unknown): value is ObjectRow => typeof value === 'object' && value !== null && !Array.isArray(value);
const absolute = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value)
  && path.normalize(value) === value && !value.includes('\0');
const fail = (code: string): never => { throw new Error(`native_review_${code}`); };
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The descriptor is metadata only, but private rollout paths remain owner-scoped. */
export function readReviewNativeConfig(): NativeReviewConfig {
  const filename = process.env.KHALA_E2E_DISPOSABLE_ENV;
  if (!absolute(filename)) fail('descriptor_path_required');
  let raw: unknown;
  try {
    const info = lstatSync(filename);
    if (!privateFile(info, 64 * 1024)) fail('descriptor_unsafe');
    raw = JSON.parse(readFileSync(filename, 'utf8')) as unknown;
  } catch { return fail('descriptor_unavailable'); }
  if (!object(raw) || !object(raw.reviewNative)) fail('descriptor_review_native_missing');
  const native = raw.reviewNative;
  if (!Number.isSafeInteger(native.pid) || typeof native.startTicks !== 'string'
    || ![native.executable, native.workdir, native.cgroup, native.codexHome,
      native.xdgStateHome, native.xdgDataHome, native.rolloutFile].every(value => typeof value === 'string')) {
    fail('descriptor_review_native_invalid');
  }
  return { pid: native.pid as number, startTicks: native.startTicks as string,
    executable: native.executable as string, workdir: native.workdir as string,
    cgroup: native.cgroup as string, codexHome: native.codexHome as string,
    xdgStateHome: native.xdgStateHome as string, xdgDataHome: native.xdgDataHome as string,
    rolloutFile: native.rolloutFile as string };
}

function privateFile(file: Awaited<ReturnType<typeof lstat>>, maximum: number): boolean {
  return file.isFile() && !file.isSymbolicLink() && file.uid === process.getuid?.()
    && (file.mode & 0o077) === 0 && file.size <= maximum;
}

function rows(raw: string): ObjectRow[] {
  const complete = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1);
  return complete.split('\n').filter(Boolean).map(line => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!object(parsed)) fail('jsonl_record_invalid');
      return parsed;
    } catch { return fail('jsonl_record_invalid'); }
  });
}

/** Pins process, current model and private rollout to the protected binding's session. */
export async function nativeReviewBaseline(config: NativeReviewConfig, sessionId: string): Promise<NativeReviewBaseline> {
  if (!Number.isSafeInteger(config.pid) || config.pid < 2 || !/^[1-9][0-9]*$/u.test(config.startTicks)
    || path.basename(config.executable) !== 'codex'
    || ![config.executable, config.workdir, config.codexHome, config.xdgStateHome,
      config.xdgDataHome, config.rolloutFile].every(absolute)
    || !config.cgroup.startsWith('/') || !/^[0-9a-f-]{36}$/iu.test(sessionId)) fail('descriptor_invalid');
  const [exe, cwd, stat, cgroup, env, cmd, source, sourceStat] = await Promise.all([
    readlink(`/proc/${config.pid}/exe`), readlink(`/proc/${config.pid}/cwd`),
    readFile(`/proc/${config.pid}/stat`, 'utf8'), readFile(`/proc/${config.pid}/cgroup`, 'utf8'),
    readFile(`/proc/${config.pid}/environ`), readFile(`/proc/${config.pid}/cmdline`),
    realpath(config.rolloutFile), lstat(config.rolloutFile),
  ]).catch(() => fail('process_unavailable'));
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
  const environment = env.toString('utf8').split('\0');
  const argv = cmd.toString('utf8').split('\0').filter(Boolean);
  if (exe !== config.executable || cwd !== config.workdir || fields[0] === 'Z'
    || fields[19] !== config.startTicks
    || !cgroup.split('\n').includes(`0::${config.cgroup}`)
    || !environment.includes(`CODEX_HOME=${config.codexHome}`)
    || !environment.includes(`XDG_STATE_HOME=${config.xdgStateHome}`)
    || !environment.includes(`XDG_DATA_HOME=${config.xdgDataHome}`)
    || !argv.some((arg, index) => arg === '-m' && argv[index + 1] === 'gpt-6-sol')
    || source !== config.rolloutFile || !source.startsWith(path.join(config.codexHome, 'sessions') + path.sep)
    || !privateFile(sourceStat, 4 * 1024 * 1024)) fail('identity_mismatch');
  const raw = await readFile(config.rolloutFile, 'utf8');
  let meta = false;
  let latest: ObjectRow | null = null;
  for (const item of rows(raw)) {
    if (!object(item.payload)) continue;
    if (item.type === 'session_meta') {
      if (item.payload.id !== sessionId || item.payload.cwd !== config.workdir
        || item.payload.cli_version !== '0.157.1') fail('session_mismatch');
      meta = true;
    }
    if (item.type === 'turn_context') latest = item.payload;
  }
  if (!meta || latest?.model !== 'gpt-6-sol' || latest.cwd !== config.workdir) fail('model_mismatch');
  return { offset: raw.lastIndexOf('\n') + 1, sessionId, startTicks: config.startTicks,
    rolloutDevice: sourceStat.dev, rolloutInode: sourceStat.ino };
}

/** Source-only parser. A must be truly pending in the caller before this can count. */
export function inspectSelectedOnlyInterval(input: Readonly<{
  records: readonly Row[]; withheld: string; released: string; launcher: string;
}>): Readonly<{ visible: boolean; relayed: boolean; withheldAbsent: boolean; ackDigest: string | null }> {
  let visible = false;
  let relayed = false;
  let withheldAbsent = true;
  let ackDigest: string | null = null;
  let token: string | null = null;
  const calls = new Map<string, string>();
  for (const row of input.records) {
    const payload = row.payload;
    if (!object(payload)) continue;
    if (JSON.stringify(payload).includes(input.withheld)) withheldAbsent = false;
    if (row.type === 'response_item' && payload.type === 'message') {
      const content = JSON.stringify(payload.content ?? payload.message ?? '');
      if ((payload.role === 'developer' || payload.role === 'user') && content.includes(input.released)) {
        visible = true;
        const found = /batchToken:\s*([A-Za-z0-9_-]{8,512})/u.exec(content);
        if (found) token = found[1]!;
      }
      if (payload.role === 'assistant' && content.includes(input.released)) relayed = true;
    }
    if (row.type !== 'response_item') continue;
    if (payload.type === 'custom_tool_call' && payload.name === 'exec'
      && typeof payload.input === 'string' && payload.input.includes(input.launcher)
      && typeof payload.call_id === 'string') {
      const matched = /\bread\s+--ack\s+([A-Za-z0-9_-]{8,512})\b/u.exec(payload.input);
      if (matched && token !== null && matched[1] === token) calls.set(payload.call_id, token);
    }
    if (payload.type === 'custom_tool_call_output' && typeof payload.call_id === 'string'
      && typeof payload.output === 'string') {
      const called = calls.get(payload.call_id);
      if (called && /Process exited with code 0/u.test(payload.output)
        && payload.output.includes('"ok":true')) ackDigest = digest(called);
    }
  }
  return { visible, relayed, withheldAbsent, ackDigest };
}

/** An actual pending neighbor must never appear among durable CLI releases. */
export function inspectInboxSelection(inbox: readonly ObjectRow[], input: Readonly<{
  bindingId: string; generation: number; releaseId: string; releasedEventId: string;
  withheldEventId: string; released: string;
}>): boolean {
  if (inbox.some(item => Array.isArray(item.events) && item.events.some(event => object(event)
    && event.eventId === input.withheldEventId))) return false;
  const releases = inbox.filter(item => item.releaseId === input.releaseId);
  if (releases.length !== 1) return false;
  const release = releases[0]!;
  if (!Array.isArray(release.events) || release.events.length !== 1 || !object(release.events[0])
    || release.events[0].eventId !== input.releasedEventId
    || release.bindingId !== input.bindingId || release.generation !== input.generation
    || typeof release.payloadBase64 !== 'string') return false;
  const payload = Buffer.from(release.payloadBase64, 'base64');
  return release.payloadDigest === `sha256:${createHash('sha256').update(payload).digest('hex')}`
    && payload.toString('utf8').includes(input.released);
}

export async function nativeSelectedOnlyProof(config: NativeReviewConfig, baseline: NativeReviewBaseline,
  input: Readonly<{ withheld: string; released: string; withheldEventId: string; releasedEventId: string;
    bindingId: string; generation: number; releaseId: string }>) {
  const current = await nativeReviewBaseline(config, baseline.sessionId);
  if (current.startTicks !== baseline.startTicks || current.rolloutDevice !== baseline.rolloutDevice
    || current.rolloutInode !== baseline.rolloutInode || current.offset < baseline.offset) fail('session_replaced');
  const raw = await readFile(config.rolloutFile, 'utf8');
  const interval = rows(raw.slice(baseline.offset));
  const launcher = path.join(config.xdgDataHome, 'khala', 'bin', 'khala');
  const observed = inspectSelectedOnlyInterval({ records: interval, withheld: input.withheld,
    released: input.released, launcher });
  const bindingDirectory = digest(JSON.stringify([input.bindingId, input.generation]));
  // The CLI hashes this tuple using base64url, not hex.
  const encoded = Buffer.from(bindingDirectory, 'hex').toString('base64url');
  const bindingPath = path.join(config.xdgStateHome, 'khala', 'bindings', encoded);
  const cursorPath = path.join(bindingPath, 'cursor.json');
  const inboxPath = path.join(bindingPath, 'inbox.jsonl');
  const inboxStat = await lstat(inboxPath).catch(() => fail('inbox_missing'));
  if (!privateFile(inboxStat, 16 * 1024 * 1024)) fail('inbox_unsafe');
  const inbox = rows(await readFile(inboxPath, 'utf8'));
  if (!inspectInboxSelection(inbox, input)) fail('release_or_withheld_mismatch');
  const cursorStat = await lstat(cursorPath).catch(() => fail('cursor_missing'));
  if (!privateFile(cursorStat, 64 * 1024)) fail('cursor_unsafe');
  let cursor: unknown;
  try { cursor = JSON.parse(await readFile(cursorPath, 'utf8')); } catch { fail('cursor_invalid'); }
  if (!object(cursor) || cursor.v !== 1 || cursor.releaseId !== input.releaseId || !observed.visible
    || !observed.relayed || !observed.withheldAbsent || observed.ackDigest === null) fail('selected_only_unproven');
  return { modelVisible: true, modelRelayed: true, withheldAbsent: true, nativeAck: true,
    cursorReleaseId: input.releaseId } as const;
}

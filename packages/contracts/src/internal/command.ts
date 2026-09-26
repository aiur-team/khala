// The seam between the agent CLI and the lazily loaded internal runtime. The
// CLI parses `khala internal ...` into one closed command and hands it to the
// runtime module; the runtime owns every side effect. The runtime ships as a
// separate bundle, so it revalidates the command instead of trusting the type.

export type InternalExportFormat = 'markdown' | 'jsonl';

export type InternalCommand =
  | Readonly<{ kind: 'create' }>
  | Readonly<{ kind: 'resume'; channelId: string }>
  | Readonly<{ kind: 'export'; channelId: string; format: InternalExportFormat; output: string; replace: boolean }>
  | Readonly<{ kind: 'delete'; channelId: string; confirmed: boolean }>
  /** Issues (or rotates) a discovery-only descriptor for the caller's own running harness session. */
  | Readonly<{
    kind: 'discovery';
    harness: string;
    sessionId: string;
    displayLabel: string | null;
    workspaceLabel: string | null;
  }>;

/** Line-oriented output sink; the runtime never receives the raw process streams. */
export type InternalOutput = Readonly<{ write(text: string): Promise<void> }>;

export type InternalCommandIo = Readonly<{
  stdout: InternalOutput;
  stderr: InternalOutput;
  /** Aborted by SIGINT/SIGTERM; a running launcher shuts down when it fires. */
  signal: AbortSignal;
  env: Readonly<Record<string, string | undefined>>;
  /** Absolute working directory used to resolve a relative export path. */
  cwd: string;
}>;

/** Exit status: 0 success, 3 refused or failed outcome. */
export type InternalRuntime = Readonly<{
  runInternalCommand(command: InternalCommand, io: InternalCommandIo): Promise<number>;
}>;

/**
 * Channel IDs accepted on the command line are exact local route segments that
 * cannot be mistaken for an option (created IDs always start with `ch_`).
 */
const CHANNEL_ARGUMENT = /^[A-Za-z0-9._~][A-Za-z0-9._~-]{0,255}$/;

export function isInternalChannelArgument(value: unknown): value is string {
  return typeof value === 'string' && CHANNEL_ARGUMENT.test(value) && value !== '.' && value !== '..';
}

const HARNESS_ARGUMENT = /^[a-z][a-z0-9-]{0,31}$/;
const SESSION_ARGUMENT = /^[\x21-\x7e]{1,256}$/;
const LABEL_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/** A harness name such as `codex`, `claude` or `opencode`. */
export function isInternalHarnessArgument(value: unknown): value is string {
  return typeof value === 'string' && HARNESS_ARGUMENT.test(value);
}

/** The harness's own session ID: printable ASCII without spaces, at most 256 bytes. */
export function isInternalSessionArgument(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ARGUMENT.test(value);
}

/** Untrusted display context: one nonempty line of at most 128 UTF-16 units. */
export function isInternalLabelArgument(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value
    && !LABEL_CONTROL.test(value) && !/\p{Cs}/u.test(value);
}

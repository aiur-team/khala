// The seam between the agent CLI and the lazily loaded internal runtime. The
// CLI parses `khala internal ...` into one closed command and hands it to the
// runtime module; the runtime owns every side effect. The runtime ships as a
// separate bundle, so it revalidates the command instead of trusting the type.

export type InternalExportFormat = 'markdown' | 'jsonl';

export type InternalCommand =
  | Readonly<{ kind: 'create' }>
  | Readonly<{ kind: 'resume'; channelId: string }>
  | Readonly<{ kind: 'export'; channelId: string; format: InternalExportFormat; output: string; replace: boolean }>
  | Readonly<{ kind: 'delete'; channelId: string; confirmed: boolean }>;

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

/** Channel IDs accepted on the command line are exact local route segments. */
const CHANNEL_ARGUMENT = /^[A-Za-z0-9._~-]{1,256}$/;

export function isInternalChannelArgument(value: unknown): value is string {
  return typeof value === 'string' && CHANNEL_ARGUMENT.test(value) && value !== '.' && value !== '..';
}

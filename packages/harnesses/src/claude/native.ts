// Read-only native facts the composition root supplies (KHA-133). The port can
// report what is installed and whether the bound session exists; it has no way to
// start, resume, restart or message Claude.

/** `not_owned`: the session exists but not under the owner this connector runs as. */
export type ClaudeSessionState = 'present' | 'absent' | 'not_owned';

export interface ClaudeNativeProbe {
  /** The installed Claude Code version as the native binary reports it, or null. */
  installedVersion(): Promise<string | null>;
  /** Looks up the bound session without resuming it or reading its transcript. */
  session(sessionId: string): Promise<ClaudeSessionState>;
}

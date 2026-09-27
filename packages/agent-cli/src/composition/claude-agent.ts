import { validIdentifier } from '../cli/validation.js';
import type { AccessRequestInput, AccessStatusInput, ChannelListInput } from '../cli/channels/types.js';
import type { CreateRequestInput } from '../cli/channels/create/types.js';
import type { ClaudeModeSetRequest, ClaudeSessionClient } from './claude-session-http.js';

/** The environment variable Claude sets in the MCP server it launches for a session. */
export const CLAUDE_SESSION_ENV = 'CLAUDE_CODE_SESSION_ID';

type AgentCalls = Pick<ClaudeSessionClient,
  'read' | 'send' | 'status' | 'mode' | 'setMode' | 'roster' | 'listChannels' | 'requestAccess' | 'accessStatus' | 'requestCreate'>;
type Outcome<K extends keyof AgentCalls> = Awaited<ReturnType<AgentCalls[K]>>;
type SessionMissing = Readonly<{ kind: 'refused'; code: 'session_missing' }>;

/**
 * The agent-initiated Khala calls the MCP server and dispatcher carry: `khala_read`,
 * `khala_send`, `khala_status`, and the mode calls. Each one acknowledges every
 * batch token hooks retained for this session. There is deliberately no pull here;
 * only hooks pull, and a hook pull never acknowledges.
 */
export interface ClaudeAgentEntry {
  read(signal?: AbortSignal): Promise<Outcome<'read'> | SessionMissing>;
  send(body: string, signal?: AbortSignal): Promise<Outcome<'send'> | SessionMissing>;
  status(signal?: AbortSignal): Promise<Outcome<'status'> | SessionMissing>;
  mode(signal?: AbortSignal): Promise<Outcome<'mode'> | SessionMissing>;
  setMode(input: ClaudeModeSetRequest, signal?: AbortSignal): Promise<Outcome<'setMode'> | SessionMissing>;
  roster(signal?: AbortSignal): Promise<Outcome<'roster'> | SessionMissing>;
  /** The requesting session, or `null` when `CLAUDE_CODE_SESSION_ID` is missing or invalid. */
  readonly session: string | null;
  listChannels(input: ChannelListInput, signal?: AbortSignal): Promise<Outcome<'listChannels'> | SessionMissing>;
  requestAccess(input: AccessRequestInput, signal?: AbortSignal): Promise<Outcome<'requestAccess'> | SessionMissing>;
  accessStatus(input: AccessStatusInput, signal?: AbortSignal): Promise<Outcome<'accessStatus'> | SessionMissing>;
  requestCreate(input: CreateRequestInput, signal?: AbortSignal): Promise<Outcome<'requestCreate'> | SessionMissing>;
}

/**
 * Binds the agent calls to the MCP server's own `CLAUDE_CODE_SESSION_ID`, which the
 * Claude proof showed equals the hook `session_id`. The caller never names a
 * session, so a tool call cannot select another session's binding. A missing or
 * malformed ID fails closed before any call.
 */
export function createClaudeAgentEntry(
  client: AgentCalls,
  env: Readonly<Record<string, string | undefined>>,
): ClaudeAgentEntry {
  const sessionId = env[CLAUDE_SESSION_ENV];
  const missing: SessionMissing = { kind: 'refused', code: 'session_missing' };
  if (!validIdentifier(sessionId)) {
    const refuse = async () => missing;
    return {
      session: null, read: refuse, send: refuse, status: refuse, mode: refuse, setMode: refuse, roster: refuse,
      listChannels: refuse, requestAccess: refuse, accessStatus: refuse, requestCreate: refuse,
    };
  }
  return {
    session: sessionId,
    listChannels: (input, signal) => client.listChannels(sessionId, input, signal),
    requestAccess: (input, signal) => client.requestAccess(sessionId, input, signal),
    accessStatus: (input, signal) => client.accessStatus(sessionId, input, signal),
    requestCreate: (input, signal) => client.requestCreate(sessionId, input, signal),
    read: signal => client.read(sessionId, signal),
    send: (body, signal) => client.send(sessionId, body, signal),
    status: signal => client.status(sessionId, signal),
    mode: signal => client.mode(sessionId, signal),
    setMode: (input, signal) => client.setMode(sessionId, input, signal),
    roster: signal => client.roster(sessionId, signal),
  };
}

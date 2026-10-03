import type { AgentCredentials } from '@khala/contracts/m1/agent-join';
import { KhalaClientError } from '../client';
import type { ChannelSession } from '../transport';
export type LocalSessionOptions = { fetch?: typeof fetch; ensureHelper?: () => Promise<void>; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; log?: (line: string) => void };
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- KI-121 replaces this pinned placeholder.
export async function createLocalSession(_creds: AgentCredentials, _opts?: LocalSessionOptions): Promise<ChannelSession> {
  throw new KhalaClientError('internal_error', 'local_transport_unavailable');
}

// The Stop control's port and the local server's reply shape. Stop revokes the
// channel's agent bindings and ends Khala delivery to them; it never closes an
// agent CLI, the local server or this page.

export type StoppedBinding = Readonly<{
  bindingId: string;
  generation: number;
  harness: string;
  agentParticipantId: string;
}>;

export type RemainingBinding = StoppedBinding & Readonly<{ reason: 'revoke_failed' | 'descriptor_pending' }>;

export type StopFailure = 'unavailable' | 'session_ended' | 'forbidden' | 'rejected';

export type StopOutcome =
  | Readonly<{ kind: 'stopped'; stopped: readonly StoppedBinding[] }>
  | Readonly<{ kind: 'partial'; stopped: readonly StoppedBinding[]; remaining: readonly RemainingBinding[] }>
  | Readonly<{ kind: 'failed'; reason: StopFailure }>;

export type BindingStopPort = Readonly<{
  /** Stops every active binding of the channel. Never throws. */
  stop(channelId: string): Promise<StopOutcome>;
}>;

const MAX_LISTED = 64;
const MAX_TEXT = 512;

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT && !/[\p{Cc}]/u.test(value);
}

function decodeBinding(value: unknown): StoppedBinding | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!text(record.bindingId) || !text(record.harness) || !text(record.agentParticipantId)
    || !Number.isSafeInteger(record.generation) || (record.generation as number) < 0) return null;
  return {
    bindingId: record.bindingId, generation: record.generation as number, harness: record.harness,
    agentParticipantId: record.agentParticipantId,
  };
}

function decodeList<T>(value: unknown, decode: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > MAX_LISTED) return null;
  const decoded = value.map(decode);
  return decoded.every(entry => entry !== null) ? decoded as T[] : null;
}

/** Strict: anything but the exact reply shape is treated as an unknown outcome, never success. */
export function decodeStopReply(value: unknown): StopOutcome | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  const stopped = decodeList(record.stopped, decodeBinding);
  const remaining = decodeList(record.remaining, (entry): RemainingBinding | null => {
    const binding = decodeBinding(entry);
    const reason = (entry as { reason?: unknown } | null)?.reason;
    return binding && (reason === 'revoke_failed' || reason === 'descriptor_pending') ? { ...binding, reason } : null;
  });
  if (stopped === null || remaining === null) return null;
  if (record.outcome === 'stopped' && remaining.length === 0) return { kind: 'stopped', stopped };
  if (record.outcome === 'partial' && remaining.length > 0) return { kind: 'partial', stopped, remaining };
  return null;
}

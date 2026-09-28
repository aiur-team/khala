import { createHash } from 'node:crypto';

type Record = Readonly<{ type?: unknown; payload?: unknown }>;
type Payload = { type?: unknown; role?: unknown; name?: unknown; input?: unknown;
  content?: unknown; message?: unknown };

export type NativeRolloutProof = Readonly<{
  visibleRelease: boolean;
  agentRelay: boolean;
  unsubmittedAbsent: boolean;
  modelAckDigests: ReadonlySet<string>;
}>;

/** 0.157.1 records model-originated tool calls as custom_tool_call, not function_call. */
export function inspectNativeSolRollout(
  records: readonly Record[], releasedMarker: string, unsubmittedMarker: string, launcher: string,
): NativeRolloutProof {
  let visibleRelease = false;
  let agentRelay = false;
  let unsubmittedAbsent = true;
  const modelAckDigests = new Set<string>();
  for (const record of records) {
    const payload = record.payload as Payload | null;
    if (!payload || typeof payload !== 'object') continue;
    const content = JSON.stringify(payload.content ?? payload.message ?? '');
    if (content.includes(unsubmittedMarker)) unsubmittedAbsent = false;
    if (record.type === 'response_item' && payload.type === 'message') {
      if ((payload.role === 'developer' || payload.role === 'user') && content.includes(releasedMarker)) {
        visibleRelease = true;
      }
      if (payload.role === 'assistant' && content.includes(releasedMarker)) agentRelay = true;
    }
    if (record.type !== 'response_item' || payload.type !== 'custom_tool_call' || payload.name !== 'exec'
      || typeof payload.input !== 'string' || !payload.input.includes(launcher)) continue;
    for (const match of payload.input.matchAll(/\bread\s+--ack\s+([A-Za-z0-9_-]{8,512})\b/gu)) {
      modelAckDigests.add(createHash('sha256').update(match[1]!).digest('hex'));
    }
  }
  return { visibleRelease, agentRelay, unsubmittedAbsent, modelAckDigests };
}

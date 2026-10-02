import { encodeChannelEvent, type ChannelEventContent } from '@khala/contracts/m1/channel-event';
import { mapAiurEvent } from '@khala/contracts/m1/from-aiur';
import { plainObject } from '../mcp/tool';

export type EventResolution =
  | { kind: 'send'; content: ChannelEventContent }
  | { kind: 'skipped' }
  | { kind: 'invalid'; path: string; code: string };

export function resolveEventInput(args: unknown): EventResolution {
  const invalid = (path: string): EventResolution => ({ kind: 'invalid', path, code: 'invalid_value' });
  if (!plainObject(args)) return invalid('');
  for (const key of Object.keys(args)) {
    if (!['event', 'aiur', 'ticketPrefix'].includes(key)) return invalid(key);
  }
  if (Object.hasOwn(args, 'ticketPrefix')
    && (typeof args.ticketPrefix !== 'string' || [...args.ticketPrefix].length > 16)) return invalid('ticketPrefix');
  const event = Object.hasOwn(args, 'event');
  const aiur = Object.hasOwn(args, 'aiur');
  if (event === aiur) return invalid('');
  const key = event ? 'event' : 'aiur';
  if (!plainObject(args[key])) return invalid(key);
  if (event) {
    const encoded = encodeChannelEvent(args.event);
    return encoded.ok ? { kind: 'send', content: encoded.value } : { kind: 'invalid', ...encoded.error };
  }
  const prefix = args.ticketPrefix as string | undefined;
  const content = mapAiurEvent(args.aiur, prefix ? { ticketLabel: id => prefix + id } : {});
  return content === null ? { kind: 'skipped' } : { kind: 'send', content };
}

// Route codec for the local entry. It accepts only the exact loopback origin
// the page was served from, the private create route (`/`), channel routes,
// each channel's discovery settings, and the owner's channel-requests inbox.
// Join, share and recovery have no route here, so they can only be not-found.

import { decodeRoomId, type ChannelAccessRequestHandle, type RoomId } from '@khala/contracts/messaging/index';
import { isLoopbackOrigin } from '@khala/messaging/local/http/index';

export type LocalRoute =
  | Readonly<{ kind: 'create'; path: string }>
  | Readonly<{ kind: 'channel'; path: string; roomId: RoomId }>
  | Readonly<{ kind: 'channel_settings'; path: string; roomId: RoomId }>
  | Readonly<{ kind: 'channel_requests'; path: string; selectedHandle: ChannelAccessRequestHandle | null }>
  | Readonly<{ kind: 'not_found'; path: string }>;

export interface LocalRouteCodec {
  parse(location: string): LocalRoute;
  createPath(): string;
  roomPath(roomId: string): string;
  settingsPath(roomId: string): string;
  channelRequestsPath(requestHandle?: ChannelAccessRequestHandle | null): string;
}

const CHANNELS = '/channels/';
const SETTINGS_SUFFIX = '/settings';
const REQUESTS = '/channel-requests';
const REQUEST_HANDLE = /^careq_[A-Za-z0-9_-]{43}$/;

export function createLocalRouteCodec(origin: string): LocalRouteCodec {
  if (!isLoopbackOrigin(origin)) throw new Error('local route origin must be http://127.0.0.1:<port>');

  function roomPath(roomId: string): string {
    const decoded = decodeRoomId(roomId);
    if (!decoded.ok) throw new Error('invalid channel identifier');
    return `${CHANNELS}${encodeURIComponent(decoded.value)}`;
  }

  const settingsPath = (roomId: string): string => `${roomPath(roomId)}${SETTINGS_SUFFIX}`;

  function channelRequestsPath(requestHandle?: ChannelAccessRequestHandle | null): string {
    if (requestHandle == null) return REQUESTS;
    if (!REQUEST_HANDLE.test(requestHandle)) throw new Error('invalid channel request handle');
    return `${REQUESTS}/${encodeURIComponent(requestHandle)}`;
  }

  function parse(location: string): LocalRoute {
    let parsed: URL;
    try {
      parsed = new URL(location, origin);
    } catch {
      return { kind: 'not_found', path: location };
    }
    const path = `${parsed.pathname}${parsed.search}`;
    if (parsed.origin !== origin || parsed.username || parsed.password || parsed.search) return { kind: 'not_found', path };
    if (parsed.pathname === '/') return { kind: 'create', path: '/' };
    if (parsed.pathname === REQUESTS) return { kind: 'channel_requests', path: REQUESTS, selectedHandle: null };
    if (parsed.pathname.startsWith(`${REQUESTS}/`)) {
      let handle: string;
      try {
        handle = decodeURIComponent(parsed.pathname.slice(REQUESTS.length + 1));
      } catch {
        return { kind: 'not_found', path };
      }
      if (!REQUEST_HANDLE.test(handle)) return { kind: 'not_found', path };
      const selectedHandle = handle as ChannelAccessRequestHandle;
      return { kind: 'channel_requests', path: channelRequestsPath(selectedHandle), selectedHandle };
    }
    if (!parsed.pathname.startsWith(CHANNELS)) return { kind: 'not_found', path };
    let encoded = parsed.pathname.slice(CHANNELS.length);
    const settings = encoded.endsWith(SETTINGS_SUFFIX);
    if (settings) encoded = encoded.slice(0, -SETTINGS_SUFFIX.length);
    if (!encoded || encoded.includes('/')) return { kind: 'not_found', path };
    let raw: string;
    try {
      raw = decodeURIComponent(encoded);
    } catch {
      return { kind: 'not_found', path };
    }
    const decoded = decodeRoomId(raw);
    if (!decoded.ok) return { kind: 'not_found', path };
    return settings
      ? { kind: 'channel_settings', path: settingsPath(decoded.value), roomId: decoded.value }
      : { kind: 'channel', path: roomPath(decoded.value), roomId: decoded.value };
  }

  return { parse, createPath: () => '/', roomPath, settingsPath, channelRequestsPath };
}

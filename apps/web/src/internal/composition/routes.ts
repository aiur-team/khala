// Route codec for the local entry. It accepts only the exact loopback origin
// the page was served from, the private create route (`/`) and channel routes.
// Join, share and recovery have no route here, so they can only be not-found.

import { decodeRoomId, type RoomId } from '@khala/contracts/messaging/index';
import { isLoopbackOrigin } from '@khala/messaging/local/http/index';

export type LocalRoute =
  | Readonly<{ kind: 'create'; path: string }>
  | Readonly<{ kind: 'channel'; path: string; roomId: RoomId }>
  | Readonly<{ kind: 'not_found'; path: string }>;

export interface LocalRouteCodec {
  parse(location: string): LocalRoute;
  createPath(): string;
  roomPath(roomId: string): string;
}

const CHANNELS = '/channels/';

export function createLocalRouteCodec(origin: string): LocalRouteCodec {
  if (!isLoopbackOrigin(origin)) throw new Error('local route origin must be http://127.0.0.1:<port>');

  function roomPath(roomId: string): string {
    const decoded = decodeRoomId(roomId);
    if (!decoded.ok) throw new Error('invalid channel identifier');
    return `${CHANNELS}${encodeURIComponent(decoded.value)}`;
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
    if (!parsed.pathname.startsWith(CHANNELS)) return { kind: 'not_found', path };
    const encoded = parsed.pathname.slice(CHANNELS.length);
    if (!encoded || encoded.includes('/')) return { kind: 'not_found', path };
    let raw: string;
    try {
      raw = decodeURIComponent(encoded);
    } catch {
      return { kind: 'not_found', path };
    }
    const decoded = decodeRoomId(raw);
    return decoded.ok ? { kind: 'channel', path: roomPath(decoded.value), roomId: decoded.value } : { kind: 'not_found', path };
  }

  return { parse, createPath: () => '/', roomPath };
}

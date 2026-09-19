import { decodeRoomId, type RoomId } from '@khala/contracts/messaging/index';
import { parseJoinLocation, type JoinLocationError, type RouteCodec } from '../../features/join/location';

export type HumanRoute =
  | Readonly<{ kind: 'create'; path: string }>
  | Readonly<{ kind: 'join'; path: string; inviteRef: string }>
  | Readonly<{ kind: 'room'; path: string; roomId: RoomId }>
  | Readonly<{ kind: 'not_found'; path: string }>;

export interface HumanRouteCodec extends RouteCodec {
  parse(location: string): HumanRoute;
  createPath(): string;
  joinPath(inviteRef: string): string;
  roomPath(roomId: string): string;
}

export type HumanRouteCodecOptions = Readonly<{
  origin: string;
  basePath: string;
}>;

function exactHttpsOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('human route origin must be an exact https origin');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.origin !== value || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(parsed.protocol !== 'https:' ? 'human route origin must be an https origin' : 'human route origin must be an exact origin');
  }
  return parsed.origin;
}

function normalizedBasePath(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('?') || value.includes('#') || value.includes('\\')) {
    throw new Error('human route base path must be a same-origin absolute path');
  }
  const segments = value.split('/');
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error('human route base path must not contain traversal');
  }
  return value === '/' ? '' : value.replace(/\/+$/, '');
}

export function createHumanRouteCodec(options: HumanRouteCodecOptions): HumanRouteCodec {
  const origin = exactHttpsOrigin(options.origin);
  const base = normalizedBasePath(options.basePath);
  const createPath = () => `${base}/`;
  const joinRoot = `${base}/join`;
  const roomsRoot = `${base}/rooms/`;
  const notFound = (path: string): HumanRoute => ({ kind: 'not_found', path });

  function joinPath(inviteRef: string): string {
    const candidate = `${joinRoot}?invite=${encodeURIComponent(inviteRef)}`;
    const decoded = parseJoinLocation(candidate);
    if ('error' in decoded || decoded.inviteRef !== inviteRef) throw new Error('invalid invite reference');
    return candidate;
  }

  function roomPath(roomId: string): string {
    const decoded = decodeRoomId(roomId);
    if (!decoded.ok) throw new Error('invalid room identifier');
    return `${roomsRoot}${encodeURIComponent(decoded.value)}`;
  }

  function parse(location: string): HumanRoute {
    let parsed: URL;
    try {
      parsed = new URL(location, origin);
    } catch {
      return notFound(location);
    }
    const requestedPath = `${parsed.pathname}${parsed.search}`;
    if (parsed.origin !== origin || parsed.username || parsed.password) return notFound(requestedPath);
    if (parsed.pathname === createPath() && parsed.search === '') return { kind: 'create', path: createPath() };
    if (parsed.pathname === joinRoot) {
      const decoded = parseJoinLocation(parsed.href);
      if ('error' in decoded) return notFound(requestedPath);
      try {
        return { kind: 'join', path: joinPath(decoded.inviteRef), inviteRef: decoded.inviteRef };
      } catch {
        return notFound(requestedPath);
      }
    }
    if (parsed.pathname.startsWith(roomsRoot) && !parsed.search) {
      const encoded = parsed.pathname.slice(roomsRoot.length);
      if (!encoded || encoded.includes('/')) return notFound(requestedPath);
      let raw: string;
      try {
        raw = decodeURIComponent(encoded);
      } catch {
        return notFound(requestedPath);
      }
      const decoded = decodeRoomId(raw);
      if (!decoded.ok) return notFound(requestedPath);
      return { kind: 'room', path: roomPath(decoded.value), roomId: decoded.value };
    }
    return notFound(requestedPath);
  }

  return {
    parse,
    createPath,
    joinPath,
    roomPath,
    parseJoinLocation(location: string): ReturnType<RouteCodec['parseJoinLocation']> {
      const route = parse(location);
      return route.kind === 'join' ? { inviteRef: route.inviteRef } : ({ error: 'invalid_location' } satisfies JoinLocationError);
    },
  };
}

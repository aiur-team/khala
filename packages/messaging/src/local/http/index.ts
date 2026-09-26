// Browser-safe local transport: the `ChannelSubstrate` for the internal-mode
// loopback server. No Node module or server code is reachable from here.

export {
  createHttpRoomSubstrate, isLoopbackOrigin, DEFAULT_RECONNECT_DELAYS_MS,
  type HttpRoomSubstrate, type HttpRoomSubstrateOptions, type LocalTransport, type LocalTransportState, type SessionRead,
} from './substrate';
export { API, REQUEST_SECRET_HEADER, REQUEST_SECRET_STORAGE_KEY, type LocalHuman } from './protocol';

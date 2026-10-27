import type { RoomId } from '@khala/contracts/messaging/ids';

/** Hosted Matrix `m.typing`: who else is typing in a room, and the viewer's own state. Web only; agents never receive it. */
export type TypingPort = Readonly<{
  subscribe(roomId: RoomId, onNames: (names: readonly string[]) => void): () => void;
  set(roomId: RoomId, typing: boolean): void;
}>;

/** Hosted Matrix media repo. Bytes are ciphertext both ways: callers encrypt before upload and decrypt after download. */
export type MediaPort = Readonly<{
  upload(ciphertext: Uint8Array): Promise<string>;
  download(mxc: string): Promise<Uint8Array>;
}>;

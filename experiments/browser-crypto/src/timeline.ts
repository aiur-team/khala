export interface TimelineEntry { eventId?: string; transactionId?: string; body?: string; undecryptable?: boolean }
/** UI projection; the SDK owns encryption, sync and server event validation. */
export class TimelineProjection {
  private entries: TimelineEntry[] = [];
  private disposed = false;
  constructor(private publish: (entries: readonly TimelineEntry[]) => void) {}
  accept(entry: TimelineEntry) {
    if (this.disposed) return;
    const index = this.entries.findIndex(old => (entry.eventId && old.eventId === entry.eventId) || (entry.transactionId && old.transactionId === entry.transactionId));
    if (index < 0) this.entries.push({ ...entry }); else this.entries[index] = { ...this.entries[index], ...entry };
    this.publish(this.entries.map(item => ({...item})));
  }
  dispose() { this.disposed = true; this.entries = []; }
}

export function observeTimeline(client: MatrixClient, roomId: string, publish: (entries: readonly TimelineEntry[]) => void) {
  const projection = new TimelineProjection(publish);
  const decryptedListeners = new Map<MatrixEvent, () => void>();
  const update = (event: MatrixEvent) => projection.accept({eventId:event.getId(),transactionId:event.getTxnId(),body:event.getContent().body,undecryptable:event.isDecryptionFailure()});
  const accept = (event: MatrixEvent, room?: Room) => {
    if (room?.roomId !== roomId) return;
    if(!decryptedListeners.has(event)) {
      const decrypted = () => update(event);
      decryptedListeners.set(event,decrypted);
      event.on(MatrixEventEvent.Decrypted,decrypted);
    }
    update(event);
  };
  client.on(RoomEvent.Timeline, accept);
  client.on(RoomEvent.LocalEchoUpdated, accept);
  return {
    async paginate() { const room=client.getRoom(roomId); if(!room)throw new Error('room unavailable');await client.scrollback(room,20);return room.getLiveTimeline().getEvents().length; },
    dispose(){
      client.removeListener(RoomEvent.Timeline,accept);
      client.removeListener(RoomEvent.LocalEchoUpdated,accept);
      for(const [event,listener] of decryptedListeners)event.removeListener(MatrixEventEvent.Decrypted,listener);
      decryptedListeners.clear();projection.dispose();
    },
  };
}
import { RoomEvent, MatrixEventEvent, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';

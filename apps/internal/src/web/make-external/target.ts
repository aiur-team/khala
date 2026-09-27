import type { RoomId } from '@khala/contracts/messaging/index';
import type { ConversionTarget } from '../../externalization/history-export';
import type { ConversionJournal } from '../../externalization/journal';

/**
 * The history transfer's destination binding, read from the conversion journal: the
 * confirmed source channel, the destination the conversion itself created and the owner
 * who started it. Never taken from caller input, so no request can point a transfer
 * at another channel.
 */
export function conversionTarget(journal: ConversionJournal): (conversionId: string) => Promise<ConversionTarget | null> {
  return async conversionId => {
    const found = await journal.entry(conversionId);
    if (found.kind !== 'ok' || found.value.destination === null) return null;
    const { snapshot, destination } = found.value;
    return {
      sourceChannelId: snapshot.sourceChannelId,
      destinationRoomId: destination.destinationChannelId as RoomId,
      owner: snapshot.owner,
    };
  };
}

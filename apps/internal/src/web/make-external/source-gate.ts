import type { SourceWriteGate } from '../../externalization/history-export';
import { type ChannelConversionLock, channelConversionKey, readChannelConversionLock } from '../../store/conversion-lock';
import type { InternalStoreHandle } from '../../store/open';

// The history drain's write pause, kept in the same conversion lock the journal
// moves: `paused` stops internal writes, `open` resumes them. A linked channel never
// reopens, and a channel whose conversion has ended has no lock to pause.

export function createSourceWriteGate(handle: InternalStoreHandle): SourceWriteGate {
  function set(channelId: string, write: 'open' | 'paused'): boolean {
    return handle.transaction(db => {
      const lock = readChannelConversionLock(db, channelId);
      if (lock === null || lock.write === 'linked') return false;
      if (lock.write !== write) {
        db.prepare('UPDATE control_records SET value = ? WHERE record_key = ?')
          .run(JSON.stringify({ ...lock, write } satisfies ChannelConversionLock), channelConversionKey(channelId));
      }
      return true;
    });
  }

  const attempt = <T extends string>(body: () => boolean, done: T): Promise<T | 'unavailable'> => {
    try {
      return Promise.resolve(body() ? done : 'unavailable');
    } catch {
      return Promise.resolve('unavailable');
    }
  };

  return {
    pause: channelId => attempt(() => set(channelId, 'paused'), 'paused'),
    // Resuming a channel whose conversion ended is already true: it has no lock.
    resume: channelId => attempt(() => {
      const lock = handle.read(db => readChannelConversionLock(db, channelId));
      return lock === null || set(channelId, 'open');
    }, 'resumed'),
  };
}

import type { ImportedHistoryRead } from './model';

/**
 * Reads a channel's imported archive through the verifying projection. Implemented by
 * the hosted composition over the external channel's imported-history transport; the
 * feature never touches the live timeline or any delivery path.
 */
export interface ImportedHistoryPort {
  open(channelId: string): Promise<ImportedHistoryRead>;
}

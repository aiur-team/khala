// View types the timeline controller projects for presentation. Item data
// itself is `TimelineItem`/`EventRef`/`ParticipantView`/`SendState` from
// `@khala/contracts/messaging/index` (KHA-105); this module only adds the
// screen-local view model layered on top (KTD1/KTD2).

import type { EventId, RoomId } from '@khala/contracts/messaging/ids';

export type TimelinePhase = 'loading' | 'ready' | 'partial' | 'unavailable';

export type SendPhase = 'idle' | 'pending' | 'accepted' | 'failed' | 'outcome_unknown';

export type TimelineView = Readonly<{
  roomId: RoomId;
  phase: TimelinePhase;
  nextCursor: string | null;
  newMessageCount: number;
  draft: string;
  sendState: SendPhase;
}>;

export type ReaderAnchor = Readonly<{ eventId: EventId; offsetPx: number }> | Readonly<{ atLatest: true }>;

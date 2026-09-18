import type { RoomId } from '@khala/contracts/messaging';

/** One prepared introduction, keyed by a stable local ID so drafts survive reordering. */
export type IntroDraft = Readonly<{ localId: string; body: string }>;

export type CreateChatPhase =
  | 'editing'
  | 'creating'
  | 'preparing_intro'
  | 'resolving'
  | 'sharing'
  | 'ready'
  | 'failed';

export type CreateChatView = Readonly<{
  phase: CreateChatPhase;
  title: string;
  intros: readonly IntroDraft[];
  roomId: RoomId | null;
  shareUrl: string | null;
  errorCode: string | null;
}>;

export const INITIAL_VIEW: CreateChatView = {
  phase: 'editing',
  title: '',
  intros: [],
  roomId: null,
  shareUrl: null,
  errorCode: null,
};
